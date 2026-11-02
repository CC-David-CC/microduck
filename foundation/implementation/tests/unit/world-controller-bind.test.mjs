import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {MessageChannel} from 'node:worker_threads';
import {setTimeout as delay} from 'node:timers/promises';
import {captureProjectInventory} from '../../src/projects/project-inventory.ts';
import {createMujocoWorldFromProject} from '../../src/simulation/mujoco-world.ts';
let binding={};
try { binding=await import('../../src/session/world-controller-bind.ts'); }
catch(error) { if(error?.code!=='ERR_MODULE_NOT_FOUND' || !String(error.message).includes('world-controller-bind.ts')) throw error; }
const api=()=>{
 assert.equal(typeof binding.prepareWorldControllerBindings,'function','prepareWorldControllerBindings must exist');
 assert.equal(typeof binding.bindWorldControllers,'function','bindWorldControllers must exist');
};
const digest=x=>createHash('sha256').update(x).digest('hex');
const enc=new TextEncoder();
const source='export function initialize(){}\nexport function step(){}\nexport function dispose(){}\n';
const fixture=new URL('../../../reports/v1-project-world-acceptance/fixtures/',import.meta.url);
const paths={'scene/main.xml':'13347dcf8dacd458ceed60d2b0a0a7d82a7c6ab65e2e38388464f0c4eefd81b4',
 'scene/parts/body.xml':'a687f36ed705c4f37fa4911ab485c5d112ada5cdb8c5d3b0238438f76f008620',
 'scene/assets/tetra.obj':'b391f08159e507ad3a0fa80558bdb046e150e38868378c9972072d54ad65f858',
 'scene/assets/two.png':'e6d66889131220f931fddfb05730d647a0992456c63ae0a8154b4ae32ff219ef'};
const oracleBytes=readFileSync(new URL('../../../reports/v1-hinge-measurement-preparation/ORACLES.json',import.meta.url));
assert.equal(digest(oracleBytes),'77712f94f47c1654a8ab410ed577bb9e205d42f4ac246f14a03e77f177c31534');
const base=JSON.parse(oracleBytes).vectors.find(row=>row.id==='base');
const limits={max_files:16,max_total_bytes:1048576,max_file_bytes:1048576,max_manifest_bytes:65536,max_manifest_depth:16};
const compile={closure:{max_files:16,max_total_bytes:1048576,max_references:64,max_include_depth:8,
 scan:{max_xml_bytes:1048576,max_depth:64,max_elements:10000,max_attributes_per_element:64,max_attribute_utf16:8192,max_references:64}},
 assets:{max_obj_bytes:65536,max_obj_line_bytes:8192,max_obj_vertices:1000,max_obj_faces:1000,max_obj_triangles:1000,
 max_obj_abs_coordinate:1000,max_png_bytes:65536,max_png_width:128,max_png_height:128,max_png_pixels:16384,max_png_decoded_bytes:50000,max_png_chunks:128},audit:{max_records:4096,max_bytes:1048576}};
const block=(name,index,unit)=>({actuator_name:name,engine_indices:[index],validation_rule_id:'independent-scalar-ranges',
 inputs:[{actuator_name:name,component:0,unit,semantic:'qualified unit-gear fixture input',input_range:null}]});
const worldProfile=()=>({blocks:[block('torque',0,'N m'),block('force',1,'N')],groups:[
 {group_id:'hinge',owner_id:'world-hinge-owner',control_stride:2,actuator_names:['torque']},
 {group_id:'slide',owner_id:'world-slide-owner',control_stride:3,actuator_names:['force']}],
 hinge_measurement:{joint_name:'angle',request:structuredClone(base.request)}});
