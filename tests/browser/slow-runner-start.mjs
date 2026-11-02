import {chromium} from 'playwright';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{const page=await browser.newPage({viewport:{width:1366,height:900}});let delayed=0;
 await page.route((process.env.MICRODUCK_RUNNER_URL??'http://127.0.0.1:19685')+'/frame?*',async route=>{delayed++;await new Promise(r=>setTimeout(r,4200));try{await route.continue()}catch{}});
 await page.goto(process.env.MICRODUCK_PREVIEW_URL??'http://127.0.0.1:19684/');await page.waitForSelector('.login-toggle');await page.click('.login-toggle');
 const user='slow'+Date.now().toString().slice(-9);await page.locator('[aria-label=Username]').fill(user);await page.locator('[aria-label=Password]').fill('test-password-123');await page.locator('[aria-label="Confirm password"]').fill('test-password-123');await page.locator('.login-form button[type=submit]').click();
 await page.waitForFunction(()=>window.desktopLab?.session?.kind==='registered',null,{timeout:30000});await page.locator('[aria-label=Applications]').click();await page.getByRole('menuitem',{name:'Games'}).click();await page.getByRole('menuitem',{name:'Physics games (XR planned)'}).click();await page.getByRole('menuitem',{name:'Microduck',exact:true}).click();
 await page.waitForFunction(()=>{const t=document.querySelector('[data-brf=app-status]')?.textContent??'';return t==='Project open.'||t==='Project start failed.'},null,{timeout:40000});
 const result=await page.locator('[data-brf=app-status]').textContent();if(!delayed||result!=='Project open.')throw Error('Delayed runner startup: '+JSON.stringify({delayed,result}));
 await page.waitForFunction(()=>/Microduck, step 0/.test(document.querySelector('[data-brf=schematic-status]')?.textContent??''),null,{timeout:30000});console.log(JSON.stringify({result,delayed,visual:'Microduck at step 0'}));
}finally{await browser.close()}
