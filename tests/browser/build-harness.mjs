import {build} from 'esbuild';
import {writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url)),out=process.env.MICRODUCK_HARNESS_OUT;
if(!out)throw Error('MICRODUCK_HARNESS_OUT required');
await mkdir(out,{recursive:true});
await build({entryPoints:[resolve(here,'runner-entry.ts')],outfile:resolve(out,'index.js'),bundle:true,format:'esm',platform:'browser',target:'es2022'});
await writeFile(resolve(out,'index.html'),'<!doctype html><meta charset="utf-8"><script type="module" src="/index.js"></script>');
