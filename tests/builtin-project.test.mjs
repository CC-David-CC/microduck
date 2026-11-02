import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {decodeExperimentFile} from '../foundation/implementation/src/projects/experiment-file.ts';
import {MICRODUCK_SOURCE,MICRODUCK_SOURCE_PATH} from '../runner-loader.mjs';
const path=process.env.MICRODUCK_BUILTIN_PROJECT;
if(!path)throw Error('MICRODUCK_BUILTIN_PROJECT is required');
const input=await readFile(path);
const inventoryLimits={max_files:128,max_total_bytes:33554432,max_file_bytes:8388608,max_manifest_bytes:262144,max_manifest_depth:16};
test('built-in project is an independently verified Microduck package with an explicit adapter',async()=>{
 const result=await decodeExperimentFile(new Blob([input]),{max_bundle_bytes:67108864,max_records:8,max_record_bytes:1048576,max_total_record_bytes:2097152,inventory:inventoryLimits});
 assert.equal(result.records.length,0);
 assert.equal(await result.inventory.files[MICRODUCK_SOURCE_PATH].content.text(),MICRODUCK_SOURCE);
 assert.equal(result.inventory.files['policies/alpha_walking.onnx'].sha256,'e36332d383997d51401897734cd3e79cf5038406feddb18b4d57ecfb141daa6c');
 assert.equal(result.inventory.envelope.document.data.initial_keyframe,'STAND');
 assert.equal(result.inventory.envelope.document.data.model,'model.xml');
 assert.ok(result.inventory.files['assets/sole_left.stl']);
 assert.ok(result.inventory.files['assets/sole_right.stl']);
});

test('truth grant matches the actual compiled project revision',async()=>{
 const {execFile}=await import('node:child_process');
 const {promisify}=await import('node:util');
 const profile=JSON.parse(await readFile(new URL('../microduck-profile.json',import.meta.url)));
 const result=await promisify(execFile)(process.execPath,[new URL('../tools/inspect-builtin-channel.mjs',import.meta.url).pathname],{env:{...process.env,MICRODUCK_BUILTIN_PROJECT:path}});
 const report=JSON.parse(result.stdout);
 assert.equal(report.revision,'5ead0e42f7e44efb865941852fc8ecf93f8348ae4f1f48d2b27808713ff989d6');
 assert.equal(report.channel.definition_sha256,profile.controllers[0].grants[0].definition_sha256);
 assert.equal(report.channel.definition_sha256,profile.policy.approvedGrants[0].definition_sha256);
 const recording=profile.policy.approvedRecordingGrants[0];assert.equal(recording.project_revision,report.revision);assert.equal(recording.group_id,'all');assert.equal(recording.max_entries,64);
 assert.deepEqual(recording.channel,report.channel);assert.deepEqual(recording.definition,report.definition);

});
