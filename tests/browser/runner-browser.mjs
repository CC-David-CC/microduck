import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const app=process.env.MICRODUCK_HARNESS_OUT, runner=process.env.MICRODUCK_RUNNER_OUT, results=process.env.MICRODUCK_BROWSER_EVIDENCE;
if(!app||!runner||!results)throw Error('Harness, runner and evidence paths are required');
const samples=JSON.parse(await readFile(root+'tests/fixtures/granted-truth.json'));
const expected=JSON.parse(await readFile(root+'tests/fixtures/policy-reference.json')).forward;
const server=spawn('python3',[fileURLToPath(new URL('./runner-test-server.py',import.meta.url))],{env:{...process.env,BRF_APP_DIST:app,BRF_RUNNER_DIST:runner,BRF_REQUEST_LOG:results+'.requests.jsonl'},stdio:'ignore'});
let browser;
try {
 for(let i=0;i<100;i++){
  if(server.exitCode!==null)throw Error('Test server exited');
  try{if((await fetch('http://127.0.0.1:19682/')).ok)break}catch{}
  if(i===99)throw Error('Test server unavailable');
  await new Promise(r=>setTimeout(r,100));
 }
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const page=await browser.newPage(), errors=[], requests=[];
 page.on('pageerror',e=>errors.push(String(e)));
 page.on('request',r=>requests.push(r.url()));
 await page.goto('http://127.0.0.1:19682/');
 await page.waitForFunction(()=>typeof window.runMicroduckRunner==='function');
 const controls=await page.evaluate(samples=>window.runMicroduckRunner(samples),samples);
 let max=0;
 for(let i=0;i<samples.length;i++)for(let j=0;j<14;j++)max=Math.max(max,Math.abs(controls[i][j]-expected[i].control[j]));
 if(max>1e-6)throw Error('Policy control mismatch: '+max);
 let rejected=false;
 try{await page.evaluate(()=>window.runMicroduckRunner([],"globalThis.compromised=true"))}catch{rejected=true}
 if(!rejected)throw Error('Imported source was accepted');
 if(await page.evaluate(()=>globalThis.compromised===true))throw Error('Imported source executed');
 if(await page.locator('iframe').count())throw Error('Runner frame leaked');
 if(errors.length)throw Error('Page errors: '+JSON.stringify(errors));
 if(requests.some(url=>!url.startsWith('http://127.0.0.1:19682/')&&!url.startsWith('http://127.0.0.1:19683/')))throw Error('Unexpected external request');
 const data={browser:browser.version(),samples:controls.length,maxControlDifference:max,rejectedUnknownSource:rejected,errors,requests};
 await writeFile(results+'.json',JSON.stringify(data,null,2));
 console.log(JSON.stringify(data));
}finally{if(browser)await browser.close();server.kill('SIGTERM')}
