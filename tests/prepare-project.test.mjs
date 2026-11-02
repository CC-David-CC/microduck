import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,copyFile,mkdir,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';
const space=process.env.MICRODUCK_SPACE_DIR,policy=process.env.MICRODUCK_POLICY;
if(!space||!policy)throw Error('MICRODUCK_SPACE_DIR and MICRODUCK_POLICY required');
const tool=new URL('../tools/prepare-builtin-project.mjs',import.meta.url).pathname;
const names=['bottom_head_shell.stl','hip_l.stl','jaw.stl','leg.stl','np_f970.stl','power_support.stl','sole_left.stl','sole_right.stl','top_head_shell.stl'];
const run=(source,out)=>spawnSync(process.execPath,[tool],{encoding:'utf8',env:{...process.env,MICRODUCK_SOURCE_PROJECT:'',MICRODUCK_SPACE_DIR:source,MICRODUCK_POLICY:policy,MICRODUCK_BUILTIN_PROJECT:out}});
test('reconstructs the exact pinned project without a previous test fixture',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'microduck-source-'));t.after(()=>rm(dir,{recursive:true,force:true}));const out=join(dir,'project.json'),p=run(space,out);
 assert.equal(p.status,0,p.stderr);const data=await readFile(out);
 assert.equal(createHash('sha256').update(data).digest('hex'),'b32639fc7783f4d1f249f17ed458faf8b9e65ab3cbbdbfdcd844179265a18a82');
});
test('rejects altered upstream mesh before producing a project',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'microduck-tamper-'));t.after(()=>rm(dir,{recursive:true,force:true}));const mesh=join(dir,'app/public/robot/mjlab/meshes');await mkdir(mesh,{recursive:true});
 for(const name of names)await copyFile(join(space,'app/public/robot/mjlab/meshes',name),join(mesh,name));
 await writeFile(join(mesh,names[0]),'tampered');
 const out=join(dir,'project.json'),p=run(dir,out);assert.notEqual(p.status,0);assert.match(p.stderr,/asset mismatch/i);await assert.rejects(readFile(out));
});
