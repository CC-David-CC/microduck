// Compute the exact truth-channel definition from a captured, compiled project.
import {readFile} from 'node:fs/promises';
import {captureProjectInventory} from '../foundation/implementation/src/projects/project-inventory.ts';
import {createMujocoWorldFromProject} from '../foundation/implementation/src/simulation/mujoco-world.ts';
const path=process.env.MICRODUCK_BUILTIN_PROJECT;
if(!path)throw Error('MICRODUCK_BUILTIN_PROJECT required');
const fixture=JSON.parse(await readFile(path));
const profile=JSON.parse(await readFile(new URL('../microduck-profile.json',import.meta.url)));
const inventory=await captureProjectInventory(fixture.files.map(x=>({path:x.path,data:Uint8Array.from(Buffer.from(x.data_base64,'base64'))})),profile.policy.inventoryLimits);
const group=profile.profile.groups[0];
const {world}=await createMujocoWorldFromProject(inventory,{blocks:profile.profile.blocks,
 groups:[{...group,owner_id:'channel-inspection'}],microduck_truth:profile.profile.microduck_truth},profile.policy.compileLimits);
try{console.log(JSON.stringify({revision:inventory.project_revision,channel:world.describeMeasurementChannel(),definition:world.describeMeasurementDefinition()}))}finally{world.dispose()}
