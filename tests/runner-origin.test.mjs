import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,access,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const build=fileURLToPath(new URL('../tools/build-runner.mjs',import.meta.url));
test('runner builder rejects noncanonical or insecure app origins before creating output',async()=>{
 const root=await mkdtemp(join(tmpdir(),'microduck-origin-'));
 try{
  for(const [i,origin] of ['http://example.com','https://EXAMPLE.COM','https://example.com/','https://example.com:443','https://x_y.example','http://127.0.0.1','https://user@example.com','https://example.com:0'].entries()){
   const out=join(root,String(i));const r=spawnSync(process.execPath,[build],{encoding:'utf8',env:{...process.env,MICRODUCK_APP_ORIGIN:origin,MICRODUCK_POLICY:join(root,'missing'),MICRODUCK_RUNNER_OUT:out}});
   assert.notEqual(r.status,0,origin);assert.match(r.stderr,/Invalid app origin/,origin);await assert.rejects(access(out));
  }
 }finally{await rm(root,{recursive:true,force:true})}
});
