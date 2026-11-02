import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const app=process.env.MICRODUCK_LIVE_APP_OUT,runner=process.env.MICRODUCK_RUNNER_OUT,log=process.env.MICRODUCK_SNAPSHOT_LOG;
if(!app||!runner||!log)throw Error('Missing test paths');
const server=spawn('python3',[fileURLToPath(new URL('./runner-test-server.py',import.meta.url))],{env:{...process.env,BRF_APP_DIST:app,BRF_RUNNER_DIST:runner,BRF_REQUEST_LOG:log},stdio:'ignore'});
let browser;
try{
 for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('Server exited');try{if((await fetch('http://127.0.0.1:19682/')).ok)break}catch{}if(i===99)throw Error('Server unavailable');await new Promise(r=>setTimeout(r,100))}
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const page=await browser.newPage();await page.goto('http://127.0.0.1:19682/');
 await page.waitForFunction(()=>typeof window.loadBuiltInProject==='function');
 await page.evaluate(()=>window.loadBuiltInProject());
 await page.waitForFunction(()=>document.querySelector('[data-brf=app-status]')?.textContent==='Project open.',null,{timeout:90000});
 await page.locator('[data-brf=target-value]').fill('0.25');await page.locator('[data-brf=target-set]').click();
 await page.waitForFunction(()=>/Target request accepted/.test(document.querySelector('[data-brf=target-feedback]')?.textContent??''));
 const snapshot=await page.evaluate(()=>window.captureBuiltInProject());
 if(!snapshot.current||snapshot.format!=='brf-project-experiment/1'||!snapshot.records.some(x=>x.startsWith('session-targets-')))throw Error('Invalid saved project: '+JSON.stringify(snapshot));
 await page.locator('[data-brf=app-close]').click();
 await page.waitForFunction(()=>document.querySelector('[data-brf=app-status]')?.textContent==='Project closed.');
 console.log(JSON.stringify({browser:browser.version(),snapshot}));
}finally{if(browser)await browser.close();server.kill('SIGTERM')}
