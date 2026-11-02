import * as THREE from 'three/webgpu';
import {copyBounded} from '../session/project-world-wire.ts';

type ProjectedGeom={type:'sphere'|'box';size:number[];rgba:number[];matrix:number[]};
function exact(value:any,keys:string[]):boolean{return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));}
function vector(value:any,n:number):value is number[]{return Array.isArray(value)&&value.length===n&&value.every((x:any)=>typeof x==='number'&&Number.isFinite(x));}
/** Detached, bounded conversion from MuJoCo row-major world transforms.
 * This projection has no authority over a plant, controller or robot sensor. */
export function projectDisplaySnapshot(input:unknown):{tick:number;time:number;geoms:ProjectedGeom[]}{
 const v=copyBounded(input,1048576);
 if(!exact(v,['tick','time','geoms'])||!Number.isSafeInteger(v.tick)||v.tick<0||typeof v.time!=='number'||!Number.isFinite(v.time)||!Array.isArray(v.geoms)||v.geoms.length>1024)throw Error('Invalid display snapshot');
 const geoms:ProjectedGeom[]=[];
 for(const g of v.geoms){
  if(!exact(g,['type','size','position','rotation','rgba'])||(g.type!=='sphere'&&g.type!=='box')||!vector(g.size,3)||!vector(g.position,3)||!vector(g.rotation,9)||!vector(g.rgba,4)||g.size[0]<=0||(g.type==='box'&&(g.size[1]<=0||g.size[2]<=0))||g.rgba.some((x:number)=>x<0||x>1))throw Error('Unsupported or invalid display geometry');
  // Three.js uploads attributes and uniforms as float32. Reject overflow and
  // underflow of dimensions/positions/colors, including doubled box dimensions;
  // near-zero rotation coefficients may safely round to zero.
  const gpuSafe=(x:number)=>Number.isFinite(Math.fround(x))&&(x===0||Math.fround(x)!==0);
  if(![...g.size,...g.position,...g.rgba].every(gpuSafe)||!g.rotation.every((x:number)=>Number.isFinite(Math.fround(x)))||(g.type==='box'&&!g.size.every((x:number)=>gpuSafe(2*x))))throw Error('Display values exceed supported float32 range');
  const r=g.rotation;
  for(let a=0;a<3;a++)for(let b=0;b<3;b++){let dot=0;for(let k=0;k<3;k++)dot+=r[a*3+k]*r[b*3+k];if(Math.abs(dot-(a===b?1:0))>1e-8)throw Error('Invalid display rotation');}
  const determinant=r[0]*(r[4]*r[8]-r[5]*r[7])-r[1]*(r[3]*r[8]-r[5]*r[6])+r[2]*(r[3]*r[7]-r[4]*r[6]);
  if(Math.abs(determinant-1)>1e-8)throw Error('Invalid display rotation');
  const p=g.position;
  // Conservative bound on each transformed extent keeps fixed-camera
  // arithmetic far from float32 overflow; this is a display limitation.
  for(let axis=0;axis<3;axis++){
   let extent=g.size[0];if(g.type==='box'){extent=0;for(let k=0;k<3;k++)extent+=Math.abs(r[axis*3+k])*g.size[k];}
   if(!Number.isFinite(extent)||Math.abs(p[axis])+extent>1000000)throw Error('Display world extent exceeds supported range');
  }
  geoms.push({type:g.type,size:[...g.size],rgba:[...g.rgba],matrix:[r[0],r[1],r[2],p[0],r[3],r[4],r[5],p[1],r[6],r[7],r[8],p[2],0,0,0,1]});
 }
 return {tick:v.tick,time:v.time,geoms};
}
type CameraFit={left:number;right:number;top:number;bottom:number;near:number;far:number;eye:number[];target:number[]};
/** Conservatively enclose all supported geometry in a world-space AABB,
 * then enclose that box in a sphere for the fixed viewing direction. */
