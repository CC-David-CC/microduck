import * as THREE from 'three/webgpu';
import {copyBounded} from '../session/project-world-wire.ts';
import {createAttributedGeometries} from './three-attributed-geometry.ts';

/** Partial untextured display; it has no connection to simulation authority. */
export async function createAttributedDisplayRenderer(canvas:HTMLCanvasElement,options:{width:number;height:number}) {
  if(typeof HTMLCanvasElement==='undefined' || !(canvas instanceof HTMLCanvasElement) || !options ||
    !Number.isSafeInteger(options.width) || !Number.isSafeInteger(options.height) || options.width<1 || options.height<1 || options.width>2048 || options.height>2048)throw Error('Invalid display canvas');
  const {width,height}=options;
  const limitations=Object.freeze(['untextured','plane','box','sphere','capsule','ellipsoid','cylinder','sites','materials','textures','skybox','lighting']);
  canvas.setAttribute('aria-label','Partial untextured robot meshes; planes, primitives, sites, materials, textures, skybox and model lighting omitted');
  canvas.title='Partial untextured robot meshes; planes, primitives, sites, materials, textures, skybox and model lighting omitted';
  let device:any,renderer:any,lost=false;
  try {
    if(typeof navigator==='undefined' || !navigator.gpu)throw Error('adapter unavailable');
    const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('adapter unavailable');
    device=await adapter.requestDevice();
    if(device.lost && typeof device.lost.then==='function')void device.lost.then(()=>{lost=true;},()=>{lost=true;});
    renderer=new THREE.WebGPURenderer({canvas,antialias:true,alpha:false,device});
    if(!('_getFallback' in renderer))throw Error('unsupported Three renderer');
    renderer._getFallback=null;await renderer.init();
    if(lost || renderer.backend?.isWebGPUBackend!==true)throw Error('WebGPU backend unavailable');
    renderer.setPixelRatio(1);renderer.setSize(width,height,false);
  } catch(error) {
    try{if(renderer)await renderer.dispose();}catch{}
    try{if(device)device.destroy();}catch{}
    throw Error('WebGPU unavailable: '+String(error));
  }
  let world:any,camera:any;
  try {
    world=new THREE.Scene();world.background=new THREE.Color(0x111827);
    camera=new THREE.OrthographicCamera(-2,2,2,-2,0.01,100);camera.up.set(0,0,1);
    world.add(new THREE.AmbientLight(0xffffff,0.8));const light=new THREE.DirectionalLight(0xffffff,1.4);light.position.set(6,-8,10);world.add(light);
  } catch(error) {try{await renderer.dispose();}catch{}try{device.destroy();}catch{}throw error;}
  type Stage={group:any;resources:ReturnType<typeof createAttributedGeometries>;materials:any[]};
  let current:Stage|null=null,disposed=false,faulted=false,rendering=false,framed=false,disposal:Promise<void>|null=null;
  let sceneIdentity:{session_id:string;project_revision:string;run_epoch:number}|null=null,lastTick=-1;
  const exact=(v:any,keys:string[])=>!!v && typeof v==='object' && !Array.isArray(v) &&
    (Object.getPrototypeOf(v)===Object.prototype || Object.getPrototypeOf(v)===null) && Reflect.ownKeys(v).length===keys.length &&
    keys.every(k=>{const d=Object.getOwnPropertyDescriptor(v,k);return !!d && d.enumerable && Object.hasOwn(d,'value');});
  const count=(v:any)=>Number.isSafeInteger(v) && v>=0;
  const vector=(v:any,n:number)=>Array.isArray(v) && v.length===n && v.every((x:any)=>typeof x==='number' && Number.isFinite(x));
  function release(stage:Stage|null) {
    const failures:unknown[]=[];if(!stage)return failures;
    for(const material of stage.materials)try{material.dispose();}catch(error){failures.push(error);}
    try{stage.resources.dispose();}catch(error){failures.push(error);}return failures;
  }
  async function render(input:unknown):Promise<void> {
    if(disposed || lost || faulted || rendering)throw Error('Attributed display unavailable');
    rendering=true;
    try {
      if(!exact(input,['status','identity','tick','time','geoms','limitations','meshCatalog','meshAttributes']))throw Error('Invalid attributed scene');
      const raw=input as any,meta:any={};
      for(const key of ['status','identity','tick','time','geoms','limitations'])Object.defineProperty(meta,key,{value:Object.getOwnPropertyDescriptor(raw,key)!.value,enumerable:true});
      const data=copyBounded(meta,1048576);
      if(data.status!=='partial' || !exact(data.identity,['session_id','project_revision','run_epoch']) ||
        typeof data.identity.session_id!=='string' || !data.identity.session_id || typeof data.identity.project_revision!=='string' || !data.identity.project_revision ||
        !count(data.identity.run_epoch) || !count(data.tick) || typeof data.time!=='number' || !Number.isFinite(data.time) || data.time<0 ||
        !Array.isArray(data.geoms) || data.geoms.length>1024 || !Array.isArray(data.limitations))throw Error('Invalid attributed metadata');
      if(sceneIdentity && (data.identity.session_id!==sceneIdentity.session_id || data.identity.project_revision!==sceneIdentity.project_revision ||
        data.identity.run_epoch!==sceneIdentity.run_epoch || data.tick<lastTick))throw Error('Stale attributed scene');
      const joined=raw.meshAttributes;
      if(!exact(joined,['status','identity','meshes','geom_mesh_ids','limitations']) || joined.status!=='partial' ||
        !Array.isArray(joined.meshes) || Object.getPrototypeOf(joined.meshes)!==Array.prototype || joined.meshes.length>1024 ||
        Reflect.ownKeys(joined.meshes).length!==joined.meshes.length+1)throw Error('Invalid joined mesh data');
      const entries:any[]=[];
      for(let i=0;i<joined.meshes.length;i++){
        const d=Object.getOwnPropertyDescriptor(joined.meshes,String(i));
        if(!d || !d.enumerable || !Object.hasOwn(d,'value') || !exact(d.value,['id','positions','indices','normal','uv']) || d.value.id!==i)throw Error('Invalid joined mesh');
        entries.push({id:i,normal:d.value.normal,uv:d.value.uv});
      }
      const attrs={meshes:entries};
      const resources=createAttributedGeometries({mesh:{identity:data.identity,catalog:raw.meshCatalog},attributes:{identity:joined.identity,attributes:attrs}});
      let next:Stage;
      try{next={group:new THREE.Group(),resources,materials:[]};}catch(error){try{resources.dispose();}catch(failure){faulted=true;throw new AggregateError([error,failure],'Display staging cleanup failed');}throw error;}
      let fit:any=null;
      try {
        const low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity];
        for(const g of data.geoms) {
          if(!exact(g,['id','body_id','group','material_id','type','size','rgba','mesh_id','position','rotation']) || !count(g.id) || !count(g.body_id) ||
            !count(g.group) || g.group>=6 || !vector(g.position,3) || !vector(g.rotation,9) || !vector(g.size,3) || !vector(g.rgba,4))throw Error('Invalid attributed geometry');
          if(!['plane','sphere','capsule','ellipsoid','cylinder','box','mesh'].includes(g.type))throw Error('Invalid geometry type');
          if(g.type!=='mesh'){if(g.mesh_id!==null)throw Error('Invalid primitive binding');continue;}
          if(!count(g.mesh_id) || g.mesh_id>=resources.geometries.length || raw.meshCatalog.geom_mesh_ids[g.id]!==g.mesh_id)throw Error('Invalid mesh instance');
          const r=g.rotation,p=g.position;
          for(let x=0;x<3;x++)for(let y=0;y<3;y++){let dot=0;for(let k=0;k<3;k++)dot+=r[x*3+k]*r[y*3+k];if(Math.abs(dot-(x===y?1:0))>1e-8)throw Error('Invalid rotation');}
          const det=r[0]*(r[4]*r[8]-r[5]*r[7])-r[1]*(r[3]*r[8]-r[5]*r[6])+r[2]*(r[3]*r[7]-r[4]*r[6]);
          if(Math.abs(det-1)>1e-8)throw Error('Invalid rotation');
          const geometry=resources.geometries[g.mesh_id].geometry, material=new THREE.MeshStandardMaterial({color:0x9ca3af,roughness:0.8});
          next.materials.push(material);const mesh=new THREE.Mesh(geometry,material);mesh.matrixAutoUpdate=false;
          mesh.matrix.set(r[0],r[1],r[2],p[0],r[3],r[4],r[5],p[1],r[6],r[7],r[8],p[2],0,0,0,1);next.group.add(mesh);
          {const positions=raw.meshCatalog.meshes[g.mesh_id].positions;
            for(let i=0;i<positions.length;i+=3)for(let axis=0;axis<3;axis++){
              const x=p[axis]+r[axis*3]*positions[i]+r[axis*3+1]*positions[i+1]+r[axis*3+2]*positions[i+2];
              if(!Number.isFinite(x) || Math.abs(x)>1000000)throw Error('Invalid display extent');
              if(!framed){low[axis]=Math.min(low[axis],x);high[axis]=Math.max(high[axis],x);}
            }}
        }
        if(!framed && Number.isFinite(low[0])) {
          const center=low.map((v,i)=>(v+high[i])/2),radius=Math.hypot(...low.map((v,i)=>(high[i]-v)/2));
          if(!Number.isFinite(radius) || radius<=0)throw Error('Invalid display bounds');
          const vertical=radius*1.2/Math.min(1,width/height),horizontal=vertical*width/height,dist=radius*3,norm=Math.hypot(8,16,10);
          fit={center,vertical,horizontal,near:radius*.5,far:radius*5.5,eye:[center[0]+dist*8/norm,center[1]-dist*16/norm,center[2]+dist*10/norm]};
          if([...center,...fit.eye,vertical,horizontal,fit.near,fit.far].some(x=>!Number.isFinite(Math.fround(x))) ||
            Math.fround(vertical)===0 || Math.fround(horizontal)===0 || Math.fround(fit.near)===0 || Math.fround(fit.near)===Math.fround(fit.far) ||
            fit.eye.every((x:number,i:number)=>Math.fround(x)===Math.fround(center[i])))throw Error('Unrepresentable display camera');
        }
      } catch(error){const failures=release(next);if(failures.length){faulted=true;throw new AggregateError([error,...failures],'Display staging cleanup failed');}throw error;}
      const previous=current,old=fit?{left:camera.left,right:camera.right,top:camera.top,bottom:camera.bottom,near:camera.near,far:camera.far,position:camera.position.clone(),quaternion:camera.quaternion.clone()}:null;
      let removed=false;
      try {
        if(fit){camera.left=-fit.horizontal;camera.right=fit.horizontal;camera.top=fit.vertical;camera.bottom=-fit.vertical;camera.near=fit.near;camera.far=fit.far;camera.position.set(...fit.eye);camera.lookAt(...fit.center);camera.updateProjectionMatrix();}
        world.add(next.group);if(previous){world.remove(previous.group);removed=true;}await renderer.renderAsync(world,camera);if(lost)throw Error('WebGPU device lost');
      } catch(error) {
        const failures:unknown[]=[];try{world.remove(next.group);}catch(e){failures.push(e);}try{if(previous && removed)world.add(previous.group);}catch(e){failures.push(e);}
        if(old)try{Object.assign(camera,{left:old.left,right:old.right,top:old.top,bottom:old.bottom,near:old.near,far:old.far});camera.position.copy(old.position);camera.quaternion.copy(old.quaternion);camera.updateProjectionMatrix();}catch(e){failures.push(e);}
        failures.push(...release(next));if(!failures.length && !lost)try{await renderer.renderAsync(world,camera);}catch(e){failures.push(e);}
        if(lost || failures.length)faulted=true;if(failures.length)throw new AggregateError([error,...failures],'Display rollback failed');throw error;
      }
      if(fit)framed=true;current=next;sceneIdentity={...data.identity};lastTick=data.tick;
      const failures=release(previous);if(failures.length){faulted=true;throw new AggregateError(failures,'Display cleanup failed');}
    } finally {rendering=false;}
  }
  function dispose():Promise<void>{
    if(disposal)return disposal;if(rendering)return Promise.reject(Error('Display render in progress'));disposed=true;
    disposal=(async()=>{const failures:unknown[]=[];if(current){try{world.remove(current.group);}catch(e){failures.push(e);}failures.push(...release(current));current=null;}
      try{await renderer.dispose();}catch(e){failures.push(e);}try{device.destroy();}catch(e){failures.push(e);}if(failures.length)throw new AggregateError(failures,'Display disposal failed');})();return disposal;
  }
  return Object.freeze({render,dispose,limitations});
}
