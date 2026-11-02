import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
import {captureProjectInventory} from '../foundation/implementation/src/projects/project-inventory.ts';import {createMujocoWorldFromProject} from '../foundation/implementation/src/simulation/mujoco-world.ts';
import {microduckTruthDefinitionHash} from '../foundation/implementation/src/observations/microduck-truth-channel.ts';
const path=process.env.MICRODUCK_BUILTIN_PROJECT;if(!path)throw Error('MICRODUCK_BUILTIN_PROJECT required');
const f=JSON.parse(await readFile(path)),profile=JSON.parse(await readFile(new URL('../microduck-profile.json',import.meta.url)));
// Independent canonical encoding witness, implemented with Node's Buffer and SHA-256.
function canonical(v){if(v===null)return ['null'];if(typeof v==='string')return ['string',v];if(typeof v==='boolean')return ['boolean',v];if(typeof v==='number'){const b=Buffer.alloc(8);b.writeDoubleBE(v);return ['f64',b.toString('hex')]}if(Array.isArray(v))return ['array',v.map(canonical)];return ['object',Object.keys(v).sort().map(k=>[k,canonical(v[k])])]}
async function world(){const inventory=await captureProjectInventory(f.files.map(x=>({path:x.path,data:Uint8Array.from(Buffer.from(x.data_base64,'base64'))})),profile.policy.inventoryLimits);const group={...profile.profile.groups[0],owner_id:'definition-test'};return (await createMujocoWorldFromProject(inventory,{blocks:profile.profile.blocks,groups:[group],microduck_truth:profile.profile.microduck_truth},profile.policy.compileLimits)).world}
test('compiled world exposes an immutable copy of the exact truth definition and timing stages',async()=>{
 const w=await world();try{const before=w.inspect(),definition=w.describeMeasurementDefinition(),channel=w.describeMeasurementChannel();
  assert.equal(definition.project_revision,before.identity.project_revision);assert.equal(definition.id,channel.id);assert.equal(definition.layout.reduce((n,x)=>n+x.size,0),35);
  assert.deepEqual(definition.layout.map(x=>x.stage),['initial-forward-or-post-step-pre-forward','initial-forward-or-post-step-pre-forward','current-qpos','current-qvel']);
  assert.equal(definition.source.joint_names.length,14);assert.equal(await microduckTruthDefinitionHash(definition),channel.definition_sha256);
  assert.equal(createHash('sha256').update(JSON.stringify(canonical(definition))).digest('hex'),channel.definition_sha256);
  definition.source.joint_names[0]='changed';assert.notEqual(w.describeMeasurementDefinition().source.joint_names[0],'changed');assert.deepEqual(w.inspect(),before);
 }finally{await w.dispose()}
});
test('definition hashing rejects accessor-backed and nonfinite source data',async()=>{
 const w=await world();try{const def=w.describeMeasurementDefinition(),changed=structuredClone(def);changed.layout[0].size=4;assert.notEqual(await microduckTruthDefinitionHash(changed),w.describeMeasurementChannel().definition_sha256);
  const accessor=structuredClone(def);let calls=0;Object.defineProperty(accessor,'id',{enumerable:true,get(){calls++;return 'x'}});await assert.rejects(microduckTruthDefinitionHash(accessor));assert.equal(calls,0);
  const nonfinite=structuredClone(def);nonfinite.layout[0].size=NaN;await assert.rejects(microduckTruthDefinitionHash(nonfinite));
 }finally{await w.dispose()}
});
