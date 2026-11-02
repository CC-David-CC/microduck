import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const app=process.env.MICRODUCK_LIVE_APP_OUT,runner=process.env.MICRODUCK_RUNNER_OUT,
 project=process.env.MICRODUCK_BUILTIN_PROJECT,evidence=process.env.MICRODUCK_LIVE_EVIDENCE;
if(!app||!runner||!project||!evidence)throw Error('Live app, runner, project and evidence paths required');
const ref=JSON.parse(await readFile(root+'tests/fixtures/policy-reference.json')).forward.at(-1);
const server=spawn('python3',[fileURLToPath(new URL('./runner-test-server.py',import.meta.url))],{env:{...process.env,BRF_APP_DIST:app,BRF_RUNNER_DIST:runner,BRF_REQUEST_LOG:evidence+'.requests.jsonl'},stdio:'ignore'});
let browser;
try{
 for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('Server exited');try{if((await fetch('http://127.0.0.1:19682/')).ok)break}catch{}if(i===99)throw Error('Server unavailable');await new Promise(r=>setTimeout(r,100))}
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-features=Vulkan','--use-vulkan=swiftshader']});
 const page=await browser.newPage({viewport:{width:1200,height:900}}),errors=[];
 page.on('pageerror',e=>errors.push(String(e)));
 await page.addInitScript(()=>{
  window.__testEvents=[];window.__testCommands=[];
  const Original=window.Worker;
  window.Worker=class extends Original{
   constructor(...args){super(...args);this.addEventListener('message',e=>{if(['ready','stepped','error','disposed'].includes(e.data?.kind))window.__testEvents.push(structuredClone(e.data))})}
   postMessage(value,...args){if(value?.kind)window.__testCommands.push(value.kind);return super.postMessage(value,...args)}
  };
 });
 await page.goto('http://127.0.0.1:19682/');
 await page.locator('[data-brf=project-file-input]').setInputFiles(project);
 await page.waitForFunction(()=>document.querySelector('[data-brf=project-overview]')?.textContent?.includes('Microduck'),null,{timeout:30000});
 await page.locator('[data-brf=app-start]').click();
 await page.waitForFunction(()=>/Project open|Project start failed|cleanup failed/i.test(document.querySelector('[data-brf=app-status]')?.textContent??''),null,{timeout:90000});
 const status=await page.locator('[data-brf=app-status]').textContent();
 if(!status.includes('Project open.'))throw Error('Opening failed: '+JSON.stringify({status,events:await page.evaluate(()=>window.__testEvents)}));
 await page.locator('[data-brf=show-simple-duck]').waitFor({state:'visible'});
 await page.locator('[data-brf=show-simple-duck]').click();
 await page.waitForFunction(()=>/Simple duck, step 0/.test(document.querySelector('[data-brf=schematic-status]')?.textContent??''),null,{timeout:30000});
 await page.locator('[data-brf=schematic-canvas]').screenshot({path:evidence+'.initial.png'});
 await page.locator('[data-brf=target-row]').first().locator('[data-brf=target-value]').fill('0.25');
 await page.locator('[data-brf=target-row]').first().locator('[data-brf=target-set]').click();
 await page.waitForFunction(()=>/Target request accepted/.test(document.querySelector('[data-brf=target-feedback]')?.textContent??''));
 const before=await page.evaluate(()=>window.__testCommands.slice());
 await page.getByRole('button',{name:'Hardware tuning mode'}).click();
 await page.getByRole('button',{name:'Game mode'}).click();
 const after=await page.evaluate(()=>window.__testCommands.slice());
 if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Switching modes sent world commands');
 await page.getByRole('button',{name:'Hardware tuning mode'}).click();
 const hash=b=>createHash('sha256').update(b).digest('hex');
 await page.locator('[data-brf=research-attempt-ticks]').fill('400');
 await page.locator('[data-brf=research-attempt-config]').fill(hash(await readFile(root+'microduck-profile.json')));
 await page.locator('[data-brf=research-attempt-runtime]').fill(hash(await readFile(app+'/assets/mujoco.wasm')));
 await page.locator('[data-brf=research-attempt-plan]').click();
 await page.locator('[data-brf=research-attempt-start]').click();
 await page.waitForFunction(()=>/Attempt (completed|failed|cancelled|deadline|unknown)/i.test(document.querySelector('[data-brf=research-attempt-status]')?.textContent??''),null,{timeout:60000});
 const attempt=await page.locator('[data-brf=research-attempt-status]').textContent(),events=await page.evaluate(()=>window.__testEvents);
 if(!attempt.includes('Attempt completed')||!attempt.includes('Verified tick: 400'))throw Error('Attempt failed: '+JSON.stringify({attempt,events}));
 const initial=events.find(e=>e.kind==='ready'),final=events.filter(e=>e.kind==='stepped').at(-1);
 if(!initial||!final||final.inspection.plant.tick!==400)throw Error('Missing physics evidence');
 const max={qpos:0,qvel:0};
 for(const k of ['qpos','qvel'])for(let i=0;i<ref[k].length;i++)max[k]=Math.max(max[k],Math.abs(final.inspection.plant[k][i]-ref[k][i]));
 if(Object.values(max).some(x=>x>1e-6))throw Error('Native reference mismatch: '+JSON.stringify(max));
 await page.getByRole('button',{name:'Game mode'}).click();
 await page.locator('[data-brf=show-simple-duck]').click();
 await page.waitForFunction(()=>/Simple duck, step 400/.test(document.querySelector('[data-brf=schematic-status]')?.textContent??''),null,{timeout:30000});
 await page.locator('[data-brf=schematic-canvas]').screenshot({path:evidence+'.final.png'});
 await page.locator('[data-brf=app-close]').click();
 await page.waitForFunction(()=>document.querySelector('[data-brf=app-status]')?.textContent==='Project closed.',null,{timeout:30000});
 if(errors.length||await page.locator('iframe').count())throw Error('Cleanup failed: '+JSON.stringify(errors));
 const result={browser:browser.version(),status,attempt,initial:initial.inspection.plant,final:final.inspection.plant,max,errors};
 await writeFile(evidence+'.json',JSON.stringify(result,null,2));
 console.log(JSON.stringify({browser:result.browser,attempt,max,initialX:result.initial.qpos[0],finalX:result.final.qpos[0],errors}));
}finally{if(browser)await browser.close();server.kill('SIGTERM')}
