import type {MainModule, MjModel, MjData} from '@mujoco/mujoco';

export type VisualGeomType = 'plane' | 'hfield' | 'sphere' | 'capsule' | 'ellipsoid' |
  'cylinder' | 'box' | 'mesh' | 'sdf' | 'unsupported';
export type VisualModelFacts = {
  engine_version: '3.17.0';
  bodies: Array<{id: number; name: string | null; parent_id: number | null}>;
  geoms: Array<{
    id: number; name: string | null; body_id: number; type: VisualGeomType; material_id: number | null;
    size: [number, number, number]; position: [number, number, number];
    quaternion: [number, number, number, number];
    rgba: [number, number, number, number];
  }>;
};
export type VisualFrameFacts = {
  engine_version: '3.17.0';
  bodies: Array<{id: number; position: [number, number, number];
    quaternion: [number, number, number, number]}>;
};
export type VisualFrame = VisualFrameFacts & {tick: number; time: number};

export class MeshAttributeCapacityError extends Error {}
export class MeshAttributeDataError extends Error {}

/** Copy compiled per-corner appearance attributes without retaining engine memory. */
export function readVisualMeshAttributes(mj: MainModule, model: MjModel, limits: {
  max_meshes:number; max_normals:number; max_texcoords:number; max_faces:number; max_bytes:number;
}) {
  const keys = ['max_meshes','max_normals','max_texcoords','max_faces','max_bytes'] as const;
  const ceilings = [1024,500000,500000,200000,8*1024*1024];
  if (!limits || typeof limits !== 'object' || Array.isArray(limits) ||
      ![Object.prototype,null].includes(Object.getPrototypeOf(limits)) || Reflect.ownKeys(limits).length !== keys.length)
    throw new MeshAttributeDataError('Invalid attribute limits');
  const caps=keys.map((key,i)=>{
    const d=Object.getOwnPropertyDescriptor(limits,key);
    if (!d || !Object.hasOwn(d,'value') || !d.enumerable || !Number.isSafeInteger(d.value) || d.value<1 || d.value>ceilings[i])
      throw new MeshAttributeDataError('Invalid attribute limit');
    return d.value as number;
  });
  if (!mj || typeof mj.mj_versionString !== 'function' || mj.mj_versionString() !== '3.17.0' || !model)
    throw new MeshAttributeDataError('Invalid attribute engine or model');
  const {nmesh,nmeshnormal,nmeshtexcoord,nmeshface}=model;
  const dims=[nmesh,nmeshnormal,nmeshtexcoord,nmeshface];
  if (!dims.every(n=>Number.isSafeInteger(n) && n>=0)) throw new MeshAttributeDataError('Invalid attribute dimensions');
  if (!dims.every((n,i)=>n<=caps[i])) throw new MeshAttributeCapacityError('Attribute dimensions exceed limits');
  const bytes=12*nmeshnormal+8*nmeshtexcoord+24*nmeshface;
  if (!Number.isSafeInteger(bytes)) throw new MeshAttributeDataError('Invalid attribute byte count');
  if (bytes>caps[4]) throw new MeshAttributeCapacityError('Attribute byte limit exceeded');
  const na=model.mesh_normaladr, nn=model.mesh_normalnum, ua=model.mesh_texcoordadr, un=model.mesh_texcoordnum;
  const fa=model.mesh_faceadr, fn=model.mesh_facenum, normals=model.mesh_normal, uvs=model.mesh_texcoord;
  const normalFaces=model.mesh_facenormal, uvFaces=model.mesh_facetexcoord;
  const typedPrototype=Object.getPrototypeOf(Uint8Array.prototype);
  const bufferLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength')?.get;
  const resizable=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'resizable')?.get;
  const typed=(value:unknown,kind:string,length:number):boolean=>{
    try {
      if (!ArrayBuffer.isView(value) || Reflect.get(typedPrototype,Symbol.toStringTag,value)!==kind ||
          Reflect.get(typedPrototype,'length',value)!==length || !bufferLength) return false;
      const buffer=Reflect.get(typedPrototype,'buffer',value);
      Reflect.apply(bufferLength,buffer,[]);
      if (resizable && Reflect.apply(resizable,buffer,[])) return false;
      new Uint8Array(buffer,0,0);
      return true;
    } catch {return false;}
  };
  if (![na,nn,ua,un,fa,fn].every(a=>typed(a,'Int32Array',nmesh)) ||
      !typed(normals,'Float32Array',nmeshnormal*3) || !typed(uvs,'Float32Array',nmeshtexcoord*2) ||
      !typed(normalFaces,'Int32Array',nmeshface*3) || !typed(uvFaces,'Int32Array',nmeshface*3))
    throw new MeshAttributeDataError('Invalid attribute array shape');
  const meshes:Array<{id:number;normal:{present:boolean;values:Float32Array;face_indices:Int32Array};uv:{present:boolean;values:Float32Array;face_indices:Int32Array}}> = [];
  let no=0, uo=0, fo=0;
  for (let id=0;id<nmesh;id++) {
    const nc=nn[id], uc=un[id], fc=fn[id];
    if (nc<0 || uc<0 || fc<0 || nc>nmeshnormal-no || uc>nmeshtexcoord-uo || fc>nmeshface-fo ||
        (nc ? na[id]!==no : na[id]!==-1) || (uc ? ua[id]!==uo : ua[id]!==-1) || fa[id]!==fo)
      throw new MeshAttributeDataError('Invalid packed attribute slices');
    const nv=new Float32Array(nc*3), uv=new Float32Array(uc*2);
    const nf=new Int32Array(fc*3), uf=new Int32Array(fc*3);
    for(let i=0;i<nv.length;i++){const x=normals[no*3+i];if(!Number.isFinite(x))throw new MeshAttributeDataError('Invalid normal');nv[i]=x;}
    for(let i=0;i<uv.length;i++){const x=uvs[uo*2+i];if(!Number.isFinite(x))throw new MeshAttributeDataError('Invalid UV');uv[i]=x;}
    for(let i=0;i<nf.length;i++){
      const n=normalFaces[fo*3+i], u=uvFaces[fo*3+i];
      if ((nc && (n<0 || n>=nc)) || (uc && (u<0 || u>=uc))) throw new MeshAttributeDataError('Invalid attribute face index');
      nf[i]=n;uf[i]=u;
    }
    meshes.push({id,normal:{present:nc>0,values:nv,face_indices:nf},uv:{present:uc>0,values:uv,face_indices:uf}});
    no+=nc;uo+=uc;fo+=fc;
  }
  if(no!==nmeshnormal || uo!==nmeshtexcoord || fo!==nmeshface) throw new MeshAttributeDataError('Unaccounted attribute data');
  return {engine_version:'3.17.0' as const,meshes};
}

