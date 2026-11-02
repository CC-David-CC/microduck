import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {createHash} from 'node:crypto';
const source=process.env.MICRODUCK_SPACE_DIR;if(!source)throw Error('MICRODUCK_SPACE_DIR required');
const prepare=new URL('../tools/prepare-microduck-visual.mjs',import.meta.url).pathname;
const hash=b=>createHash('sha256').update(b).digest('hex');
test('pinned published visual rig packages all 38 authentic meshes and maps to simulation bodies',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'duck-visual-'));t.after(()=>rm(dir,{recursive:true,force:true}));const output=join(dir,'visual.json');
 await promisify(execFile)(process.execPath,[prepare],{env:{...process.env,MICRODUCK_VISUAL_OUTPUT:output}});
 const pack=JSON.parse(await readFile(output));assert.equal(pack.bodies.length,15);assert.equal(Object.keys(pack.meshes).length,38);
 const model=await readFile(new URL('../project-source/model.xml',import.meta.url),'utf8');
 for(const body of pack.bodies){assert.equal((model.match(new RegExp('<body\\s+name="'+body.name+'"','g'))??[]).length,1,body.name);for(const g of body.geoms)assert.ok(Object.hasOwn(pack.meshes,g.mesh),g.mesh)}
 for(const [name,encoded] of Object.entries(pack.meshes)){const original=await readFile(join(source,'app/public/robot/mjlab/meshes',name));assert.equal(hash(Buffer.from(encoded,'base64')),hash(original),name)}
});
test('changed published rig is rejected before generating an output',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'duck-visual-bad-'));t.after(()=>rm(dir,{recursive:true,force:true}));const rigDir=join(dir,'app/public/robot/mjlab');await mkdir(rigDir,{recursive:true});await writeFile(join(rigDir,'kinematics.json'),'{}');
 await assert.rejects(promisify(execFile)(process.execPath,[prepare],{env:{...process.env,MICRODUCK_SPACE_DIR:dir,MICRODUCK_VISUAL_OUTPUT:join(dir,'visual.json')}}));
 await assert.rejects(readFile(join(dir,'visual.json')));
});
