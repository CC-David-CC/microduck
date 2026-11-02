// Stage the previously rebuilt, pinned strict-CSP MuJoCo package locally.
// Nothing here downloads or installs system-wide software.
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const input=process.env.MICRODUCK_MUJOCO_NOEVAL;
if(!input)throw Error('MICRODUCK_MUJOCO_NOEVAL must name the rebuilt MuJoCo directory');
const destination=resolve(root,'node_modules/@mujoco/mujoco');
if(await realpath(destination)!==destination)throw Error('MuJoCo destination must not be a symlink');
const manifest=JSON.parse(await readFile(resolve(destination,'package.json')));
if(manifest.name!=='@mujoco/mujoco'||manifest.version!=='3.17.0')throw Error('Unexpected MuJoCo package');
const expected={
 'mujoco.js':'694ad7aec441f15507f4392d3fac186d9f6e1e31de60fb6492f3fffab3989e29',
 'mujoco.wasm':'a988f7b4a1b6a31a55b7b8a9cdca5c56930241f627766dddea860aaad742344a',
 'mujoco.d.ts':'0c4aee031870765b67c52f8482ab8a2e4759a0df42dfc479b80d9f63a8d109c6'
};
const contents=[];
for(const [name,want] of Object.entries(expected)){
 const bytes=await readFile(resolve(input,name)),actual=createHash('sha256').update(bytes).digest('hex');
 if(actual!==want)throw Error('Unapproved MuJoCo artifact: '+name);
 contents.push([name,bytes]);
}
for(const [name,bytes] of contents)await writeFile(resolve(destination,name),bytes);
console.log(JSON.stringify({version:manifest.version,artifacts:expected}));
