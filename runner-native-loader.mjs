import * as ort from './node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs';
import {createMicroduckRunnerLoader,MICRODUCK_SOURCE,MICRODUCK_SOURCE_PATH} from './runner-loader.mjs';

async function readAsset(fetchAsset,url,limit) {
 const response=await fetchAsset(url,{credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer'});
 if (!response.ok || response.redirected || response.url!==url || !response.body) throw Error('Runner asset unavailable');
 const length=response.headers.get('content-length');
 if (length!==null && (!/^[0-9]+$/.test(length) || Number(length)>limit)) {
  await response.body.cancel();
  throw Error('Runner asset exceeds limit');
 }
 const reader=response.body.getReader(),chunks=[];
 let total=0;
 try {
  while (true) {
   const result=await reader.read();
   if (result.done) break;
   if (!(result.value instanceof Uint8Array) || (total+=result.value.byteLength)>limit) {
    await reader.cancel();
    throw Error('Runner asset exceeds limit');
   }
   chunks.push(result.value);
  }
 } finally {reader.releaseLock()}
 const bytes=new Uint8Array(total);
 let offset=0;
 for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
 return bytes;
}

// This worker's dedicated runner rejects arbitrary controller source. Generic
// JS controllers belong in the separately isolated generic runner.
export function createOneShotNativeJsLoader(options={}) {
 const runtime=options.runtime??ort, fetchAsset=options.fetch??fetch, origin=options.origin??self.location.origin;
 const base=new URL(origin);
 if (base.origin!==origin || !['https:','http:'].includes(base.protocol)) throw Error('Invalid runner origin');
 let consumed=false;
 return async (source,sourceId,descriptor)=>{
  if(consumed)return {ok:false,code:'ALREADY_CONSUMED'};
  consumed=true;
  if(source!==MICRODUCK_SOURCE || sourceId!==MICRODUCK_SOURCE_PATH || descriptor?.control_size!==14)
   return {ok:false,code:'EVALUATION'};
  try {
   const [modelBytes,wasmBytes]=await Promise.all([
    readAsset(fetchAsset,origin+'/microduck-policy.onnx',8*1024*1024),
    readAsset(fetchAsset,origin+'/microduck-runtime.wasm',24*1024*1024)
   ]);
   const load=createMicroduckRunnerLoader({runtime,modelBytes,wasmBytes});
   return {ok:true,controller:await load(source,sourceId,descriptor)};
  } catch {return {ok:false,code:'EVALUATION'}}
 };
}