/** Copy compiled geometry groups for a display's explicit visibility policy. */
export function readVisualGeomGroups(mj: MainModule, model: MjModel): number[] {
  if (!mj || typeof mj.mj_versionString !== 'function' || mj.mj_versionString() !== '3.17.0' || !model ||
      !Number.isSafeInteger(model.ngeom) || model.ngeom < 0 || model.ngeom > 1024) throw new Error('Invalid visual geometry dimensions');
  const groups = model.geom_group, typed = Object.getPrototypeOf(Uint8Array.prototype);
  const length = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength')?.get;
  const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'resizable')?.get;
  try {
    if (!ArrayBuffer.isView(groups) || Reflect.get(typed,Symbol.toStringTag,groups) !== 'Int32Array' ||
        Reflect.get(typed,'length',groups) !== model.ngeom || !length) throw new Error('Invalid groups');
    const buffer = Reflect.get(typed,'buffer',groups);
    Reflect.apply(length,buffer,[]);
    if (resizable && Reflect.apply(resizable,buffer,[])) throw new Error('Resizable groups');
    new Uint8Array(buffer,0,0);
  } catch {throw new Error('Invalid compiled geometry groups');}
  const checked = groups as Int32Array;
  const result: number[] = [];
  for (let id = 0; id < model.ngeom; id++) result.push(checked[id]);
  return result;
}

