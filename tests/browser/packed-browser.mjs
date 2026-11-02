import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const app=process.env.MICRODUCK_PACKED_OUT,runner=process.env.MICRODUCK_RUNNER_OUT,log=process.env.MICRODUCK_PACKED_LOG;
if(!app||!runner||!log)throw Error('Missing test paths');
const server=spawn('python3',[fileURLToPath(new URL('./runner-test-server.py',import.meta.url))],{env:{...process.env,BRF_APP_DIST:app,BRF_RUNNER_DIST:runner,BRF_REQUEST_LOG:log},stdio:'ignore'});
let browser;
try{
 for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('Server exited');try{if((await fetch('http://127.0.0.1:19682/')).ok)break}catch{}if(i===99)throw Error('Server unavailable');await new Promise(r=>setTimeout(r,100))}
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto('http://127.0.0.1:19682/');
 await page.waitForFunction(()=>/Project open|Project start failed|Unable to open/i.test(document.body.textContent??''),null,{timeout:90000});
 const status=await page.locator('[data-brf=app-status]').textContent();
 if(status!=='Project open.')throw Error('Packaged desktop app failed: '+status+' '+JSON.stringify(errors));
 await page.locator('[data-brf=show-simple-duck]').click();
 await page.waitForFunction(()=>/Simple duck, step 0/.test(document.querySelector('[data-brf=schematic-status]')?.textContent??''));
 await page.locator('[data-brf=target-value]').fill('0.25');
 await page.locator('[data-brf=target-set]').click();
 await page.waitForFunction(()=>/Target request accepted/.test(document.querySelector('[data-brf=target-feedback]')?.textContent??''));
 await page.getByRole('button',{name:'Hardware tuning mode'}).click();
 await page.getByRole('button',{name:'Game mode'}).click();
 await page.locator('[data-brf=step]').click();
 await page.waitForFunction(()=>/step 1/i.test(document.querySelector('[data-brf=schematic-status]')?.textContent??''),null,{timeout:30000});
 await page.evaluate(()=>window.closePacked());
 await page.waitForFunction(()=>document.querySelectorAll('iframe').length===0,null,{timeout:30000});
 if(errors.length)throw Error('Page errors: '+JSON.stringify(errors));
 console.log(JSON.stringify({browser:browser.version(),status:'passed',target:.25,steps:1,errors}));
}finally{if(browser)await browser.close();server.kill('SIGTERM')}
