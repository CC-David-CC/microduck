import {copyBounded, DataBudgetExceeded} from '../session/project-world-wire.ts';

export class UnsupportedVisualError extends Error {}
export class VisualCapacityError extends Error {}

type Vec3 = [number,number,number];
type Quat = [number,number,number,number];
function exact(v:any,keys:string[]) { return v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k)); }
function vector(v:any,n:number): v is number[] { return Array.isArray(v) && v.length===n && v.every((x:any)=>typeof x==='number' && Number.isFinite(x)); }
function quat(v:any): v is Quat { return vector(v,4) && Math.abs(Math.hypot(...v)-1)<=1e-9; }
function matrix([w,x,y,z]:Quat):number[] { return [1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w),2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w),2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]; }
function product([w,x,y,z]:Quat,[a,b,c,d]:Quat):Quat { return [w*a-x*b-y*c-z*d,w*b+x*a+y*d-z*c,w*c-x*d+y*a+z*b,w*d+x*c-y*b+z*a]; }
/** Inert visual conversion. Session identity and epoch are verified by the caller's transport. */
export function projectVisualSnapshot(input:unknown):{tick:number;time:number;geoms:{type:'sphere'|'box';size:number[];position:number[];rotation:number[];rgba:number[]}[]} {
 let v:any;
 try {v=copyBounded(input,1048576);} catch(error) {if(error instanceof DataBudgetExceeded)throw new VisualCapacityError('Visual byte limit exceeded');throw error;}
 if(!exact(v,['model','frame']) || !exact(v.model,['engine_version','bodies','geoms']) || !exact(v.frame,['engine_version','tick','time','bodies']) || v.model.engine_version!=='3.17.0' || v.frame.engine_version!=='3.17.0' || !Array.isArray(v.model.bodies) || !Array.isArray(v.model.geoms) || !Array.isArray(v.frame.bodies) || !Number.isSafeInteger(v.frame.tick) || v.frame.tick<0 || typeof v.frame.time!=='number' || !Number.isFinite(v.frame.time) || v.frame.time<0) throw Error('Invalid visual model or frame');
 if(v.model.bodies.length>4096 || v.model.geoms.length>1024 || v.frame.bodies.length>4096) throw new VisualCapacityError('Visual object limit exceeded');
 if(v.model.bodies.length<1 || v.frame.bodies.length!==v.model.bodies.length) throw Error('Invalid visual body count');
 const bodies=new Map<number,{position:Vec3;quaternion:Quat}>();
 for(let id=0;id<v.model.bodies.length;id++){
  const m=v.model.bodies[id],b=v.frame.bodies[id];
  if(!exact(m,['id','name','parent_id']) || m.id!==id || !(m.name===null||typeof m.name==='string') || (id===0?m.parent_id!==null:!Number.isSafeInteger(m.parent_id)||m.parent_id<0||m.parent_id>=id) || !exact(b,['id','position','quaternion']) || b.id!==id || !vector(b.position,3) || !quat(b.quaternion)) throw Error('Invalid visual body');
  bodies.set(id,{position:b.position as Vec3,quaternion:b.quaternion});
 }
 const geoms:{type:'sphere'|'box';size:number[];position:number[];rotation:number[];rgba:number[]}[]=[];
 let unsupported=false, capacity=false;
 for(let id=0;id<v.model.geoms.length;id++){
  const g=v.model.geoms[id];
  if(!exact(g,['id','name','body_id','type','material_id','size','position','quaternion','rgba']) || g.id!==id || !(g.name===null||typeof g.name==='string') || !Number.isSafeInteger(g.body_id) || !bodies.has(g.body_id)) throw Error('Invalid visual geometry identity');
  if(g.material_id!==null && (!Number.isSafeInteger(g.material_id)||g.material_id<0)) throw Error('Invalid visual material');
  if(!['sphere','box','mesh','plane','hfield','capsule','ellipsoid','cylinder','sdf','unsupported'].includes(g.type)) throw Error('Invalid visual geometry type');
  if(!vector(g.size,3)||!vector(g.position,3)||!quat(g.quaternion)||!vector(g.rgba,4)||g.size.some((x:number)=>x<0)||((g.type==='sphere'||g.type==='box')&&g.size[0]<=0)||(g.type==='box'&&(g.size[1]<=0||g.size[2]<=0))||g.rgba.some((x:number)=>x<0||x>1)) throw Error('Invalid visual geometry');
  if(g.material_id!==null || (g.type!=='sphere' && g.type!=='box')) unsupported=true;
  const b=bodies.get(g.body_id)!,r=matrix(b.quaternion),local=g.position;
  const position=r.slice(0,3).map((_,axis)=>b.position[axis]+r[axis*3]*local[0]+r[axis*3+1]*local[1]+r[axis*3+2]*local[2]);
  const rotation=matrix(product(b.quaternion,g.quaternion));
  if([...position,...g.size,...g.rgba].some(x=>!Number.isFinite(x)||!Number.isFinite(Math.fround(x))||(x!==0&&Math.fround(x)===0)) ||
     rotation.some(x=>!Number.isFinite(x)||!Number.isFinite(Math.fround(x))) || position.some(x=>Math.abs(x)>1000000)) capacity=true;
  if(g.type==='sphere'||g.type==='box') geoms.push({type:g.type,size:[...g.size],position,rotation,rgba:[...g.rgba]});
 }
 if(capacity) throw new VisualCapacityError('Visual geometry exceeds supported bounds');
 if(unsupported) throw new UnsupportedVisualError('Unsupported geometry or material');
 return {tick:v.frame.tick,time:v.frame.time,geoms};
}
