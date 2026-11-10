import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const wt='/private/tmp/mc-1513-complete-proposal';
const {chromium}=createRequire(join(wt,'apps/server/package.json'))('playwright-core');
const output=readFileSync('/tmp/mc-1513-complete-preview-path','utf8').trim();
const report={at:new Date().toISOString(),kind:'mockup interaction evidence only',checks:[],errors:[],requests:[]};
const assert=(value,label)=>{if(!value)throw Error(label);report.checks.push(label)};
const browser=await chromium.launch({executablePath:'/Users/lukebradford/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell',headless:true});
const context=await browser.newContext({viewport:{width:1600,height:700},colorScheme:'light',deviceScaleFactor:1});
const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>report.errors.push(String(e)));page.on('response',r=>{if(r.url().includes('/api/')&&r.status()>=400)report.requests.push({url:r.url(),status:r.status()})});
try{
 await page.goto('http://127.0.0.1:7461/test/desktopBrowser.html',{waitUntil:'load'});
 await page.click('a[href="/comms"]');await page.waitForSelector('.p1513-controller');
 await page.click('.comms-nav-top:nth-of-type(2)');await page.waitForSelector('.comms-bubble');
 assert(await page.locator('[aria-label="Unread reply to you"]').count()===1,'One unread reply mark, on the operator reply thread');
 assert(await page.locator('.comms-mentions:visible').count()===0,'Mentions control is absent from the visible proposal');
 await page.click('.p1513-controller');await page.waitForFunction(()=>document.querySelectorAll('.comms-bubble').length===5);
 assert(decodeURIComponent(new URL(page.url()).pathname).includes('CONTROLLER'),'Controller entry opens its own five-message conversation');
 assert(await page.locator('.p1513-controller [aria-label="Unread reply to you"]').count()===0,'Controller conversation adds no operator unread mark');
 await page.getByRole('button',{name:/GUIDO-1 Available 12 messages/}).click();
 await page.waitForSelector('.comms-contacts');
 assert(await page.locator('[aria-label="Unread reply to you"]').count()===0,'Opening the operator reply thread clears its mockup unread mark');
 await page.locator('.comms-contacts button').filter({hasText:'MC · 2'}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.comms-bubble').length===2);
 assert((await page.locator('#chatP').innerText()).includes('request settled'),'Hub contact opens its two retained messages');
 await page.screenshot({path:join(output,'interaction-hub-contact-1600x700-light.png')});
 await page.fill('#p1513-search','no matching ticket');assert(await page.locator('.p1513-tickets').innerText().then(x=>x.includes('No matching tickets')),'Empty search has a specific written state');
 await page.fill('#p1513-search','Quote cache');await page.getByRole('button',{name:'Filter chat',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.comms-bubble').length===50);
 assert(!new URL(page.url()).pathname.startsWith('/ticket/'),'Filter chat retains the Comms page and shows the ticket conversation');
 await page.locator('.comms-ticket-open').click();await page.waitForSelector('.p1513-question');
 assert(await page.locator('.p1513-events .tk-event').count()===30,'Open ticket reaches a 30-entry record');
 await page.locator('.p1513-question summary').click();
 assert(await page.locator('.p1513-question details[open]').count()===1,'Question context expands beside the exact answer');
 await page.locator('.p1513-events details').first().locator('summary').click();
 assert(await page.locator('.p1513-events details[open]').count()===1,'Record context expands independently');
 const scroll=await page.locator('.p1513-events').evaluate(e=>{e.scrollTop=e.scrollHeight;return{top:e.scrollTop,max:e.scrollHeight-e.clientHeight,last:e.lastElementChild.getBoundingClientRect().bottom,height:innerHeight}});
 assert(scroll.top>0&&scroll.last<scroll.height,'The last record entry is reachable by independent scrolling at 1600×700');
 await page.screenshot({path:join(output,'interaction-ticket-context-1600x700-light.png')});
 await page.locator('.p1513-events').evaluate(e=>e.scrollTop=0);
 await page.screenshot({path:join(output,'interaction-question-answer-1600x700-light.png')});
 assert(report.errors.length===0&&report.requests.length===0,'No browser errors or failed API reads during the exercised paths');
 const ticketURL=page.url();
 for(const state of ['empty','loading','error']){
  const c=await browser.newContext({viewport:{width:1280,height:900},colorScheme:'dark'});
  await c.addCookies([{name:'p1513-state',value:state,url:'http://127.0.0.1:7461'}]);
  const p=await c.newPage();await p.goto('http://127.0.0.1:7461/test/desktopBrowser.html?path='+encodeURIComponent(new URL(ticketURL).pathname));
  await p.waitForSelector('.p1513-state:visible');await p.evaluate(()=>document.fonts.ready);
  await p.screenshot({path:join(output,`ticket-state-${state}-1280x900-dark.png`)});
  if(state==='error'){await p.getByRole('button',{name:'Try again',exact:true}).click();assert(await p.locator('.p1513-events:visible .tk-event').count()===30,'Ticket record retry restores the preview record');}
  await c.close();
 }
 for(const state of ['empty','loading','error']){
  const c=await browser.newContext({viewport:{width:1280,height:900},colorScheme:'dark'});
  await c.route('**/api/comms/crew*',async route=>{if(state==='loading')await new Promise(r=>setTimeout(r,10000));try{await route.fulfill({status:state==='error'?503:200,contentType:'application/json',body:JSON.stringify(state==='error'?{error:'The conversation could not load. Try again.'}:{messages:[],hasMore:false,unread:0})})}catch{}});
  const p=await c.newPage();await p.goto('http://127.0.0.1:7461/test/desktopBrowser.html?path=%2Fcomms%2Fcrew',{waitUntil:'domcontentloaded'});
  await p.waitForSelector('.p1513-controller');await p.evaluate(()=>document.fonts.ready);await p.screenshot({path:join(output,`comms-state-${state}-1280x900-dark.png`)});
  report.checks.push(`Comms ${state} state captured as a controlled example`);await c.close();
 }
 report.finishedAt=new Date().toISOString();
}catch(e){report.failure=String(e);report.debug={url:page.url(),body:await page.locator('body').innerText(),bubbleCount:await page.locator('.comms-bubble').count()};await page.screenshot({path:join(output,'historical-interaction-failure.png')});throw e}finally{writeFileSync(join(output,'interactions.json'),JSON.stringify(report,null,2));await context.close();await browser.close();console.log(JSON.stringify(report));}
