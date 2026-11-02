// Build only the dedicated isolated Microduck runner, never the identity app.
import {build} from 'esbuild';
import {readFile,writeFile,mkdir,readdir,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const appOrigin=process.env.MICRODUCK_APP_ORIGIN;
const model=process.env.MICRODUCK_POLICY;
const output=process.env.MICRODUCK_RUNNER_OUT;
let origin;
try { origin=new URL(appOrigin); } catch { throw Error('Invalid app origin'); }
if(typeof appOrigin!=='string'||appOrigin.length>256||origin.origin!==appOrigin||(origin.port && Number(origin.port)===0)||!/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)*$/.test(origin.hostname)||!(origin.protocol==='https:'||(origin.protocol==='http:'&&['127.0.0.1','localhost'].includes(origin.hostname)&&origin.port)))throw Error('Invalid app origin');
if(!model || !output) throw Error('Explicit model and output are required');
const out=resolve(output);
await mkdir(out,{recursive:true});
if((await readdir(out)).length) throw Error('Runner output must be empty');
const hash=x=>createHash('sha256').update(x).digest('hex');
const modelBytes=await readFile(model);
if(hash(modelBytes)!=='e36332d383997d51401897734cd3e79cf5038406feddb18b4d57ecfb141daa6c')throw Error('Incorrect policy');
const wasmFile=resolve(root,'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm');
if(hash(await readFile(wasmFile))!=='4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d')throw Error('Incorrect runtime');
const ortFile=resolve(root,'node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs');
const raw=await readFile(ortFile,'utf8');
if(hash(raw)!=='51bd7168175767324ab0acfcfc4ca94a096a3826e3ebac9ccc4f195eb865f8dd')throw Error('Incorrect runtime bundle');
const needle='import(/*webpackIgnore:true*/ /*@vite-ignore*/r)';
if(raw.split(needle).length!==2)throw Error('Runtime patch mismatch');
const patched=raw.replace(needle,"Promise.reject(new Error('External ONNX runtime module loading is disabled'))");
const app=resolve(root,'foundation/implementation/src/isolation');
const common={bundle:true,format:'esm',platform:'browser',target:'es2022',logLevel:'silent',legalComments:'external',metafile:true,
 define:{__BRF_APP_ORIGIN__:JSON.stringify(appOrigin)},
 plugins:[{name:'pinned-onnx-no-external-module',setup(b){b.onLoad({filter:/ort\.wasm\.bundle\.min\.mjs$/},args=>{
  if(resolve(args.path)!==ortFile)throw Error('Unexpected runtime bundle path');
  return {contents:patched,loader:'js',resolveDir:dirname(ortFile)};
 })}}]};
for(const [entry,name] of [['runner-frame.ts','frame.js'],['runner-worker.ts','runner.js']]){
 const result=await build({...common,entryPoints:[resolve(app,entry)],outfile:resolve(out,name)});
 for(const item of Object.values(result.metafile.outputs))if(item.imports.some(x=>x.external))throw Error('Unexpected external import');
}
await writeFile(resolve(out,'frame'),'<!doctype html>\n<meta charset="utf-8">\n<script type="module" src="/frame.js"></script>\n');
await writeFile(resolve(out,'microduck-policy.onnx'),modelBytes);
await copyFile(wasmFile,resolve(out,'microduck-runtime.wasm'));
const names=['frame','frame.js','runner.js','microduck-policy.onnx','microduck-runtime.wasm','runner.js.LEGAL.txt'];
const files=Object.fromEntries(await Promise.all(names.map(async name=>[name,hash(await readFile(resolve(out,name)))])));
await writeFile(resolve(out,'runner-manifest.json'),JSON.stringify({version:'microduck-runner/1',appOrigin,files},null,2)+'\n');
console.log(JSON.stringify({appOrigin,policy:hash(modelBytes),wasm:'4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d',output:out}));