async function project(note='one'){
 const entries=Object.entries(paths).map(([path,sha])=>{const data=new Uint8Array(readFileSync(new URL(path,fixture)));assert.equal(digest(data),sha);return {path,data};});
 entries.push({path:'controllers/main.mjs',data:enc.encode(source)});
 const files=Object.fromEntries(entries.map(({path,data})=>[path,{bytes:data.length,sha256:digest(data)}]));
 const manifest=enc.encode(JSON.stringify({schema_version:2,model:'scene/main.xml',note,files}));
 entries.push({path:'manifest.json',data:manifest});return captureProjectInventory(entries,limits);
}
async function worldAndInput(t){
 const inventory=await project();const {world}=await createMujocoWorldFromProject(inventory,worldProfile(),compile);
 t.after(()=>world.dispose());const channel=world.describeMeasurementChannel();
 const controllers=[{group_id:'hinge',source_path:'controllers/main.mjs',parameters:{gain:2},intent:{target:0},
  grants:[{channel_id:channel.id,definition_sha256:channel.definition_sha256}]},
 {group_id:'slide',source_path:'controllers/main.mjs',parameters:{gain:1},intent:{target:1},grants:[]}];
 return {inventory,world,controllers,channel};
}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function peer(group,{holdInitialize=false,failInitialize=false}={}){
 const data=new MessageChannel(),life=new MessageChannel(),entered=deferred(),messages=[];let first=null;
 data.port2.onmessage=e=>{const m=e.data;messages.push(m);
  if(m.kind==='initialize') {first=m;entered.resolve();if(!holdInitialize)respondInit();}
  else if(m.kind==='dispose')data.port2.postMessage({request_id:m.request_id,kind:'disposed'});
  else if(m.kind==='stage')data.port2.postMessage({request_id:m.request_id,kind:'stage',stageId:m.stageId,authority:m.authority,control:[2]});
  else if(m.kind==='commit')data.port2.postMessage({request_id:m.request_id,kind:'committed',stageId:m.stageId,authority:m.authority});
 };data.port2.start();
 life.port2.onmessage=e=>{const m=e.data;messages.push(m);if(m.kind==='terminate')life.port2.postMessage({version:1,kind:'termination-requested',request_id:m.request_id});};life.port2.start();
 function respondInit(){assert.ok(first);data.port2.postMessage(failInitialize?{request_id:first.request_id,kind:'error',code:'CONTROLLER_FAULT'}:{request_id:first.request_id,kind:'initialized'});}
 function close(){data.port1.close();data.port2.close();life.port1.close();life.port2.close();}
 return {row:{group_id:group,dataPort:data.port1,lifecyclePort:life.port1},messages,entered:entered.promise,respondInit,close};
}
async function within(p){return Promise.race([p,delay(3000).then(()=>{throw Error('test timeout');})]);}
function pending(p){let settled=false;void p.then(()=>settled=true,()=>settled=true);return ()=>settled;}

test('same-project controllers bind world-derived identity and leases only after all initialization ACKs',async t=>{
 api();const {inventory,world,controllers,channel}=await worldAndInput(t),before=world.inspect();
 const prepared=await binding.prepareWorldControllerBindings(inventory,world,controllers);
 assert.deepEqual(new Set(prepared.group_ids),new Set(['hinge','slide']));
 assert.equal(Object.hasOwn(prepared.handle,'world'),false);
 const hinge=peer('hinge',{holdInitialize:true}),slide=peer('slide');let supervisor;
 try{
  const bindingPromise=binding.bindWorldControllers(prepared.handle,[hinge.row,slide.row],500),settled=pending(bindingPromise);
  await within(Promise.all([hinge.entered,slide.entered]));await delay(10);assert.equal(settled(),false,'all runner ACKs must precede readiness');
  assert.deepEqual(world.inspect(),before);assert.equal(world.readMeasurement(),null);
  for(const [id,remote] of [['hinge',hinge],['slide',slide]]){
   const init=remote.messages.find(m=>m.kind==='initialize'),group=before.commands.groups.find(g=>g.lease.group_id===id);
   assert.deepEqual(init.identity,{...before.identity,group_id:id,owner_id:group.lease.owner_id,lease_generation:group.lease.generation});
   assert.equal(init.source,source);assert.equal(init.sourceId,'controllers/main.mjs');assert.equal(init.descriptor.group_id,id);
   assert.equal(init.descriptor.observations.length,id==='hinge'?1:0);
   if(id==='hinge')assert.equal(init.descriptor.observations[0].definition_sha256,channel.definition_sha256);
  }
  hinge.respondInit();supervisor=await within(bindingPromise);assert.equal(typeof supervisor.integrateBoundary,'function');
  await supervisor.integrateBoundary();assert.equal(world.inspect().plant.tick,1);
  assert.equal(hinge.messages.find(m=>m.kind==='stage').authority.run_epoch,before.identity.run_epoch);
  assert.ok(hinge.messages.find(m=>m.kind==='stage').observation.samples[channel.id]);
  assert.deepEqual(slide.messages.find(m=>m.kind==='stage').observation.samples,{});
  await assert.rejects(binding.bindWorldControllers(prepared.handle,[hinge.row,slide.row],500));
 }finally{if(supervisor)await supervisor.dispose();hinge.close();slide.close();}
});

