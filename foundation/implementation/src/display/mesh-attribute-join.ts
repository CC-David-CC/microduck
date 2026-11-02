/** Validate and join two caller-owned, identity-bound compiled catalogs. */
export function joinMeshAttributes(input:unknown) {
  const exact=(v:any,keys:string[])=>!!v && typeof v==='object' && !Array.isArray(v) &&
    (Object.getPrototypeOf(v)===Object.prototype || Object.getPrototypeOf(v)===null) &&
    Reflect.ownKeys(v).length===keys.length && keys.every(k=>{const d=Object.getOwnPropertyDescriptor(v,k);return !!d && d.enumerable && Object.hasOwn(d,'value');});
  const count=(n:unknown)=>Number.isSafeInteger(n) && (n as number)>=0;
  const text=(s:unknown)=>typeof s==='string' && s.length>0 && s.length<=256;
  const identity=(v:any)=>exact(v,['session_id','project_revision','run_epoch']) && text(v.session_id) && text(v.project_revision) && count(v.run_epoch);
  const dense=(v:any)=>Array.isArray(v) && Object.getPrototypeOf(v)===Array.prototype && v.length<=1024 &&
    Reflect.ownKeys(v).length===v.length+1 && Array.from({length:v.length},(_,i)=>Object.getOwnPropertyDescriptor(v,String(i))).every(d=>!!d && d.enumerable && Object.hasOwn(d,'value'));
  if(!exact(input,['mesh','attributes']))throw Error('Invalid join input');
  const v=input as any;
  if(!exact(v.mesh,['identity','catalog']) || !exact(v.attributes,['identity','attributes']) ||
     !identity(v.mesh.identity) || !identity(v.attributes.identity) ||
     v.mesh.identity.session_id!==v.attributes.identity.session_id || v.mesh.identity.project_revision!==v.attributes.identity.project_revision ||
     v.mesh.identity.run_epoch!==v.attributes.identity.run_epoch)throw Error('Invalid join identity');
  const c=v.mesh.catalog,a=v.attributes.attributes;
  if(!exact(c,['engine_version','meshes','geom_mesh_ids']) || c.engine_version!=='3.17.0' || !exact(a,['meshes']) ||
     !dense(c.meshes) || !dense(a.meshes) || c.meshes.length!==a.meshes.length)throw Error('Invalid join catalogs');
  const typed=Object.getPrototypeOf(Uint8Array.prototype),sizeGetter=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength')?.get,
    resizable=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'resizable')?.get, buffers=new Set<unknown>();
  function fixed(x:any,kind:string) {
    try {
      if(!ArrayBuffer.isView(x) || Reflect.get(typed,Symbol.toStringTag,x)!==kind || !sizeGetter ||
         Object.getPrototypeOf(x)!==({Float32Array,Uint32Array,Int32Array} as Record<string,any>)[kind].prototype)throw Error('brand');
      for(const k of ['buffer','byteLength','byteOffset','length','constructor',Symbol.iterator,Symbol.toStringTag])if(Object.hasOwn(x,k))throw Error('shadow');
      const b=Reflect.get(typed,'buffer',x), bytes=Reflect.get(typed,'byteLength',x), length=Reflect.get(typed,'length',x);
      if(Reflect.get(typed,'byteOffset',x)!==0 || Reflect.apply(sizeGetter,b,[])!==bytes || buffers.has(b) ||
         (resizable && Reflect.apply(resizable,b,[])))throw Error('buffer');
      new Uint8Array(b,0,0);buffers.add(b);return {bytes,length};
    } catch {throw Error('Invalid join buffer');}
  }
  const mapping=fixed(c.geom_mesh_ids,'Int32Array');
  if(mapping.length>1024)throw Error('Invalid mesh mapping');
  let meshBytes=mapping.bytes,attributeBytes=0,vertices=0,faces=0,normals=0,uvs=0;
  const rows:Array<{id:number;positions:Float32Array;indices:Uint32Array;normal:{present:boolean;values:Float32Array;face_indices:Int32Array};uv:{present:boolean;values:Float32Array;face_indices:Int32Array}}> = [];
  for(let id=0;id<c.meshes.length;id++) {
    const m=c.meshes[id],p=a.meshes[id];
    if(!exact(m,['id','positions','indices']) || !exact(p,['id','normal','uv']) || m.id!==id || p.id!==id ||
       !exact(p.normal,['present','values','face_indices']) || !exact(p.uv,['present','values','face_indices']) ||
       typeof p.normal.present!=='boolean' || typeof p.uv.present!=='boolean')throw Error('Invalid join row');
    const pos=fixed(m.positions,'Float32Array'),idx=fixed(m.indices,'Uint32Array'),nv=fixed(p.normal.values,'Float32Array'),
      ni=fixed(p.normal.face_indices,'Int32Array'),uv=fixed(p.uv.values,'Float32Array'),ui=fixed(p.uv.face_indices,'Int32Array');
    if(pos.length%3 || idx.length%3 || nv.length%3 || uv.length%2 || ni.length!==idx.length || ui.length!==idx.length ||
       p.normal.present!==(nv.length>0) || p.uv.present!==(uv.length>0))throw Error('Invalid join dimensions');
    vertices+=pos.length/3;faces+=idx.length/3;normals+=nv.length/3;uvs+=uv.length/2;
    meshBytes+=pos.bytes+idx.bytes;attributeBytes+=nv.bytes+ni.bytes+uv.bytes+ui.bytes;
    if(vertices>500000 || faces>200000 || normals>500000 || uvs>500000 || meshBytes>8*1024*1024 || attributeBytes>8*1024*1024 || meshBytes+attributeBytes>16*1024*1024)throw Error('Join capacity exceeded');
    rows.push({id,positions:m.positions,indices:m.indices,normal:{present:p.normal.present,values:p.normal.values,face_indices:p.normal.face_indices},
      uv:{present:p.uv.present,values:p.uv.values,face_indices:p.uv.face_indices}});
  }
  for(let i=0;i<mapping.length;i++)if(c.geom_mesh_ids[i]<-1 || c.geom_mesh_ids[i]>=rows.length)throw Error('Invalid mesh mapping');
  for(let id=0;id<rows.length;id++) {
    const m=rows[id];
    for(let i=0;i<m.positions.length;i++)if(!Number.isFinite(m.positions[i]))throw Error('Invalid position');
    for(let i=0;i<m.normal.values.length;i++)if(!Number.isFinite(m.normal.values[i]))throw Error('Invalid normal');
    for(let i=0;i<m.uv.values.length;i++)if(!Number.isFinite(m.uv.values[i]))throw Error('Invalid UV');
    for(let i=0;i<m.indices.length;i++) {
      if(m.indices[i]>=m.positions.length/3 || (m.normal.present && (m.normal.face_indices[i]<0 || m.normal.face_indices[i]>=m.normal.values.length/3)) ||
         (m.uv.present && (m.uv.face_indices[i]<0 || m.uv.face_indices[i]>=m.uv.values.length/2)))throw Error('Invalid join index');
    }
  }
  return {status:'partial' as const,identity:{...v.mesh.identity},meshes:rows,geom_mesh_ids:c.geom_mesh_ids,
    limitations:['materials','textures','sites','skybox','lighting']};
}
