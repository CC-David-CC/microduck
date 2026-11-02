import {copyBounded} from './project-world-wire.ts';

/** Bounded decoder for one already-authorized visual mesh transfer. */
export function createVisualMeshReceiver(authority:unknown, manifest:unknown, replyLimit:number) {
  const keys=(v:any,names:string[])=>!!v && typeof v==='object' && !Array.isArray(v) &&
    (Object.getPrototypeOf(v)===Object.prototype || Object.getPrototypeOf(v)===null) &&
    Reflect.ownKeys(v).length===names.length && names.every(k=>{const d=Object.getOwnPropertyDescriptor(v,k);return !!d && Object.hasOwn(d,'value') && d.enumerable;});
  const text=(v:unknown)=>typeof v==='string' && v.length>0 && v.length<=256;
  const count=(v:unknown)=>Number.isSafeInteger(v) && (v as number)>=0;
  if(!Number.isSafeInteger(replyLimit) || replyLimit<131072)throw Error('Invalid mesh reply limit');
  const a=copyBounded(authority,65536), m=copyBounded(manifest,Math.min(replyLimit,65536));
  const identity=(v:any)=>keys(v,['session_id','project_revision','run_epoch']) && text(v.session_id) && text(v.project_revision) && count(v.run_epoch);
  const sameIdentity=(x:any,y:any)=>identity(x) && identity(y) && x.session_id===y.session_id && x.project_revision===y.project_revision && x.run_epoch===y.run_epoch;
  if(!keys(a,['request_id','generation','identity','transfer_id']) || !text(a.request_id) || !text(a.transfer_id) || !count(a.generation) || !identity(a.identity) ||
     !keys(m,['kind','request_id','generation','identity','transfer_id','meshes','geom_mesh_ids','total_bytes']) || m.kind!=='mesh-manifest' ||
     m.request_id!==a.request_id || m.generation!==a.generation || m.transfer_id!==a.transfer_id || !sameIdentity(m.identity,a.identity) ||
     !Array.isArray(m.meshes) || m.meshes.length>1024 || !Array.isArray(m.geom_mesh_ids) || m.geom_mesh_ids.length>1024 ||
     new TextEncoder().encode(JSON.stringify(m)).length>65536)throw Error('Invalid mesh manifest');
  let vertices=0, triangles=0;
  for(let i=0;i<m.meshes.length;i++) {
    const row=m.meshes[i];
    if(!keys(row,['id','vertices','triangles']) || row.id!==i || !count(row.vertices) || !count(row.triangles) ||
       row.vertices>500000-vertices || row.triangles>200000-triangles)throw Error('Invalid mesh dimensions');
    vertices+=row.vertices;triangles+=row.triangles;
  }
  if(m.geom_mesh_ids.some((id:any)=>!Number.isSafeInteger(id) || id < -1 || id>=m.meshes.length))throw Error('Invalid geometry mesh mapping');
  const total=12*vertices+12*triangles+4*m.geom_mesh_ids.length;
  if(!Number.isSafeInteger(total) || total>8*1024*1024 || m.total_bytes!==total)throw Error('Mesh byte limit exceeded');
  let output=m.meshes.map((row:any)=>({id:row.id,positions:new Float32Array(row.vertices*3),indices:new Uint32Array(row.triangles*3)}));
  let mapping:Int32Array|null=new Int32Array(m.geom_mesh_ids);
  let mesh=0, stream:'positions'|'indices'='positions', offset=0, sequence=0, ended=false;
  const tokens=new Set<string>();
  function skipEmpty() {while(mesh<output.length && output[mesh][stream].length===0){if(stream==='positions')stream='indices';else {mesh++;stream='positions';}}}
  skipEmpty();
  const validEnvelope=(v:any,kind:string)=>v.kind===kind && v.request_id===a.request_id && v.generation===a.generation &&
    v.transfer_id===a.transfer_id && sameIdentity(v.identity,a.identity);
  const abort=()=>{if(ended)return;ended=true;output=[];mapping=null;tokens.clear();};
  function acceptChunk(input:unknown) {
    if(ended)throw Error('Mesh receiver closed');
    try {
      const names=['kind','request_id','generation','identity','transfer_id','sequence','mesh_id','stream','offset','ack_token','bytes'];
      if(!keys(input,names))throw Error('Invalid mesh chunk');
      const raw=input as Record<string,unknown>, descriptor=Object.getOwnPropertyDescriptor(raw,'bytes')!;
      const meta:any={};
      for(const name of names)if(name!=='bytes')Object.defineProperty(meta,name,{value:Object.getOwnPropertyDescriptor(raw,name)!.value,enumerable:true});
      const c=copyBounded(meta,Math.min(replyLimit,65536));
      const byteLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength')?.get;
      const resizable=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'resizable')?.get;
      const buffer=descriptor.value;
      if(!byteLength || typeof buffer!=='object' || buffer===null)throw Error('Invalid mesh buffer');
      let length:number;try {length=Reflect.apply(byteLength,buffer,[]);if(resizable && Reflect.apply(resizable,buffer,[]))throw Error('Resizable');new Uint8Array(buffer,0,0);}catch{throw Error('Invalid mesh buffer');}
      const expected=output[mesh], target=expected?.[stream];
      const expectedLength=target ? Math.min(65536,target.byteLength-offset) : 0;
      const metadataBytes=new TextEncoder().encode(JSON.stringify({...c,bytes:{}})).length;
      if(!validEnvelope(c,'mesh-chunk') || c.sequence!==sequence || !expected || c.mesh_id!==mesh || c.stream!==stream || c.offset!==offset ||
         typeof c.ack_token!=='string' || c.ack_token.length<16 || c.ack_token.length>128 || !/^[A-Za-z0-9_-]+$/.test(c.ack_token) || tokens.has(c.ack_token) ||
         length!==expectedLength || length<4 || length%4!==0 || metadataBytes>65536 || metadataBytes+length>replyLimit)throw Error('Invalid mesh chunk');
      const inputView=new DataView(buffer), start=offset/4;
      for(let i=0;i<length/4;i++) {
        if(stream==='positions'){const value=inputView.getFloat32(i*4,true);if(!Number.isFinite(value))throw Error('Invalid mesh position');expected.positions[start+i]=value;}
        else {const value=inputView.getUint32(i*4,true);if(value>=expected.positions.length/3)throw Error('Invalid mesh index');expected.indices[start+i]=value;}
      }
      tokens.add(c.ack_token);const accepted={sequence,ack_token:c.ack_token};sequence++;offset+=length;
      if(offset===target.byteLength){offset=0;if(stream==='positions')stream='indices';else {mesh++;stream='positions';}skipEmpty();}
      return accepted;
    } catch(error) {abort();throw error;}
  }
  function finish(input:unknown) {
    if(ended)throw Error('Mesh receiver closed');
    try {
      const c=copyBounded(input,Math.min(replyLimit,65536));
      if(!keys(c,['kind','request_id','generation','identity','transfer_id']) || !validEnvelope(c,'mesh-closed') || mesh!==output.length)throw Error('Invalid mesh close');
      if(!mapping)throw Error('Mesh receiver closed');
      const meshes=output, geomMeshIds=mapping;
      ended=true;output=[];mapping=null;tokens.clear();
      return {identity:{...a.identity},catalog:{engine_version:'3.17.0' as const,meshes,geom_mesh_ids:geomMeshIds}};
    } catch(error) {abort();throw error;}
  }
  return Object.freeze({get complete(){return !ended && mesh===output.length;},acceptChunk,finish,abort});
}