/** Copy bounded compiled mesh data for presentation. No WASM heap view escapes. */
export function readVisualMeshCatalog(mj: MainModule, model: MjModel, limits: {
  max_meshes:number; max_vertices:number; max_triangles:number; max_bytes:number;
}) {
  const keys = ['max_meshes','max_vertices','max_triangles','max_bytes'] as const;
  const ceiling = [1024, 1000000, 2000000, 64 * 1024 * 1024];
  if (!limits || typeof limits !== 'object' || Array.isArray(limits) ||
      ![Object.prototype,null].includes(Object.getPrototypeOf(limits)) || Reflect.ownKeys(limits).length !== keys.length) throw new Error('Invalid mesh limits');
  const caps = keys.map((key,i) => {
    const field=Object.getOwnPropertyDescriptor(limits,key);
    if (!field || !Object.hasOwn(field,'value') || !field.enumerable || !Number.isSafeInteger(field.value) || field.value<1 || field.value>ceiling[i]) throw new Error('Invalid mesh limit');
    return field.value as number;
  });
  if (!mj || typeof mj.mj_versionString!=='function' || mj.mj_versionString()!=='3.17.0' || !model) throw new Error('Invalid mesh engine or model');
  const {nmesh,ngeom,nmeshvert,nmeshface}=model;
  if (![nmesh,ngeom,nmeshvert,nmeshface].every(x=>Number.isSafeInteger(x) && x>=0) ||
      nmesh>caps[0] || ngeom>1024 || nmeshvert>caps[1] || nmeshface>caps[2]) throw new Error('Mesh dimensions exceed limits');
  const bytes=12*nmeshvert+12*nmeshface+4*ngeom;
  if (!Number.isSafeInteger(bytes) || bytes>caps[3]) throw new Error('Mesh byte limit exceeded');
  const va=model.mesh_vertadr, vn=model.mesh_vertnum, fa=model.mesh_faceadr, fn=model.mesh_facenum;
  const verts=model.mesh_vert, faces=model.mesh_face, types=model.geom_type, ids=model.geom_dataid;
  const typedPrototype=Object.getPrototypeOf(Uint8Array.prototype);
  const arrayBufferLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength')?.get;
  const resizable=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'resizable')?.get;
  const typed=(value:unknown,kind:string,length:number):boolean => {
    try {
      if(!ArrayBuffer.isView(value) || Reflect.get(typedPrototype,Symbol.toStringTag,value)!==kind ||
         Reflect.get(typedPrototype,'length',value)!==length || !arrayBufferLength) return false;
      const buffer=Reflect.get(typedPrototype,'buffer',value);
      Reflect.apply(arrayBufferLength,buffer,[]); // rejects SharedArrayBuffer and relabeled impostors
      if(resizable && Reflect.apply(resizable,buffer,[]))return false;
      new Uint8Array(buffer,0,0); // also rejects a detached zero-length buffer
      return true;
    } catch {return false;}
  };
  const ints=(value:unknown,length:number): value is Int32Array => typed(value,'Int32Array',length);
  if (!ints(va,nmesh) || !ints(vn,nmesh) || !ints(fa,nmesh) || !ints(fn,nmesh) ||
      !ints(faces,nmeshface*3) || !ints(types,ngeom) || !ints(ids,ngeom) ||
      !typed(verts,'Float32Array',nmeshvert*3)) throw new Error('Invalid mesh array shape');
  const geomMeshIds=new Int32Array(ngeom);
  const meshType=mj.mjtGeom.mjGEOM_MESH.value;
  const validTypes = new Set<number>([mj.mjtGeom.mjGEOM_PLANE.value,mj.mjtGeom.mjGEOM_HFIELD.value,
    mj.mjtGeom.mjGEOM_SPHERE.value,mj.mjtGeom.mjGEOM_CAPSULE.value,mj.mjtGeom.mjGEOM_ELLIPSOID.value,
    mj.mjtGeom.mjGEOM_CYLINDER.value,mj.mjtGeom.mjGEOM_BOX.value,meshType,mj.mjtGeom.mjGEOM_SDF.value]);
  for(let i=0;i<ngeom;i++) {
    if(!validTypes.has(types[i]) || ids[i]<-1)throw new Error('Invalid geometry mesh binding');
    if(types[i]===meshType){if(ids[i]<0 || ids[i]>=nmesh)throw new Error('Invalid mesh id');geomMeshIds[i]=ids[i];}
    else geomMeshIds[i]=-1;
  }
  const meshes: Array<{id:number;positions:Float32Array;indices:Uint32Array}>=[];
  let vertexOffset=0, faceOffset=0;
  for(let id=0;id<nmesh;id++) {
    const count=vn[id], faceCount=fn[id];
    if(va[id]!==vertexOffset || fa[id]!==faceOffset || count<0 || faceCount<0 ||
       count>nmeshvert-vertexOffset || faceCount>nmeshface-faceOffset)throw new Error('Invalid packed mesh slices');
    const positions=new Float32Array(count*3), indices=new Uint32Array(faceCount*3);
    for(let i=0;i<positions.length;i++){const x=verts[vertexOffset*3+i];if(!Number.isFinite(x))throw new Error('Invalid mesh position');positions[i]=x;}
    for(let i=0;i<indices.length;i++){const x=faces[faceOffset*3+i];if(x<0 || x>=count)throw new Error('Invalid mesh face index');indices[i]=x;}
    meshes.push({id,positions,indices});vertexOffset+=count;faceOffset+=faceCount;
  }
  if(vertexOffset!==nmeshvert || faceOffset!==nmeshface)throw new Error('Incomplete mesh buffers');
  return {engine_version:'3.17.0' as const,meshes,geom_mesh_ids:geomMeshIds};
}

