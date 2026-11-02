import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {MessageChannel} from 'node:worker_threads';
import {setTimeout as delay} from 'node:timers/promises';
const encoder=new TextEncoder(),hash=x=>createHash('sha256').update(x).digest('hex');
const fixture=new URL('../../../reports/v1-project-world-acceptance/fixtures/',import.meta.url);
const oracleBytes=readFileSync(new URL('../../../reports/v1-hinge-measurement-preparation/ORACLES.json',import.meta.url));
assert.equal(hash(oracleBytes),'77712f94f47c1654a8ab410ed577bb9e205d42f4ac246f14a03e77f177c31534');
const oracle=JSON.parse(oracleBytes);
const base=oracle.vectors.find(x=>x.id==='base');
const files=['scene/main.xml','scene/parts/body.xml','scene/assets/tetra.obj','scene/assets/two.png'];
const source='export function initialize(){}\nexport function step(){}\nexport function dispose(){}\n';
const inventoryLimits={max_files:16,max_total_bytes:1048576,max_file_bytes:1048576,max_manifest_bytes:65536,max_manifest_depth:16};
const compileLimits={closure:{max_files:16,max_total_bytes:1048576,max_references:64,max_include_depth:8,scan:{max_xml_bytes:1048576,max_depth:64,max_elements:10000,max_attributes_per_element:64,max_attribute_utf16:8192,max_references:64}},assets:{max_obj_bytes:65536,max_obj_line_bytes:8192,max_obj_vertices:1000,max_obj_faces:1000,max_obj_triangles:1000,max_obj_abs_coordinate:1000,max_png_bytes:65536,max_png_width:128,max_png_height:128,max_png_pixels:16384,max_png_decoded_bytes:50000,max_png_chunks:128},audit:{max_records:4096,max_bytes:1048576}};
const block=(name,index,unit)=>({actuator_name:name,engine_indices:[index],validation_rule_id:'independent-scalar-ranges',inputs:[{actuator_name:name,component:0,unit,semantic:'qualified unit-gear fixture input',input_range:null}]});
const profile={blocks:[block('torque',0,'N m'),block('force',1,'N')],groups:[{group_id:'hinge',owner_id:'hinge-owner',control_stride:2,actuator_names:['torque']},{group_id:'slide',owner_id:'slide-owner',control_stride:3,actuator_names:['force']}],hinge_measurement:{joint_name:'angle',request:structuredClone(base.request)}};
const controllers=[{group_id:'hinge',source_path:'controllers/main.mjs',parameters:{},intent:{},grants:[{channel_id:'measure.angle',definition_sha256:base.measurement_sha256}]},{group_id:'slide',source_path:'controllers/main.mjs',parameters:{},intent:{},grants:[]}];
function stage(controlled=true){const entries=files.map(path=>({path,data:new Uint8Array(readFileSync(new URL(path,fixture)))}));entries.push({path:'controllers/main.mjs',data:encoder.encode(source)});const declared=Object.fromEntries(entries.map(({path,data})=>[path,{bytes:data.length,sha256:hash(data)}]));const manifest=encoder.encode(JSON.stringify({schema_version:2,model:'scene/main.xml',files:declared}));entries.push({path:'manifest.json',data:manifest});const sourceTuple=JSON.parse(base.source_json);sourceTuple[1]=hash(manifest);const measurementTuple=JSON.parse(base.measurement_json);measurementTuple[1]=hash(JSON.stringify(sourceTuple));const granted=structuredClone(controllers);granted[0].grants[0].definition_sha256=hash(JSON.stringify(measurementTuple));return {kind:'stage',request_id:'request-one',generation:3,entries,profile:structuredClone(profile),inventoryLimits,compileLimits,maxReplyBytes:1048576,...(controlled?{controllers:granted,runnerTimeoutMs:800}:{})};}
let serial=0;
async function worker(t){const previous=globalThis.self,received=[];let listener,closed=false;globalThis.self={postMessage(v){received.push(structuredClone(v));},close(){closed=true;},addEventListener(kind,fn){if(kind==='message')listener=fn;}};await import('../../src/session/project-world-worker.ts?controlled-test='+serial++);t.after(()=>{globalThis.self=previous;});return {received,emit(data){listener({data});},get closed(){return closed;}};}
async function until(fn){const deadline=Date.now()+3000;while(!fn()&&Date.now()<deadline)await delay(5);assert.ok(fn(),'expected worker message');return fn();}
function peer(group,{holdTick=null,failTick=null}={}) {
 const d=new MessageChannel(),l=new MessageChannel(),messages=[];let held=null;
 d.port2.onmessage=e=>{const m=e.data;messages.push(m);
  if(m.kind==='initialize')d.port2.postMessage({kind:'initialized',request_id:m.request_id});
  else if(m.kind==='dispose')d.port2.postMessage({kind:'disposed',request_id:m.request_id});
  else if(m.kind==='stage'){
   if(m.authority.observed_tick===holdTick){held=m;return;}
   if(m.authority.observed_tick===failTick){d.port2.postMessage({kind:'error',request_id:m.request_id,code:'CONTROLLER_FAULT'});return;}
   d.port2.postMessage({kind:'stage',request_id:m.request_id,stageId:m.stageId,authority:m.authority,control:[2]});
  }else if(m.kind==='commit')d.port2.postMessage({kind:'committed',request_id:m.request_id,stageId:m.stageId,authority:m.authority});
 };d.port2.start();l.port2.onmessage=e=>{const m=e.data;if(m.kind==='terminate')l.port2.postMessage({version:1,kind:'termination-requested',request_id:m.request_id});};l.port2.start();
 return {row:{group_id:group,dataPort:d.port1,lifecyclePort:l.port1},messages,release(){assert.ok(held);const m=held;held=null;d.port2.postMessage({kind:'stage',request_id:m.request_id,stageId:m.stageId,authority:m.authority,control:[2]});},close(){d.port1.close();d.port2.close();l.port1.close();l.port2.close();}};
}
async function ready(t,options={}){const w=await worker(t),msg=stage(),a=peer('hinge',options),b=peer('slide');w.emit(msg);await until(()=>w.received.find(x=>x.kind==='need-runners'));w.emit({kind:'bind-runners',request_id:msg.request_id,generation:msg.generation,ports:[a.row,b.row]});const out=await until(()=>w.received.find(x=>x.kind==='ready'));t.after(()=>{a.close();b.close();});return {w,msg,a,b,identity:out.identity};}
function step(s,id,sequence,count,identity=s.identity){return {kind:'step',request_id:id,generation:s.msg.generation,identity,command_sequence:sequence,steps:count};}
function stageRows(peer){return peer.messages.filter(row=>row.kind==='stage');}

