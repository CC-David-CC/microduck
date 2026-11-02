// Assemble the pinned upstream visual rig. This asset is inert display data;
// it does not alter the compiled project, its controller, or simulation state.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url)),source=process.env.MICRODUCK_SPACE_DIR,output=process.env.MICRODUCK_VISUAL_OUTPUT;
if(!source||!output)throw Error('MICRODUCK_SPACE_DIR and MICRODUCK_VISUAL_OUTPUT required');
const manifest=JSON.parse(await readFile(resolve(here,'microduck-visual-manifest.json'),'utf8'));
const dir=resolve(source,'app/public/robot/mjlab');
async function verified(path,expected){const b=await readFile(path);if(b.length!==expected.bytes||createHash('sha256').update(b).digest('hex')!==expected.sha256)throw Error('Visual source mismatch: '+path);return b}
const rig=JSON.parse(await verified(resolve(dir,'kinematics.json'),manifest.rig));
if(!Array.isArray(rig.bodies)||rig.bodies.length!==15||!manifest.meshes||Object.keys(manifest.meshes).length!==38)throw Error('Invalid visual rig');
const names=new Set(),used=new Set();
for(const body of rig.bodies){
 if(typeof body.name!=='string'||!body.name||names.has(body.name)||!Array.isArray(body.geoms)||body.geoms.length>32)throw Error('Invalid visual body');names.add(body.name);
 for(const geom of body.geoms){
  if(geom.type!=='mesh'||typeof geom.mesh!=='string'||!Object.hasOwn(manifest.meshes,geom.mesh)||
    ![geom.pos,geom.quat,geom.color].every((v,i)=>Array.isArray(v)&&v.length===[3,4,4][i]&&v.every(Number.isFinite)))throw Error('Invalid visual geometry');used.add(geom.mesh);
 }
}
if(used.size!==Object.keys(manifest.meshes).length)throw Error('Incomplete visual rig');
const meshes={};for(const name of Object.keys(manifest.meshes).sort()){
 if(!/^[a-z0-9_]+\.stl$/.test(name))throw Error('Invalid mesh path');meshes[name]=(await verified(resolve(dir,'meshes',name),manifest.meshes[name])).toString('base64');
}
const data=Buffer.from(JSON.stringify({schema_version:1,source_revision:manifest.upstream_revision,bodies:rig.bodies,meshes}));
if(data.length>8388608)throw Error('Visual asset budget exceeded');await writeFile(output,data,{flag:'wx'});console.log(JSON.stringify({bodies:names.size,meshes:used.size,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')}));
