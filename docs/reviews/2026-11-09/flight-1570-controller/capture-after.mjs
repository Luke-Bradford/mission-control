import { chromium } from '/Users/lukebradford/Dev/mission-control/apps/server/node_modules/playwright-core/index.mjs';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
const preview=JSON.parse(await readFile('/tmp/mc-preview-1586.json','utf8'));
const out='/tmp/mc-evidence-1586';await mkdir(out,{recursive:true});
const fixtureNow=Date.UTC(2026,9,17,12,0);
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',chromiumSandbox:true});
const evidence=[];
try {
for (const viewport of [{width:1920,height:940},{width:2560,height:1200}]) for(const colorScheme of ['light','dark']) {
 const context=await browser.newContext({viewport,colorScheme,deviceScaleFactor:1,serviceWorkers:'block'});
 const denied=[];
 await context.route('**/*',async route=>{const r=route.request();const u=new URL(r.url());if(r.method()!=='GET'||u.origin!==preview.url||u.pathname==='/api/stream'){denied.push({method:r.method(),path:u.pathname});await route.abort();}else await route.continue();});
 await context.addInitScript(now=>{sessionStorage.setItem('mc-demo','true');sessionStorage.setItem('mc-dock-collapsed','true');Date.now=()=>now;},fixtureNow);
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const started=Date.now();
 await page.goto(preview.url+'/overview',{waitUntil:'load'});
 await page.getByRole('link',{name:'Flight',exact:true}).first().click();
 await page.waitForSelector('#page-flight #doing li');
 await page.waitForSelector('#page-flight .fp-drow');
 await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
 const path=out+`/flight-${colorScheme}-${viewport.width}x${viewport.height}.png`;
 await page.screenshot({path});
 const facts=await page.evaluate(()=>({url:location.pathname,width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,dpr:devicePixelRatio,theme:document.documentElement.dataset.theme,fixtureClock:Date.now(),demoBanner:document.querySelector('.demo-marker')?.getAttribute('aria-label')?.includes('Simulated crew') === true,body:document.querySelector('#page-flight')?.innerText,panels:[...document.querySelectorAll('#page-flight .fp-panel')].map(e=>({id:e.id,x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height})),scroll:{x:scrollX,y:scrollY}}));
 const shot={path,sha256:createHash('sha256').update(await readFile(path)).digest('hex'),colorScheme,viewport,scope:'viewport',capturedAt:new Date().toISOString(),readyElapsedMs:Date.now()-started,arrival:'Overview -> FLIGHT nav',errors,denied,...facts};
 evidence.push(shot);await context.close();
 if(errors.length||!facts.demoBanner||facts.url!=='/flight')throw Error('Capture failed readiness/privacy checks');
}
await writeFile(out+'/capture.json',JSON.stringify({pr:1586,publishedHead:preview.sha,renderedSource:preview.sha,baseline:'Not captured here; native review evidence sweep supplies matched baseline separately',browser:browser.version(),os:`${os.type()} ${os.release()} ${os.arch()}`,zoom:1,fixture:'built App Demo seed, Date.now fixed; real timers retained; simulation may advance after 4s',evidence},null,2));
console.log(JSON.stringify(evidence.map(({path,body,...x})=>({...x,path,body:body.slice(0,200)}))));
}finally{await browser.close();}