test('steps one and then three real boundaries with independently checked held-input timing',async t=>{
 const s=await ready(t);s.w.emit(step(s,'step-one',1,1));const one=await until(()=>s.w.received.find(x=>x.kind==='stepped'&&x.request_id==='step-one'));
 assert.equal(one.generation,s.msg.generation);assert.deepEqual(one.identity,s.identity);assert.equal(one.command_sequence,1);assert.equal(one.steps_completed,1);assert.equal(one.inspection.plant.tick,1);assert.ok(Math.abs(one.inspection.plant.qpos[7]-oracle.trace[1].truth)<1e-12);
 s.w.emit(step(s,'step-three',2,3));const four=await until(()=>s.w.received.find(x=>x.kind==='stepped'&&x.request_id==='step-three'));
 assert.equal(four.command_sequence,2);assert.equal(four.steps_completed,3);assert.equal(four.inspection.plant.tick,4);assert.ok(Math.abs(four.inspection.plant.qpos[7]-oracle.trace[4].truth)<1e-12);
 assert.deepEqual(stageRows(s.a).map(x=>x.authority.observed_tick),[0,2]);assert.deepEqual(stageRows(s.b).map(x=>x.authority.observed_tick),[0,3]);
 assert.deepEqual(stageRows(s.a).map(x=>x.authority.sequence),[1,2]);assert.deepEqual(stageRows(s.b).map(x=>x.authority.sequence),[1,2]);
});

test('stale identity, wrong sequence and unsupported counts never dispatch controller work',async t=>{
 const s=await ready(t),bad=[step(s,'old-epoch',1,1,{...s.identity,run_epoch:s.identity.run_epoch+1}),step(s,'zero',1,0),step(s,'large',1,65),step(s,'fraction',1,1.5),step(s,'sequence',2,1)];
 for(const m of bad)s.w.emit(m);await delay(30);assert.equal(stageRows(s.a).length,0);assert.equal(stageRows(s.b).length,0);assert.equal(s.w.received.some(x=>x.kind==='stepped'),false);
 s.w.emit(step(s,'valid',1,1));const answer=await until(()=>s.w.received.find(x=>x.kind==='stepped'&&x.request_id==='valid'));assert.equal(answer.inspection.plant.tick,1);
 s.w.emit(step(s,'replay',1,1));await delay(30);assert.equal(stageRows(s.a).length,1);assert.equal(stageRows(s.b).length,1);assert.equal(s.w.received.some(x=>x.kind==='stepped'&&x.request_id==='replay'),false);
});

