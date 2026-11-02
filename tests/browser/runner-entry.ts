// Chromium-only test harness. This is not imported by the desktop app.
import {openRunnerFrame} from '../../foundation/implementation/src/isolation/runner-host.ts';
import {connectRunner} from '../../foundation/implementation/src/isolation/runner-client.ts';
import {MICRODUCK_SOURCE,MICRODUCK_SOURCE_PATH} from '../../runner-loader.mjs';
declare global {interface Window {runMicroduckRunner(samples:any[],source?:string):Promise<any>}}
window.runMicroduckRunner=async(samples,source=MICRODUCK_SOURCE)=>{
 const identity={session_id:'browser-test',project_revision:'a'.repeat(64),run_epoch:0};
 const frame=await openRunnerFrame({mount:document.body,runnerOrigin:'http://127.0.0.1:19683',frameURL:'http://127.0.0.1:19683/frame',timeoutMs:15000});
 let client:Awaited<ReturnType<typeof connectRunner>>|null=null;
 try {
  client=await connectRunner({...frame,source,sourceId:MICRODUCK_SOURCE_PATH,identity,groupId:'all',ownerId:'policy',leaseGeneration:1,timeoutMs:15000});
  await client.initialize({group_id:'all',control_size:14,inputs:Array.from({length:14},()=>({})),control_stride:4,observations:[]},{});
  const controls=[];
  for(let n=0;n<samples.length;n++){
   const sample=samples[n],tick=sample.capture_tick;
   const observation={...identity,tick,sim_time:tick*.005,dt:.005,samples:{'microduck.truth':sample}};
   const stage=await client.stage({observation,intent:{speed:.25},sequence:n+1,applyTick:tick});
   controls.push(stage.control);
   try {await client.commit(stage.stageId);} catch (error) {throw Error('commit '+n+': '+String(error));}
  }
  return controls;
 } finally {
  if(client)try{await client.close()}catch{}
  await frame.close();
 }
};