function index(value: number, count: number) {
  return Number.isSafeInteger(value) && value >= 0 && value < count;
}
function name(mj: MainModule, model: MjModel, kind: number, address: number, id: number) {
  if (!index(address, model.names.length) || model.names[address] === 0) return null;
  const value = mj.mj_id2name(model, kind, id);
  return typeof value === 'string' ? value : null;
}
function tuple3(values: ArrayLike<number>, offset: number): [number, number, number] {
  const result: [number, number, number] = [values[offset], values[offset + 1], values[offset + 2]];
  if (!result.every(Number.isFinite)) throw new Error('Nonfinite compiled visual transform');
  return result;
}
function tuple4(values: ArrayLike<number>, offset: number): [number, number, number, number] {
  const result: [number, number, number, number] =
    [values[offset], values[offset + 1], values[offset + 2], values[offset + 3]];
  if (!result.every(Number.isFinite)) throw new Error('Nonfinite compiled visual transform');
  return result;
}
export function compiledGeomType(mj: MainModule, type: number): VisualGeomType {
  const types = mj.mjtGeom;
  if (type === types.mjGEOM_PLANE.value) return 'plane';
  if (type === types.mjGEOM_HFIELD.value) return 'hfield';
  if (type === types.mjGEOM_SPHERE.value) return 'sphere';
  if (type === types.mjGEOM_CAPSULE.value) return 'capsule';
  if (type === types.mjGEOM_ELLIPSOID.value) return 'ellipsoid';
  if (type === types.mjGEOM_CYLINDER.value) return 'cylinder';
  if (type === types.mjGEOM_BOX.value) return 'box';
  if (type === types.mjGEOM_MESH.value) return 'mesh';
  if (type === types.mjGEOM_SDF.value) return 'sdf';
  return 'unsupported';
}

/** Copy immutable display identities and local geometry from one compiled model.
 * This only describes rendering; it does not add collision or control semantics. */
export function readVisualModel(mj: MainModule, model: MjModel): VisualModelFacts {
  if (!Number.isSafeInteger(model.nbody) || model.nbody < 1 ||
      !Number.isSafeInteger(model.ngeom) || model.ngeom < 0 ||
      !Number.isSafeInteger(model.nmat) || model.nmat < 0) {
    throw new Error('Invalid compiled visual object count');
  }
  const bodies: VisualModelFacts['bodies'] = [];
  for (let id = 0; id < model.nbody; id++) {
    const rawParent = model.body_parentid[id];
    const parent = id === 0 ? null : rawParent;
    if (id === 0 ? rawParent !== 0 && rawParent !== -1 : !index(parent, id)) {
      throw new Error('Invalid compiled body parent');
    }
    bodies.push({id, name: name(mj, model, mj.mjtObj.mjOBJ_BODY.value, model.name_bodyadr[id], id),
      parent_id: parent});
  }
  const geoms: VisualModelFacts['geoms'] = [];
  for (let id = 0; id < model.ngeom; id++) {
    const bodyId = model.geom_bodyid[id];
    if (!index(bodyId, model.nbody)) throw new Error('Invalid compiled geom body');
    const materialId = model.geom_matid[id];
    if (materialId !== -1 && !index(materialId, model.nmat)) throw new Error('Invalid compiled geom material');
    geoms.push({id, name: name(mj, model, mj.mjtObj.mjOBJ_GEOM.value, model.name_geomadr[id], id),
      body_id: bodyId, type: compiledGeomType(mj, model.geom_type[id]), material_id: materialId === -1 ? null : materialId,
      size: tuple3(model.geom_size, 3 * id), position: tuple3(model.geom_pos, 3 * id),
      quaternion: tuple4(model.geom_quat, 4 * id), rgba: tuple4(model.geom_rgba, 4 * id)});
  }
  return {engine_version: '3.17.0', bodies, geoms};
}

