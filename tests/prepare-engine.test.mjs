import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,copyFile,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const input=process.env.MICRODUCK_MUJOCO_NOEVAL;
if(!input)throw Error('Set MICRODUCK_MUJOCO_NOEVAL to the qualified artifact directory');
const script=fileURLToPath(new URL('../tools/prepare-engine.mjs',import.meta.url));
const expected={'mujoco.js':'694ad7aec441f15507f4392d3fac186d9f6e1e31de60fb6492f3fffab3989e29','mujoco.wasm':'a988f7b4a1b6a31a55b7b8a9cdca5c56930241f627766dddea860aaad742344a','mujoco.d.ts':'0c4aee031870765b67c52f8482ab8a2e4759a0df42dfc479b80d9f63a8d109c6'};
const hash=x=>createHash('sha256').update(x).digest('hex');
test('qualified engine stages exactly and modified input is rejected before writing',async()=>{
 const root=await mkdtemp(join(tmpdir(),'microduck-stage-engine-'));try{
  const tools=join(root,'tools'),dest=join(root,'node_modules','@mujoco','mujoco'),bad=join(root,'bad');
  await mkdir(tools,{recursive:true});await mkdir(dest,{recursive:true});await mkdir(bad);
  await copyFile(script,join(tools,'prepare-engine.mjs'));await writeFile(join(dest,'package.json'),JSON.stringify({name:'@mujoco/mujoco',version:'3.17.0'}));
  const run=path=>spawnSync(process.execPath,[join(tools,'prepare-engine.mjs')],{env:{...process.env,MICRODUCK_MUJOCO_NOEVAL:path},encoding:'utf8'});
  let result=run(input);assert.equal(result.status,0,result.stderr);
  for(const [name,want] of Object.entries(expected))assert.equal(hash(await readFile(join(dest,name))),want);
  for(const name of Object.keys(expected))await copyFile(join(input,name),join(bad,name));
  await writeFile(join(bad,'mujoco.d.ts'),'modified');
  result=run(bad);assert.notEqual(result.status,0);assert.match(result.stderr,/Unapproved MuJoCo artifact/);
  for(const [name,want] of Object.entries(expected))assert.equal(hash(await readFile(join(dest,name))),want);
 }finally{await rm(root,{recursive:true,force:true})}
});
