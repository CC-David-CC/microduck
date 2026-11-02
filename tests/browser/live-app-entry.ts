// Standalone integration harness for the actual project application.
import {mountProjectApplication} from '../../foundation/implementation/src/web/project-application.ts';
import profile from '../../microduck-profile.json';
const revision='0183b6ea156fbb779121ecdb9b4c0ee205cdfec652eb427c4326b1064868ac2a';
const root=document.getElementById('app')!;
const decision={project_revision:revision,...profile,runnerOrigin:'http://127.0.0.1:19683',frameURL:'http://127.0.0.1:19683/frame',policy:{...profile.policy,wasmUrl:'/assets/mujoco.wasm'}};
const app=mountProjectApplication({root,chooseDirectory:()=>Promise.reject(new Error('No folder picker in harness')),folderLimits:{max_files:512,max_file_bytes:16777216,max_total_bytes:67108864,max_depth:32,max_path_length:240},inventoryLimits:decision.policy.inventoryLimits,resolveTrusted:(r:string)=>r===revision?decision:null});

// Test-only entrypoint for the host's built-in project loader.
(window as any).loadBuiltInProject=async()=>{
 const response=await fetch('/microduck-project.json');
 if(!response.ok)throw Error('Built-in project unavailable');
 const file=new File([await response.arrayBuffer()],'microduck.brf',{type:'application/json'});
 return (app as any).openFile(file);
};

(window as any).captureBuiltInProject=async()=>{
 const snapshot=await (app as any).captureFile();
 const data=JSON.parse(await snapshot.blob.text());
 return {current:snapshot.isCurrent(),format:data.format,records:data.records.map((x:any)=>x.id)};
};
