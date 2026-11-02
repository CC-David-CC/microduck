import {build} from 'esbuild';
import {writeFile,mkdir,readFile,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../..'),out=process.env.MICRODUCK_LIVE_APP_OUT;
if(!out)throw Error('MICRODUCK_LIVE_APP_OUT required');
const engine=resolve(root,'node_modules/@mujoco/mujoco');
const hash=x=>createHash('sha256').update(x).digest('hex');
if(hash(await readFile(resolve(engine,'mujoco.js')))!=='694ad7aec441f15507f4392d3fac186d9f6e1e31de60fb6492f3fffab3989e29'||hash(await readFile(resolve(engine,'mujoco.wasm')))!=='a988f7b4a1b6a31a55b7b8a9cdca5c56930241f627766dddea860aaad742344a')throw Error('Strict-CSP engine not prepared');
await mkdir(resolve(out,'workers'),{recursive:true});
await mkdir(resolve(out,'assets'),{recursive:true});
const manifest=JSON.parse(await readFile(resolve(root,'app.json'),'utf8'));
const engineJs=resolve(engine,'mujoco.js');
const plugin={name:'browser-only-mujoco',setup(api){api.onLoad({filter:/mujoco\.js$/},async args=>{
 if(resolve(args.path)!==engineJs)throw Error('Unexpected MuJoCo module');
 let content=await readFile(engineJs,'utf8');
 if(hash(content)!==manifest.patches[0].sha256)throw Error('Unapproved MuJoCo glue');
 for(const patch of manifest.patches){if(content.split(patch.find).length!==2)throw Error('MuJoCo patch mismatch');content=content.replace(patch.find,patch.replace)}
 return {contents:content,loader:'js',resolveDir:engine};
})}};
const common={bundle:true,format:'esm',platform:'browser',target:'es2022',logLevel:'silent',plugins:[plugin],metafile:true};
await build({...common,entryPoints:[resolve(here,'live-app-entry.ts')],outfile:resolve(out,'index.js')});
await build({...common,entryPoints:[resolve(root,'foundation/implementation/src/session/project-world-worker.ts')],outfile:resolve(out,'workers/world.mjs')});
await copyFile(resolve(engine,'mujoco.wasm'),resolve(out,'assets/mujoco.wasm'));
if(process.env.MICRODUCK_BUILTIN_PROJECT)await copyFile(process.env.MICRODUCK_BUILTIN_PROJECT,resolve(out,'microduck-project.json'));
await writeFile(resolve(out,'index.html'),'<!doctype html><meta charset="utf-8"><main id="app"></main><script type="module" src="/index.js"></script>');