function fitDisplayCamera(geoms:ProjectedGeom[],width:number,height:number):CameraFit {
 const low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity];
 for(const geom of geoms){
  for(let axis=0;axis<3;axis++){
   const row=axis*4,position=geom.matrix[row+3];
   let extent=geom.size[0];
   if(geom.type==='box')extent=Math.abs(geom.matrix[row])*geom.size[0]+Math.abs(geom.matrix[row+1])*geom.size[1]+Math.abs(geom.matrix[row+2])*geom.size[2];
   const a=position-extent,b=position+extent;
   // If both ends round to the same float32 coordinate, the renderer cannot
   // reliably distinguish this extent from its translation on the GPU.
   if(!Number.isFinite(a)||!Number.isFinite(b)||!(a<b)||Math.fround(a)===Math.fround(b))throw Error('Display geometry is not representable at this position');
   low[axis]=Math.min(low[axis],a);high[axis]=Math.max(high[axis],b);
  }
 }
 const center=low.map((v,i)=>v+(high[i]-v)/2),half=low.map((v,i)=>(high[i]-v)/2);
 const radius=Math.hypot(...half),aspect=width/height,vertical=radius*1.1/Math.min(1,aspect),horizontal=vertical*aspect;
 const distance=radius*3,near=radius*0.5,far=radius*5.5,norm=Math.hypot(8,16,10);
 const eye=[center[0]+distance*8/norm,center[1]-distance*16/norm,center[2]+distance*10/norm];
 const values=[...center,...eye,radius,vertical,horizontal,near,far,2/(far-near),1/vertical,1/horizontal];
 if(!(radius>0 && near>0 && far>near && vertical>0 && horizontal>0) || values.some(v=>!Number.isFinite(v)||!Number.isFinite(Math.fround(v))) ||
    Math.fround(vertical)===0 || Math.fround(horizontal)===0 || Math.fround(near)===0 || Math.fround(near)===Math.fround(far) ||
    eye.every((v,i)=>Math.fround(v)===Math.fround(center[i]))) throw Error('Display camera is not representable');
 return {left:-horizontal,right:horizontal,top:vertical,bottom:-vertical,near,far,eye,target:center};
}
/** Independent presentation camera: no engine callbacks or observation access. */
export async function createDisplayRenderer(canvas:HTMLCanvasElement,options:{width:number;height:number}){
 if(typeof HTMLCanvasElement==='undefined'||!(canvas instanceof HTMLCanvasElement)||!options||!Number.isSafeInteger(options.width)||!Number.isSafeInteger(options.height)||options.width<1||options.height<1||options.width>2048||options.height>2048)throw Error('Invalid display canvas');
 const width=options.width,height=options.height;
 let device:any, renderer:any, deviceLost=false;
 try {
  if(typeof navigator==='undefined'||!navigator.gpu)throw Error('adapter unavailable');
  const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('adapter unavailable');
  device=await adapter.requestDevice();
  if(device.lost && typeof device.lost.then==='function') void device.lost.then(()=>{deviceLost=true;},()=>{deviceLost=true;});
  renderer=new THREE.WebGPURenderer({canvas,antialias:true,alpha:false,device});
  // Three 0.186.1 installs a WebGL fallback by default; this pinned boundary
  // disables it before initialization and rejects an unexpected backend.
  if(!('_getFallback' in renderer))throw Error('unsupported Three renderer');
  renderer._getFallback=null;
  await renderer.init();
  if(deviceLost)throw Error('device lost during initialization');
  if(renderer.backend?.isWebGPUBackend!==true)throw Error('unexpected backend');
  renderer.setPixelRatio(1);renderer.setSize(width,height,false);
 } catch(error) {
  try { if(renderer) await renderer.dispose(); } catch {}
  try { if(device) device.destroy(); } catch {}
  throw new Error('WebGPU unavailable: '+String(error));
 }
 let scene:any, camera:any;
 try {
  scene=new THREE.Scene();scene.background=new THREE.Color(0x111827);
  const extent=8,aspect=width/height;camera=new THREE.OrthographicCamera(-extent*aspect,extent*aspect,extent,-extent,0.01,1000);
  camera.up.set(0,0,1);camera.position.set(12,-16,10);camera.lookAt(4,0,0);camera.updateProjectionMatrix();
  scene.add(new THREE.AmbientLight(0xffffff,0.7));const light=new THREE.DirectionalLight(0xffffff,1.3);light.position.set(6,-8,10);scene.add(light);
 } catch(error) {
  try {await renderer.dispose();} catch {}
  try {device.destroy();} catch {}
  throw error;
 }
 let current:any=null,disposed=false,faulted=false,framed=false;
 let cameraTarget=[4,0,0];
 const cameraState=():CameraFit=>({left:camera.left,right:camera.right,top:camera.top,bottom:camera.bottom,near:camera.near,far:camera.far,eye:[camera.position.x,camera.position.y,camera.position.z],target:[...cameraTarget]});
 const applyCamera=(fit:CameraFit)=>{camera.left=fit.left;camera.right=fit.right;camera.top=fit.top;camera.bottom=fit.bottom;camera.near=fit.near;camera.far=fit.far;camera.position.set(...fit.eye);camera.lookAt(...fit.target);camera.updateProjectionMatrix();};
 function release(group:any):unknown[]{const errors:unknown[]=[];if(group)for(const mesh of group.children){try{mesh.geometry.dispose();}catch(error){errors.push(error);}try{mesh.material.dispose();}catch(error){errors.push(error);}}return errors;}
 let rendering=false;
 async function render(snapshot:unknown):Promise<void>{
  if(disposed)throw Error('Display renderer is disposed');
  if(deviceLost)throw Error('WebGPU device lost');
  if(faulted)throw Error('Display renderer is faulted');
  if(rendering)throw Error('Display render already in progress');
  rendering=true;
  try {
  const data=projectDisplaySnapshot(snapshot);
  const fit=!framed && data.geoms.length ? fitDisplayCamera(data.geoms,width,height) : null;
  const next=new THREE.Group();
  try{
   for(const geom of data.geoms){
    const geometry=geom.type==='box'?new THREE.BoxGeometry(2*geom.size[0],2*geom.size[1],2*geom.size[2]):new THREE.SphereGeometry(geom.size[0],24,16);
    let material:any;
    try{
     material=new THREE.MeshStandardMaterial({color:new THREE.Color().setRGB(geom.rgba[0],geom.rgba[1],geom.rgba[2]),opacity:geom.rgba[3],transparent:geom.rgba[3]<1,depthWrite:geom.rgba[3]===1});
     const mesh=new THREE.Mesh(geometry,material);mesh.matrixAutoUpdate=false;mesh.matrix.set(...geom.matrix);next.add(mesh);
    }catch(error){const failures:unknown[]=[];try{geometry.dispose();}catch(failure){failures.push(failure);}if(material)try{material.dispose();}catch(failure){failures.push(failure);}if(failures.length){faulted=true;throw new AggregateError([error,...failures],'Display staging failed: '+String(error));}throw error;}
   }
  }catch(error){const failures=release(next);if(failures.length){faulted=true;throw new AggregateError([error,...failures],'Display staging cleanup failed: '+String(error));}throw error;}
  const previous=current, priorCamera=fit?cameraState():null;
  let previousRemoved=false;
  try {if(fit)applyCamera(fit);scene.add(next);if(previous){scene.remove(previous);previousRemoved=true;}await renderer.renderAsync(scene,camera);if(deviceLost)throw Error('WebGPU device lost');}
  catch(error){const failures:unknown[]=[];try{scene.remove(next);}catch(failure){failures.push(failure);}try{if(previous && previousRemoved)scene.add(previous);}catch(failure){failures.push(failure);}if(priorCamera)try{applyCamera(priorCamera);}catch(failure){failures.push(failure);}failures.push(...release(next));if(!failures.length && !deviceLost)try{await renderer.renderAsync(scene,camera);}catch(failure){failures.push(failure);}if(deviceLost)faulted=true;if(failures.length){faulted=true;throw new AggregateError([error,...failures],'Display rollback failed: '+String(error));}throw error;}
  if(fit){cameraTarget=[...fit.target];framed=true;}
  current=next;const failures=release(previous);if(failures.length){faulted=true;throw new AggregateError(failures,'Display cleanup failed');}
  } finally {rendering=false;}
 }
 let disposal:Promise<void>|null=null;
 function dispose():Promise<void>{
  if(disposal)return disposal;
  if(rendering)return Promise.reject(Error('Display render in progress'));
  disposed=true;
  disposal=(async()=>{const failures:unknown[]=[];if(current){try{scene.remove(current);}catch(error){failures.push(error);}failures.push(...release(current));current=null;}try{await renderer.dispose();}catch(error){failures.push(error);}try{device.destroy();}catch(error){failures.push(error);}if(failures.length)throw new AggregateError(failures,'Display disposal cleanup failed');})();
  return disposal;
 }
 return Object.freeze({render,dispose});
}