test('concurrent request during a held controller stage cannot dispatch a second boundary',async t=>{
 const s=await ready(t,{holdTick:0});s.w.emit(step(s,'held',1,1));await until(()=>stageRows(s.a).length===1);
 s.w.emit(step(s,'racing',2,1));await delay(25);assert.equal(stageRows(s.a).length,1);assert.equal(s.w.received.some(x=>x.kind==='stepped'),false);
 s.a.release();const first=await until(()=>s.w.received.find(x=>x.kind==='stepped'&&x.request_id==='held'));assert.equal(first.inspection.plant.tick,1);await delay(20);
 assert.equal(s.w.received.some(x=>x.kind==='stepped'&&x.request_id==='racing'),false);
});

test('controller fault reports only confirmed completed boundaries and never reports success',async t=>{
 const s=await ready(t,{failTick:2});s.w.emit(step(s,'fail-after-two',1,3));const failure=await until(()=>s.w.received.find(x=>x.kind==='step-error'&&x.request_id==='fail-after-two'));
 assert.equal(failure.generation,s.msg.generation);assert.deepEqual(failure.identity,s.identity);assert.equal(failure.command_sequence,1);assert.equal(failure.steps_completed,2);assert.equal(typeof failure.error,'string');assert.equal(s.w.received.some(x=>x.kind==='stepped'&&x.request_id==='fail-after-two'),false);
});

test('a separately granted measured step returns correlated rows',async t=>{
 const s=await ready(t),channel=s.msg.controllers[0].grants[0];
 const authority={...s.identity,group_id:'hinge',lease_generation:1,channel_id:channel.channel_id,definition_sha256:channel.definition_sha256};
 const grant={purpose:'measurement-recording',authority,max_entries:2},recording={authority,grant,attempt_token:'test-attempt'};
 s.w.emit({...step(s,'measured',1,2),recording});await delay(10);s.w.emit(step(s,'fallback',1,2));
 const result=await until(()=>s.w.received.find(x=>x.kind==='stepped'&&(x.request_id==='measured'||x.request_id==='fallback')));
 assert.equal(result.request_id,'measured','recording request was ignored and the normal step ran');
 assert.equal(result.inspection.plant.tick,2);assert.ok(Math.abs(result.inspection.plant.qpos[7]-oracle.trace[2].truth)<1e-12);
 const batch=result.measurement_batch;assert.ok(batch);assert.equal(batch.request_id,'measured');assert.equal(batch.generation,s.msg.generation);assert.equal(batch.command_sequence,1);assert.equal(batch.attempt_token,'test-attempt');assert.deepEqual(batch.authority,authority);assert.deepEqual(batch.rows.map(r=>r.observed_tick),[0,1]);assert.ok(batch.rows.every(r=>r.outcome==='completed'));
 const {validateMeasuredStepResponse}=await import('../../src/experiments/measured-step-response.ts');const expected={request_id:'measured',generation:s.msg.generation,command_sequence:1,identity:s.identity,start_tick:0,steps:2,attempt_token:'test-attempt',authority};
 const validated=validateMeasuredStepResponse(expected,grant,batch);assert.equal(validated.entries.length,2);assert.equal(validated.sealed,false);
});
test('a wrong recording grant is denied before controller work',async t=>{
 const s=await ready(t),channel=s.msg.controllers[0].grants[0],authority={...s.identity,group_id:'hinge',lease_generation:1,channel_id:channel.channel_id,definition_sha256:channel.definition_sha256};
 const grant={purpose:'controller-observation',authority,max_entries:1};s.w.emit({...step(s,'denied',1,1),recording:{authority,grant,attempt_token:'test-attempt'}});
 const error=await until(()=>s.w.received.find(x=>x.kind==='step-error'&&x.request_id==='denied'));assert.equal(error.steps_completed,0);assert.equal(stageRows(s.a).length,0);assert.equal(stageRows(s.b).length,0);
});

test('a measured controller failure retains confirmed rows and marks the uncertain boundary',async t=>{
 const s=await ready(t,{failTick:2}),channel=s.msg.controllers[0].grants[0],authority={...s.identity,group_id:'hinge',lease_generation:1,channel_id:channel.channel_id,definition_sha256:channel.definition_sha256};
 const grant={purpose:'measurement-recording',authority,max_entries:3};s.w.emit({...step(s,'measured-fault',1,3),recording:{authority,grant,attempt_token:'test-attempt'}});
 const error=await until(()=>s.w.received.find(x=>x.kind==='step-error'&&x.request_id==='measured-fault'));assert.equal(error.steps_completed,2);assert.ok(error.measurement_batch);assert.deepEqual(error.measurement_batch.rows.map(x=>x.observed_tick),[0,1,2]);assert.deepEqual(error.measurement_batch.rows.map(x=>x.outcome),['completed','completed','unknown']);assert.equal(s.w.received.some(x=>x.kind==='stepped'&&x.request_id==='measured-fault'),false);
});
