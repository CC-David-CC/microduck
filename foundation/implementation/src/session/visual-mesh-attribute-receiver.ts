import {copyBounded} from './project-world-wire.ts';

/** Assemble one authorized attribute transfer into bounded owned arrays. */
export function createVisualMeshAttributeReceiver(authority:unknown, manifest:unknown, replyLimit:number) {
  const keys=(v:any,names:string[])=>!!v && typeof v==='object' && !Array.isArray(v) &&
    (Object.getPrototypeOf(v)===Object.prototype || Object.getPrototypeOf(v)===null) &&
    Reflect.ownKeys(v).length===names.length && names.every(k=>{const d=Object.getOwnPropertyDescriptor(v,k);return !!d && Object.hasOwn(d,'value') && d.enumerable;});
  const text=(v:unknown)=>typeof v==='string' && v.length>0 && v.length<=256;
  const count=(v:unknown)=>Number.isSafeInteger(v) && (v as number)>=0;
  if(!Number.isSafeInteger(replyLimit) || replyLimit<131072)throw Error('Invalid attribute reply limit');
  const a=copyBounded(authority,65536), m=copyBounded(manifest,Math.min(replyLimit,65536));
  const identity=(v:any)=>keys(v,['session_id','project_revision','run_epoch']) && text(v.session_id) && text(v.project_revision) && count(v.run_epoch);
  const sameIdentity=(x:any,y:any)=>identity(x) && identity(y) && x.session_id===y.session_id && x.project_revision===y.project_revision && x.run_epoch===y.run_epoch;
  if(!keys(a,['request_id','generation','identity','transfer_id']) || !text(a.request_id) || !text(a.transfer_id) || !count(a.generation) || !identity(a.identity) ||
     !keys(m,['kind','request_id','generation','identity','transfer_id','meshes','total_bytes']) || m.kind!=='mesh-attributes-manifest' ||
     m.request_id!==a.request_id || m.generation!==a.generation || m.transfer_id!==a.transfer_id || !sameIdentity(m.identity,a.identity) ||
     !Array.isArray(m.meshes) || m.meshes.length>1024 || new TextEncoder().encode(JSON.stringify(m)).length>65536)throw Error('Invalid attribute manifest');
  let normals=0,uvs=0,faces=0;
  for(let i=0;i<m.meshes.length;i++){
    const row=m.meshes[i];
    if(!keys(row,['id','normal_count','uv_count','faces','normal_present','uv_present']) || row.id!==i ||
       !count(row.normal_count) || !count(row.uv_count) || !count(row.faces) ||
       typeof row.normal_present!=='boolean' || typeof row.uv_present!=='boolean' ||
       row.normal_present!==(row.normal_count>0) || row.uv_present!==(row.uv_count>0) ||
       row.normal_count>500000-normals || row.uv_count>500000-uvs || row.faces>200000-faces)throw Error('Invalid attribute dimensions');
    normals+=row.normal_count;uvs+=row.uv_count;faces+=row.faces;
  }
  const total=12*normals+8*uvs+24*faces;
  if(!Number.isSafeInteger(total) || total>8*1024*1024 || m.total_bytes!==total)throw Error('Attribute byte limit exceeded');
  let output=m.meshes.map((row:any)=>({id:row.id,
    normal:{present:row.normal_present,values:new Float32Array(row.normal_count*3),face_indices:new Int32Array(row.faces*3)},
    uv:{present:row.uv_present,values:new Float32Array(row.uv_count*2),face_indices:new Int32Array(row.faces*3)}}));
  let mesh=0,stream=0,offset=0,sequence=0,ended=false;
  const streams=['normal-values','normal-indices','uv-values','uv-indices'];
  const tokens=new Set<string>();
  const values=()=>{const r=output[mesh];return r ? [r.normal.values,r.normal.face_indices,r.uv.values,r.uv.face_indices][stream] : undefined;};
  function skipEmpty(){while(mesh<output.length && values()!.length===0){stream++;if(stream===4){stream=0;mesh++;}}}
  skipEmpty();
  const validEnvelope=(v:any,kind:string)=>v.kind===kind && v.request_id===a.request_id && v.generation===a.generation &&
    v.transfer_id===a.transfer_id && sameIdentity(v.identity,a.identity);
  const abort=()=>{if(ended)return;ended=true;output=[];tokens.clear();};
  function acceptChunk(input:unknown) {
    if(ended)throw Error('Attribute receiver closed');
    try {
      const names=['kind','request_id','generation','identity','transfer_id','sequence','mesh_id','stream','offset','ack_token','bytes'];
      if(!keys(input,names))throw Error('Invalid attribute chunk');
      const raw=input as Record<string,unknown>, descriptor=Object.getOwnPropertyDescriptor(raw,'bytes')!, meta:any={};
      for(const name of names)if(name!=='bytes')Object.defineProperty(meta,name,{value:Object.getOwnPropertyDescriptor(raw,name)!.value,enumerable:true});
      const c=copyBounded(meta,Math.min(replyLimit,65536));
      const byteLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength')?.get;
      const resizable=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'resizable')?.get, buffer=descriptor.value;
      if(!byteLength || typeof buffer!=='object' || buffer===null)throw Error('Invalid attribute buffer');
      let length:number;try{length=Reflect.apply(byteLength,buffer,[]);if(resizable && Reflect.apply(resizable,buffer,[]))throw Error('Resizable');new Uint8Array(buffer,0,0);}catch{throw Error('Invalid attribute buffer');}
      const row=output[mesh], target=values(), expected=target ? Math.min(65536,target.byteLength-offset) : 0;
      const metadataBytes=new TextEncoder().encode(JSON.stringify({...c,bytes:{}})).length;
      if(!validEnvelope(c,'mesh-attributes-chunk') || c.sequence!==sequence || !row || !target || c.mesh_id!==mesh || c.stream!==streams[stream] || c.offset!==offset ||
         typeof c.ack_token!=='string' || c.ack_token.length<1 || c.ack_token.length>128 || tokens.has(c.ack_token) ||
         length!==expected || length<4 || length%4!==0 || metadataBytes>65536 || metadataBytes+length>replyLimit)throw Error('Invalid attribute chunk');
      const view=new DataView(buffer),start=offset/4;
      for(let i=0;i<length/4;i++){
        if(stream===0 || stream===2){const x=view.getFloat32(i*4,true);if(!Number.isFinite(x))throw Error('Invalid attribute value');target[start+i]=x;}
        else {const x=view.getInt32(i*4,true), part=stream===1 ? row.normal : row.uv, width=stream===1 ? 3 : 2;
          if(part.present && (x<0 || x>=part.values.length/width))throw Error('Invalid attribute index');target[start+i]=x;}
      }
      tokens.add(c.ack_token);const accepted={sequence,ack_token:c.ack_token};sequence++;offset+=length;
      if(offset===target.byteLength){offset=0;stream++;if(stream===4){stream=0;mesh++;}skipEmpty();}
      return accepted;
    } catch(error){abort();throw error;}
  }
  function finish(input:unknown){
    if(ended)throw Error('Attribute receiver closed');
    try {
      const c=copyBounded(input,Math.min(replyLimit,65536));
      if(!keys(c,['kind','request_id','generation','identity','transfer_id']) || !validEnvelope(c,'mesh-attributes-closed') || mesh!==output.length)throw Error('Invalid attribute close');
      const meshes=output;ended=true;output=[];tokens.clear();
      return {identity:{...a.identity},attributes:{meshes}};
    } catch(error){abort();throw error;}
  }
  return Object.freeze({get complete(){return !ended && mesh===output.length;},acceptChunk,finish,abort});
}