/** Copy already-forwarded physical body poses. The caller must establish that
 * data is at the current forward stage; this function never advances or forwards
 * the engine. The cap is checked before any engine array is accessed. */
export function readForwardVisualFrame(model: MjModel, data: MjData, maxBodies: number): VisualFrameFacts {
  if (!Number.isSafeInteger(maxBodies) || maxBodies < 1 || maxBodies > 4096 ||
      !Number.isSafeInteger(model?.nbody) || model.nbody < 1 || model.nbody > maxBodies) {
    throw new Error('Visual body capacity exceeded');
  }
  const positions = data?.xpos, quaternions = data?.xquat;
  if (!positions || !quaternions || positions.length !== model.nbody * 3 || quaternions.length !== model.nbody * 4) {
    throw new Error('Invalid forward visual array shape');
  }
  const bodies: VisualFrameFacts['bodies'] = [];
  for (let id = 0; id < model.nbody; id++) {
    const position = tuple3(positions, id * 3), quaternion = tuple4(quaternions, id * 4);
    if (Math.abs(Math.hypot(...quaternion) - 1) > 1e-9) throw new Error('Non-unit engine body quaternion');
    bodies.push({id, position, quaternion});
  }
  return {engine_version:'3.17.0', bodies};
}

/** Evaluate body poses from the current generalized coordinates on a dedicated
 * MjData bound to the same compiled model. No live physics state is overwritten. */
export function evaluateVisualFrame(mj: MainModule, model: MjModel, data: MjData,
  qpos: ArrayLike<number>, physical: MjData): VisualFrameFacts {
  if (!Number.isSafeInteger(model.nmocap) || model.nmocap < 0 || !physical || physical === data) throw new Error('Invalid physical visual source or alias');
  if (qpos.length !== model.nq) throw new Error('Invalid visual coordinate shape');
  const target = data.qpos as Float64Array;
  if (target.length !== model.nq) throw new Error('Invalid visual data coordinate shape');
  for (let index = 0; index < qpos.length; index++) {
    if (!Number.isFinite(qpos[index])) throw new Error('Nonfinite visual coordinate');
  }
  const position = physical.mocap_pos as Float64Array, quaternion = physical.mocap_quat as Float64Array;
  const visualPosition = data.mocap_pos as Float64Array, visualQuaternion = data.mocap_quat as Float64Array;
  if (position.length !== model.nmocap * 3 || quaternion.length !== model.nmocap * 4 ||
      visualPosition.length !== position.length || visualQuaternion.length !== quaternion.length ||
      !Array.from(position).every(Number.isFinite) || !Array.from(quaternion).every(Number.isFinite)) throw new Error('Invalid authoritative mocap state');
  target.set(qpos);
  visualPosition.set(position);visualQuaternion.set(quaternion);
  mj.mj_kinematics(model, data);
  const bodies: VisualFrameFacts['bodies'] = [];
  for (let id = 0; id < model.nbody; id++) {
    const position = tuple3(data.xpos, 3 * id);
    const quaternion = tuple4(data.xquat, 4 * id);
    const norm = Math.hypot(...quaternion);
    if (Math.abs(norm - 1) > 1e-9) throw new Error('Non-unit engine body quaternion');
    bodies.push({id, position, quaternion});
  }
  return {engine_version: '3.17.0', bodies};
}
