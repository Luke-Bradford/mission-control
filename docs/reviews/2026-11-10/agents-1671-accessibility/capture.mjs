import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {Script} from 'node:vm';
const wt='/tmp/mc-1671-agents-accessibility';
const output=readFileSync('/tmp/mc-1671-agents-evidence-path','utf8').trim();
const requireWeb=createRequire('/tmp/mc-1513-complete-proposal/apps/web/package.json');
const {chromium}=createRequire('/tmp/mc-1513-complete-proposal/apps/server/package.json')('playwright-core');
const hash=b=>createHash('sha256').update(b).digest('hex');
const before=readFileSync(join(output,'before.html'),'utf8');
const after=readFileSync(join(wt,'docs/prototype/agents-page-revised.html'),'utf8');
writeFileSync(join(output,'after.html'),after);
for(const html of [before,after])for(const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new Script(m[1]);
const fonts=new Map();let css='';
for(const [pkg,family,weights] of [['barlow-semi-condensed','Barlow Semi Condensed',[500,600]],['ibm-plex-mono','IBM Plex Mono',[400,500]],['ibm-plex-sans','IBM Plex Sans',[400,500,600]]]){
 for(const weight of weights){const sheet=requireWeb.resolve(`@fontsource/${pkg}/latin-${weight}.css`);const text=readFileSync(sheet,'utf8');const match=/url\(['"]?(\.\/files\/[^)'"\s]+\.woff2)/.exec(text);if(!match)throw Error('Missing local font '+sheet);const bytes=readFileSync(join(dirname(sheet),match[1]));const url=`/fonts/${pkg}-${weight}.woff2`;fonts.set(url,bytes);css+=`@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:block;src:url("${url}") format("woff2")}\n`;}
}
const report={kind:'author-rendered static prototype rework; no application acceptance',baseline:'686252d31138e3c445d24391e3fe29053498cd20',startedAt:new Date().toISOString(),source:{before:hash(before),after:hash(after)},fonts:[...fonts].map(([name,b])=>({name,sha256:hash(b)})),facts:[],interactions:[],errors:[]};
const save=()=>writeFileSync(join(output,'receipt.json'),JSON.stringify(report,null,2));
const serve=html=>html.replace(/https:\/\/fonts\.googleapis\.com\/css2\?[^"\s]+/,'/fonts.css');
const server=createServer((req,res)=>{if(req.url==='/fonts.css'){res.setHeader('content-type','text/css');res.end(css);return;}if(fonts.has(req.url)){res.setHeader('content-type','font/woff2');res.setHeader('access-control-allow-origin','*');res.end(fonts.get(req.url));return;}res.setHeader('content-type','text/html');res.end(serve(req.url?.startsWith('/before')?before:after));});
await new Promise(r=>server.listen(7463,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:'/Users/lukebradford/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell',headless:true});
const check=(value,label)=>{if(!value)throw Error(label);report.interactions.push(label);save()};
try{
 for(const [width,height] of [[1280,940],[1600,940],[1920,940],[1600,700]])for(const theme of ['dark','light'])for(const stage of ['before','after']){
  const c=await browser.newContext({viewport:{width,height},colorScheme:theme,deviceScaleFactor:1});const p=await c.newPage();p.setDefaultTimeout(10000);p.on('pageerror',e=>report.errors.push({stage,width,height,theme,error:String(e)}));
  try{await p.goto(`http://127.0.0.1:7463/${stage}`,{waitUntil:'load'});await p.evaluate(()=>document.fonts.ready);await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   const facts=await p.evaluate(()=>({transform:getComputedStyle(document.querySelector('main')).transform,sideScroll:document.documentElement.scrollWidth-innerWidth,pageHeight:document.documentElement.scrollHeight,viewportHeight:innerHeight,fonts:[...document.fonts].map(f=>({family:f.family,weight:f.weight,status:f.status})),smallText:[...document.querySelectorAll('main *')].filter(e=>e.getClientRects().length&&e.childElementCount===0&&e.textContent.trim()).map(e=>({text:e.textContent.slice(0,60),size:parseFloat(getComputedStyle(e).fontSize),family:getComputedStyle(e).fontFamily})).filter(e=>e.size<(e.family.includes('Mono')?11:12)),smallControls:[...document.querySelectorAll('button,a')].filter(e=>e.getClientRects().length).map(e=>({text:e.textContent.slice(0,60),w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height})).filter(e=>e.w<24||e.h<24),clippedNames:[...document.querySelectorAll('.card .name')].filter(e=>e.getBoundingClientRect().right>e.parentElement.getBoundingClientRect().right+1).map(e=>e.textContent),panels:[...document.querySelectorAll('.app,.seat,#live,.side,.feed,.tbody')].map(e=>({class:e.className,id:e.id,h:e.clientHeight,scroll:e.scrollHeight}))}));
   report.facts.push({stage,width,height,theme,at:new Date().toISOString(),...facts});await p.screenshot({path:join(output,`agents-${stage}-${width}x${height}-${theme}.png`)});save();
   if(stage==='after'){check(facts.transform==='none',`No whole-page scaling at${width}x${height}${theme}`);check(facts.sideScroll===0&&facts.pageHeight===height,`The fixed page shell fits at${width}x${height}${theme}`);check(facts.clippedNames.length===0,`Every roster call sign stays visible at${width}x${height}${theme}`);check(facts.smallText.length===0&&facts.smallControls.length===0,`Text and targets meet minimum sizes at${width}x${height}${theme}`);}
  }finally{await c.close();}
 }
 const c=await browser.newContext({viewport:{width:1280,height:940},colorScheme:'dark'});const p=await c.newPage();p.setDefaultTimeout(10000);await p.goto('http://127.0.0.1:7463/after');await p.evaluate(()=>document.fonts.ready);
 const group=p.getByRole('group',{name:'Live activity filters'});const all=await p.locator('.feed .row').count();
 for(const [label,expected] of [['Messages',3],['Thinking',1],['Tools',4],['Guard',1]]){
  const button=group.getByRole('button',{name:label,exact:true});await button.focus();await p.keyboard.press('Space');check(await button.getAttribute('aria-pressed')==='true'&&await p.locator('.feed .row').count()===expected,`Keyboard selects ${label} and filters the feed`);
 }
 await group.getByRole('button',{name:'All',exact:true}).click();check(await p.locator('.feed .row').count()===all,'All restores the complete activity feed');
 await p.getByRole('button',{name:'Recent runs',exact:true}).click();const run=p.locator('.hrow.detail-link').first();check(await run.count()===1,'Recent runs exposes a named native button');await run.focus();await p.keyboard.press('Enter');await p.waitForSelector('dialog[open]');check((await p.locator('dialog .full-title').innerText()).length>0,'Keyboard opens a full recorded-run title');await p.screenshot({path:join(output,'agents-run-details-1280x940-dark.png')});await p.keyboard.press('Escape');check(await run.evaluate(e=>document.activeElement===e),'Closing run details restores keyboard focus');
 const ticket=p.locator('.todo .detail-link').first();if(await ticket.count()){await ticket.focus();await p.keyboard.press('Enter');await p.waitForSelector('dialog[open]');check((await p.locator('dialog .full-title').innerText()).length>0,'Keyboard opens a full waiting-ticket title');await p.keyboard.press('Escape');}
 await p.evaluate(()=>{const active=seats.find(s=>s.id===cur);if(active.hist.length)active.hist[0].title='A'.repeat(300);seat();});await p.getByRole('button',{name:'Recent runs',exact:true}).click();const long=p.locator('.hrow.detail-link').first();await long.focus();await p.keyboard.press('Enter');await p.waitForSelector('dialog[open]');check((await p.locator('dialog .full-title').innerText()).length===300,'The full 300-character unbroken title is visible on keyboard activation');check(await p.locator('dialog').evaluate(e=>e.scrollWidth<=e.clientWidth),'The long-title dialog has no horizontal overflow');await p.screenshot({path:join(output,'agents-long-title-1280x940-dark.png')});await p.keyboard.press('Escape');await p.locator('.card').last().focus();check(await p.locator('.card').last().evaluate(e=>{const r=e.getBoundingClientRect(),p=e.closest('.cards').getBoundingClientRect();return r.top>=p.top-1&&r.bottom<=p.bottom+1}),'Keyboard reaches the final roster seat by scrolling the list');await p.locator('.card').filter({hasText:'FAO-1'}).click();check(await p.locator('.feed').innerText().then(t=>t.includes('No run in progress.')),'Idle activity has a written empty state');await p.getByRole('group',{name:'Live activity filters'}).getByRole('button',{name:'Guard',exact:true}).click();check(await p.locator('.feed .row').count()===0,'Filtering an empty activity snapshot stays empty');await p.screenshot({path:join(output,'agents-idle-1280x940-dark.png')});await c.close();
 report.finishedAt=new Date().toISOString();
}catch(e){report.failure=String(e);throw e}finally{save();await browser.close();await new Promise(r=>server.close(r));console.log(JSON.stringify({output,images:report.facts.length,interactions:report.interactions.length,errors:report.errors,failure:report.failure}));}