test('rejects foreign project revision, missing or forged groups and unqualified measurement grants',async t=>{
 api();const {inventory,world,controllers}=await worldAndInput(t),other=await project('different'),before=world.inspect();
 await assert.rejects(binding.prepareWorldControllerBindings(other,world,controllers));
 await assert.rejects(binding.prepareWorldControllerBindings({...inventory},world,controllers));
 for(const mutate of [rows=>rows.pop(),rows=>rows[1].group_id='hinge',rows=>rows[0].group_id='unknown',
  rows=>rows[0].source_path='scene/main.xml',rows=>rows[0].grants[0].definition_sha256='0'.repeat(64),
  rows=>rows[0].grants[0].channel_id='not-world-measurement']){
  const rows=structuredClone(controllers);mutate(rows);await assert.rejects(binding.prepareWorldControllerBindings(inventory,world,rows));
 }
 assert.deepEqual(world.inspect(),before);assert.equal(world.readMeasurement(),null);
});

test('rejects missing, duplicate, unknown, or aliased port mappings before dispatch',async t=>{
 api();const {inventory,world,controllers}=await worldAndInput(t),before=world.inspect();
 for(const kind of ['missing','duplicate','unknown','alias']){
  const {handle}=await binding.prepareWorldControllerBindings(inventory,world,controllers);
  const a=peer('hinge'),b=peer('slide');
  try{
   let rows=[a.row,b.row];if(kind==='missing')rows=[a.row];
   if(kind==='duplicate')rows=[a.row,{...b.row,group_id:'hinge'}];
   if(kind==='unknown')rows=[a.row,{...b.row,group_id:'unknown'}];
   if(kind==='alias')rows=[a.row,{...b.row,dataPort:a.row.dataPort}];
   await assert.rejects(binding.bindWorldControllers(handle,rows,500));await delay(10);
   assert.deepEqual(a.messages,[]);assert.deepEqual(b.messages,[]);assert.deepEqual(world.inspect(),before);
  }finally{a.close();b.close();}
 }
});

test('a pending bind is single use and a runner initialization failure closes every started client',async t=>{
 api();const {inventory,world,controllers}=await worldAndInput(t),before=world.inspect();
 const {handle}=await binding.prepareWorldControllerBindings(inventory,world,controllers);
 const a=peer('hinge',{holdInitialize:true}),b=peer('slide',{failInitialize:true});
 try{
  const operation=binding.bindWorldControllers(handle,[a.row,b.row],500);const rejected=assert.rejects(operation);
  await within(Promise.all([a.entered,b.entered]));
  await assert.rejects(binding.bindWorldControllers(handle,[a.row,b.row],500));
  a.respondInit();await within(rejected);
  assert.ok(a.messages.some(m=>m.kind==='terminate'));assert.ok(b.messages.some(m=>m.kind==='terminate'));
  assert.deepEqual(world.inspect(),before);assert.equal(world.readMeasurement(),null);
 }finally{a.close();b.close();}
});
