import * as THREE from 'three';
import {STLLoader} from 'three/addons/loaders/STLLoader.js';
import {bindPublishedDuckRig,projectPublishedDuckFrame} from './published-duck-pose.ts';

const expectedHash='ee72047f7773cf2c9ae4f975db38921947bc11a4cb3ef242ed25227d6a452abd';
const hex=(bytes:Uint8Array)=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
/** Display-only rendering of the pinned upstream mesh rig on current world poses. */
export function createPublishedDuckView(canvas:HTMLCanvasElement,assetURL:string){
 let disposed=false,scene:any,renderer:any,camera:any,bodies:Map<string,any>,rig:any[],boundModel:any,binding:any,geometries:any[]=[],materials:any[]=[];
 let initializing:Promise<void>|null=null;const abort=new AbortController();
 async function init(){
  const response=await fetch(assetURL,{signal:abort.signal,credentials:'same-origin'});
  if(!response.ok)throw Error('Microduck visuals unavailable');
  const buffer=await response.arrayBuffer();if(buffer.byteLength>8388608||hex(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)))!==expectedHash)throw Error('Microduck visual asset mismatch');
  if(disposed)throw Error('Microduck view disposed');
  const pack=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer));
  if(pack.schema_version!==1||pack.source_revision!=='ad9d41a763f30dc770817c33d92dcfec0205db1e'||!Array.isArray(pack.bodies)||pack.bodies.length!==15||!pack.meshes||Object.keys(pack.meshes).length!==38)throw Error('Invalid Microduck visual asset');
  rig=pack.bodies;const loader=new STLLoader(),meshes=new Map<string,any>();
  for(const [name,encoded] of Object.entries(pack.meshes)){
   if(typeof encoded!=='string')throw Error('Invalid Microduck mesh');const raw=atob(encoded),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
   const geometry=loader.parse(bytes.buffer);geometry.computeVertexNormals();meshes.set(name,geometry);geometries.push(geometry);
  }
  if(disposed)throw Error('Microduck view disposed');
  renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false,preserveDrawingBuffer:true});renderer.setPixelRatio(1);renderer.setSize(740,410,false);
  renderer.outputColorSpace=THREE.SRGBColorSpace;scene=new THREE.Scene();scene.background=new THREE.Color(0xe4f2f2);
  camera=new THREE.PerspectiveCamera(28,740/410,0.01,25);camera.up.set(0,0,1);
  scene.add(new THREE.HemisphereLight(0xffffff,0x76837c,2.2));const sun=new THREE.DirectionalLight(0xffffff,2.1);sun.position.set(1,-2,3);scene.add(sun);
  const groundGeometry=new THREE.PlaneGeometry(8,8),groundMaterial=new THREE.MeshStandardMaterial({color:0xb9d4c9,roughness:1});geometries.push(groundGeometry);materials.push(groundMaterial);
  const ground=new THREE.Mesh(groundGeometry,groundMaterial);ground.position.z=-0.002;scene.add(ground);bodies=new Map();
  for(const body of rig){
   const group=new THREE.Group();bodies.set(body.name,group);scene.add(group);
   for(const geom of body.geoms){
    const geometry=meshes.get(geom.mesh);if(!geometry)throw Error('Missing Microduck mesh');
    const color=geom.color,material=new THREE.MeshStandardMaterial({color:new THREE.Color(color[0],color[1],color[2]),roughness:0.75,metalness:0.05});materials.push(material);
    const mesh=new THREE.Mesh(geometry,material),q=geom.quat;mesh.position.set(...geom.pos);mesh.quaternion.set(q[1],q[2],q[3],q[0]).normalize();group.add(mesh);
   }
  }
 }
 async function draw(model:any,frame:any){
  if(disposed)throw Error('Microduck view disposed');initializing??=init();await initializing;if(disposed)throw Error('Microduck view disposed');
  if(boundModel!==model){binding=bindPublishedDuckRig(rig,model);boundModel=model;}
  const poses=projectPublishedDuckFrame(binding,frame);
  for(const pose of poses){const group=bodies.get(pose.name),q=pose.quaternion;if(!group)throw Error('Missing Microduck body');group.position.set(...pose.position);group.quaternion.set(q[1],q[2],q[3],q[0]);}
  const trunk=poses.find(p=>p.name==='trunk_base');if(!trunk)throw Error('Missing Microduck trunk');const [x,y]=trunk.position;
  camera.position.set(x+0.38,y-0.78,0.42);camera.lookAt(x,y,0.16);renderer.render(scene,camera);
 }
 function dispose(){if(disposed)return;disposed=true;abort.abort();for(const g of geometries)g.dispose();for(const m of materials)m.dispose();renderer?.dispose();geometries=[];materials=[];}
 return Object.freeze({draw,dispose});
}
