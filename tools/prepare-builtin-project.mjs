// Assemble the pinned derivative project from ordinary source and upstream
// assets. No imported source is executed; output is a generated build asset.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MICRODUCK_SOURCE,MICRODUCK_SOURCE_PATH} from '../runner-loader.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const space=process.env.MICRODUCK_SPACE_DIR, policy=process.env.MICRODUCK_POLICY, output=process.env.MICRODUCK_BUILTIN_PROJECT;
if(!space||!policy||!output)throw Error('MICRODUCK_SPACE_DIR, MICRODUCK_POLICY and MICRODUCK_BUILTIN_PROJECT required');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifestBytes=await readFile(resolve(root,'project-source/manifest.json'));
if(hash(manifestBytes)!=='0183b6ea156fbb779121ecdb9b4c0ee205cdfec652eb427c4326b1064868ac2a')throw Error('Project source manifest mismatch');
const manifest=JSON.parse(manifestBytes),files=new Map([['manifest.json',manifestBytes]]);
for(const [name,meta] of Object.entries(manifest.files)){
 let bytes;
 if(name===MICRODUCK_SOURCE_PATH)bytes=Buffer.from(MICRODUCK_SOURCE);
 else if(name==='policies/alpha_walking.onnx')bytes=await readFile(policy);
 else if(/^assets\/[a-z0-9_]+\.stl$/.test(name))bytes=await readFile(resolve(space,'app/public/robot/mjlab/meshes',name.slice(7)));
 else if(['model.xml','experience.json','targets.json'].includes(name))bytes=await readFile(resolve(root,'project-source',name));
 else throw Error('Unexpected project source path');
 if(bytes.length!==meta.bytes||hash(bytes)!==meta.sha256)throw Error('Project asset mismatch: '+name);
 files.set(name,bytes);
}
const project={format:'brf-project-experiment/1',files:[...files].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,data])=>({path,data_base64:data.toString('base64')})),records:[]};
const result=Buffer.from(JSON.stringify({...project,checksum:hash(JSON.stringify(project))}));
if(hash(result)!=='7bed18ccb5ee0da8d6939f8ce43fb4272fea35b82f357f0be4db92d28b4b63f2')throw Error('Generated project mismatch');
await writeFile(output,result,{flag:'wx'});
console.log(JSON.stringify({projectRevision:hash(manifestBytes),projectHash:hash(result),bytes:result.length}));
