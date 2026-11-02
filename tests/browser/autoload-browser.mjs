import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const app=process.env.MICRODUCK_LIVE_APP_OUT,runner=process.env.MICRODUCK_RUNNER_OUT,log=process.env.MICRODUCK_AUTOLOAD_LOG;
if(!app||!runner||!log)throw Error('Missing test paths');
const server=spawn('python3',[fileURLToPath(new URL('./runner-test-server.py',import.meta.url))],{env:{...process.env,BRF_APP_DIST:app,BRF_RUNNER_DIST:runner,BRF_REQUEST_LOG:log},stdio:'ignore'});
let browser;
try{
 for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('Server exited');try{if((await fetch('http://127.0.0.1:19682/')).ok)break}catch{}if(i===99)throw Error('Server unavailable');await new Promise(r=>setTimeout(r,100))}
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto('http://127.0.0.1:19682/');
 await page.waitForFunction(()=>typeof window.loadBuiltInProject==='function');
 await page.evaluate(()=>window.loadBuiltInProject());
 await page.waitForFunction(()=>/Project open|Project start failed/i.test(document.querySelector('[data-brf=app-status]')?.textContent??''),null,{timeout:90000});
 const status=await page.locator('[data-brf=app-status]').textContent();
 if(status!=='Project open.')throw Error('Built-in project failed: '+status);
 await page.locator('[data-brf=app-close]').click();
 await page.waitForFunction(()=>document.querySelector('[data-brf=app-status]')?.textContent==='Project closed.');
 if(errors.length||await page.locator('iframe').count())throw Error('Cleanup or page error: '+JSON.stringify(errors));
 console.log(JSON.stringify({browser:browser.version(),status:'passed',errors}));
}finally{if(browser)await browser.close();server.kill('SIGTERM')}
