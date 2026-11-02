// Isolated desktop preview only; does not launch or stop the shared browser.
import {chromium} from 'playwright';
const base=new URL(process.env.MICRODUCK_PREVIEW_URL||'http://127.0.0.1:19752/');
if(!['127.0.0.1','localhost','[::1]'].includes(base.hostname))throw Error('Loopback preview required');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/snap/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']}),phone=process.env.CODI_PHONE==='1',context=await browser.newContext({viewport:phone?{width:390,height:844}:process.env.CODI_4K==='1'?{width:3840,height:2160}:{width:1920,height:1080},isMobile:phone,hasTouch:phone});
try{
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(base.href);await page.waitForSelector('.login-toggle');await page.click('.login-toggle');
 const name='stage'+Date.now().toString().slice(-9);await page.locator('[aria-label=Username]').fill(name);await page.locator('[aria-label=Password]').fill('test-password-123');await page.locator('[aria-label="Confirm password"]').fill('test-password-123');await page.locator('.login-form button[type=submit]').click();
 await page.waitForFunction(()=>window.desktopLab?.session?.kind==='registered',null,{timeout:30000});
 await page.evaluate(()=>surfaces.get('Desktop').launch('microduck'));
 await page.waitForFunction(()=>document.querySelector('[data-brf=app-status]')?.textContent==='Project open.',null,{timeout:120000});
 await page.waitForFunction(()=>document.querySelector('[data-brf=app-runner] iframe'),null,{timeout:30000});
 await page.evaluate(async()=>{window.__originalMicroduckFrame=document.querySelector('[data-brf=app-runner] iframe');const c=await mirrorFileContext();await c.files.write('/invalid.brf','not a project',null)});
 await page.getByRole('button',{name:'Open from My files'}).click();await page.getByRole('dialog').getByRole('button',{name:'Continue'}).click();await page.getByRole('dialog',{name:'Choose from My files'}).getByRole('button',{name:'Choose file invalid.brf'}).click();
 await page.waitForFunction(()=>document.querySelector('.microduck-files')?.textContent.includes('Open failed:'),null,{timeout:120000});
 if(!await page.evaluate(()=>document.querySelector('[data-brf=app-runner] iframe')===window.__originalMicroduckFrame&&document.querySelector('[data-brf=app-status]')?.textContent==='Project open.'&&!document.querySelector('.microduck-stage')))throw Error('Failed open did not preserve old session');
 await page.getByRole('button',{name:'Save to My files'}).click();await page.getByRole('dialog',{name:'Choose folder in My files'}).getByRole('button',{name:'Use this folder'}).click();await page.waitForFunction(()=>document.querySelector('.microduck-files')?.textContent.includes('Saved locally:'),null,{timeout:30000});
 if(!await page.locator('.microduck-files').innerText().then(t=>t.includes('live simulation state is not fully saved')))throw Error('Missing live-state warning');
 // Cancellation must preserve the active app and its runner.
 await page.getByRole('button',{name:'Open from My files'}).click();await page.getByRole('dialog').getByRole('button',{name:'Cancel'}).click();
 if(!await page.evaluate(()=>document.querySelector('[data-brf=app-runner] iframe')===window.__originalMicroduckFrame))throw Error('Canceled open closed the old session');
 // Fail only the candidate runner's frame navigation; the old frame remains alive.
 const runnerFrame=/^http:\/\/127\.0\.0\.1:19753\/frame\?/;
 await page.route(runnerFrame,route=>route.abort('failed'));
 await page.getByRole('button',{name:'Open from My files'}).click();await page.getByRole('dialog').getByRole('button',{name:'Continue'}).click();await page.getByRole('dialog',{name:'Choose from My files'}).getByRole('button',{name:'Choose file Microduck.brf'}).click();
 await page.waitForFunction(()=>document.querySelector('.microduck-files')?.textContent.includes('Open failed:'),null,{timeout:120000});
 if(!await page.evaluate(()=>document.querySelector('[data-brf=app-runner] iframe')===window.__originalMicroduckFrame&&document.querySelector('[data-brf=app-status]')?.textContent==='Project open.'&&!document.querySelector('.microduck-stage')))throw Error('Runner failure did not preserve old session');
 await page.unroute(runnerFrame);
 await page.getByRole('button',{name:'Open from My files'}).click();await page.getByRole('dialog').getByRole('button',{name:'Continue'}).click();await page.getByRole('dialog',{name:'Choose from My files'}).getByRole('button',{name:'Choose file Microduck.brf'}).click();
 await page.waitForFunction(()=>document.querySelector('.microduck-files')?.textContent.includes('Opened /Microduck.brf.'),null,{timeout:120000});
 if(!await page.evaluate(()=>document.querySelector('[data-brf=app-runner] iframe')!==window.__originalMicroduckFrame&&!document.querySelector('.microduck-stage')))throw Error('Successful open did not replace the old session');
 await page.locator('.window.focused [aria-label=Close]').click();const dialog=page.getByRole('dialog');if(!(await dialog.innerText()).includes('live simulation state is not fully saved'))throw Error('Close warning is misleading');await dialog.getByRole('button',{name:'Discard changes'}).click();
 await page.waitForFunction(()=>!document.querySelector('.microduck-app')&&!document.querySelector('[data-brf=app-runner] iframe'),null,{timeout:30000});
 if(errors.length)throw Error(JSON.stringify(errors));console.log('PASS failed open preserves live session; save, staged reopen and close cleanup',phone?'phone':process.env.CODI_4K==='1'?'4K':'1080p');
}finally{await context.close();browser.close()}
