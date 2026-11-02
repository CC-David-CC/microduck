// Convert the retained, pinned Microduck source project into this app's
// explicit built-in adapter declaration. Never execute project code.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {MICRODUCK_SOURCE,MICRODUCK_SOURCE_PATH} from '../runner-loader.mjs';
const input=process.env.MICRODUCK_SOURCE_PROJECT, output=process.env.MICRODUCK_BUILTIN_PROJECT;
if(!input||!output)throw Error('MICRODUCK_SOURCE_PROJECT and MICRODUCK_BUILTIN_PROJECT required');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const bytes=await readFile(input);
if(bytes.length>67108864)throw Error('Source project too large');
const source=JSON.parse(bytes);
if(source.format!=='brf-project-experiment/1'||!Array.isArray(source.files)||!Array.isArray(source.records)||source.records.length)throw Error('Unexpected source project');
if(hash(JSON.stringify({format:source.format,files:source.files,records:source.records}))!==source.checksum)throw Error('Source checksum mismatch');
const files=new Map();
for(const row of source.files){
 if(typeof row.path!=='string'||typeof row.data_base64!=='string'||files.has(row.path))throw Error('Invalid source file');
 const b=Buffer.from(row.data_base64,'base64');
 if(b.toString('base64')!==row.data_base64)throw Error('Invalid source encoding');
 files.set(row.path,b);
}
const manifestBytes=files.get('manifest.json');
if(!manifestBytes||hash(manifestBytes)!=='29e6a4c5811980f7e5487e7e28395c94333d1ff8bcce3755c3eabf9972adb2c2')throw Error('Wrong source revision');
const manifest=JSON.parse(manifestBytes);
for(const [name,meta] of Object.entries(manifest.files)){
 const b=files.get(name);
 if(!b||b.length!==meta.bytes||hash(b)!==meta.sha256)throw Error('Source asset mismatch: '+name);
}
if(files.size!==Object.keys(manifest.files).length+1)throw Error('Unexpected source files');
if(hash(files.get('policies/alpha_walking.onnx'))!=='e36332d383997d51401897734cd3e79cf5038406feddb18b4d57ecfb141daa6c')throw Error('Wrong policy');
const old='controllers/lease-holder.mjs';
if(!files.delete(old)||!Object.hasOwn(manifest.files,old))throw Error('Missing source declaration');
delete manifest.files[old];
const controller=Buffer.from(MICRODUCK_SOURCE);
files.set(MICRODUCK_SOURCE_PATH,controller);
manifest.files[MICRODUCK_SOURCE_PATH]={bytes:controller.length,sha256:hash(controller)};
const experience=JSON.parse(files.get('experience.json'));
experience.welcome='Meet Microduck! Set a walk speed, then run or step the simulation.';
const exp=Buffer.from(JSON.stringify(experience));
files.set('experience.json',exp);
manifest.files['experience.json']={bytes:exp.length,sha256:hash(exp)};
manifest.title='Microduck';
const nextManifest=Buffer.from(JSON.stringify(manifest));
files.set('manifest.json',nextManifest);
const project={format:'brf-project-experiment/1',files:[...files].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,data])=>({path,data_base64:data.toString('base64')})),records:[]};
const result=Buffer.from(JSON.stringify({...project,checksum:hash(JSON.stringify(project))}));
await writeFile(output,result,{flag:'wx'});
console.log(JSON.stringify({sourceRevision:hash(manifestBytes),projectRevision:hash(nextManifest),projectHash:hash(result),bytes:result.length}));
