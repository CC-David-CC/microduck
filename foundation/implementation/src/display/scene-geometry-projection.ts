import {copyBounded} from '../session/project-world-wire.ts';

/** Partial presentation metadata; it does not render or represent a full scene. */
export function projectSceneGeometry(input:unknown) {
  const value:any=copyBounded(input,1048576);
  const exact=(v:any,keys:string[])=>!!v && typeof v==='object' && !Array.isArray(v) &&
    Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));
  const count=(v:any)=>Number.isSafeInteger(v) && v>=0;
  const vec=(v:any,n:number)=>Array.isArray(v) && v.length===n && v.every((x:any)=>typeof x==='number' && Number.isFinite(x));
  const quat=(v:any)=>vec(v,4) && Math.abs(Math.hypot(...v)-1)<=1e-9;
  const identity=(v:any)=>exact(v,['session_id','project_revision','run_epoch']) && typeof v.session_id==='string' && v.session_id.length>0 &&
    typeof v.project_revision==='string' && v.project_revision.length>0 && count(v.run_epoch);
  const same=(a:any,b:any)=>identity(a) && identity(b) && a.session_id===b.session_id && a.project_revision===b.project_revision && a.run_epoch===b.run_epoch;
  if(!exact(value,['visual','groups','meshes','visibility']) || !exact(value.visual,['identity','model','frame']) ||
     !exact(value.groups,['identity','groups']) || !exact(value.meshes,['identity','mesh_count','geom_mesh_ids']) ||
     !same(value.visual.identity,value.groups.identity) || !same(value.visual.identity,value.meshes.identity) ||
     !Array.isArray(value.visibility) || value.visibility.length!==6 || !value.visibility.every((x:any)=>typeof x==='boolean')) throw Error('Invalid scene authority or mask');
  const {model,frame}=value.visual, groups=value.groups.groups, mapping=value.meshes.geom_mesh_ids, meshCount=value.meshes.mesh_count;
  if(!exact(model,['engine_version','bodies','geoms']) || !exact(frame,['engine_version','tick','time','bodies']) ||
     model.engine_version!=='3.17.0' || frame.engine_version!=='3.17.0' || !count(frame.tick) || typeof frame.time!=='number' || !Number.isFinite(frame.time) || frame.time<0 ||
     !Array.isArray(model.bodies) || model.bodies.length<1 || model.bodies.length>4096 || !Array.isArray(frame.bodies) || frame.bodies.length!==model.bodies.length ||
     !Array.isArray(model.geoms) || model.geoms.length>1024 || !Array.isArray(groups) || groups.length!==model.geoms.length ||
     !Array.isArray(mapping) || mapping.length!==model.geoms.length || !count(meshCount) || meshCount>1024) throw Error('Invalid scene dimensions');
  for(let id=0;id<model.bodies.length;id++){
    const m=model.bodies[id],b=frame.bodies[id];
    if(!exact(m,['id','name','parent_id']) || m.id!==id || !(m.name===null||typeof m.name==='string') ||
       (id===0?m.parent_id!==null:!count(m.parent_id)||m.parent_id>=id) || !exact(b,['id','position','quaternion']) ||
       b.id!==id || !vec(b.position,3) || !quat(b.quaternion))throw Error('Invalid scene body');
  }
  const matrix=([w,x,y,z]:number[])=>[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w),2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w),2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)];
  const product=([w,x,y,z]:number[],[a,b,c,d]:number[])=>[w*a-x*b-y*c-z*d,w*b+x*a+y*d-z*c,w*c-x*d+y*a+z*b,w*d+x*c-y*b+z*a];
  const geoms:any[]=[];
  for(let id=0;id<model.geoms.length;id++){
    const g=model.geoms[id],group=groups[id],mesh=mapping[id];
    if(!exact(g,['id','name','body_id','type','material_id','size','position','quaternion','rgba']) || g.id!==id ||
       !(g.name===null||typeof g.name==='string') || !count(g.body_id) || g.body_id>=model.bodies.length ||
       !['plane','sphere','capsule','ellipsoid','cylinder','box','mesh'].includes(g.type) ||
       !(g.material_id===null||count(g.material_id)) || !vec(g.size,3) || g.size.some((x:number)=>x<0) ||
       !vec(g.position,3) || !quat(g.quaternion) || !vec(g.rgba,4) || g.rgba.some((x:number)=>x<0||x>1) ||
       !count(group) || group>=6 || !Number.isSafeInteger(mesh) || (g.type==='mesh' ? mesh<0||mesh>=meshCount : mesh!==-1)) throw Error('Invalid scene geometry');
    const body=frame.bodies[g.body_id],r=matrix(body.quaternion),local=g.position;
    const position=[0,1,2].map(i=>body.position[i]+r[i*3]*local[0]+r[i*3+1]*local[1]+r[i*3+2]*local[2]);
    const rotation=matrix(product(body.quaternion,g.quaternion));
    if(!position.every(Number.isFinite)||!rotation.every(Number.isFinite))throw Error('Invalid scene transform');
    if(value.visibility[group])geoms.push({id,body_id:g.body_id,group,material_id:g.material_id,type:g.type,size:g.size,rgba:g.rgba,
      mesh_id:g.type==='mesh'?mesh:null,position,rotation});
  }
  return copyBounded({status:'partial',identity:value.visual.identity,tick:frame.tick,time:frame.time,geoms,
    limitations:['sites','materials','textures','skybox','lighting','mesh-normals','uvs']},1048576);
}
