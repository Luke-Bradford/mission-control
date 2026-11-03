import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {join,extname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root='$CONTROLLER/codex-overview-operational-fit-1360';
const out='$CONTROLLER/overview-independent-3a9';
const web=join(root,'apps/web');
const req=createRequire(join(web,'package.json'));
const {build}=await import(pathToFileURL(req.resolve('vite')).href);
const {chromium}=createRequire(join(root,'apps/server/package.json'))('playwright-core');
const {overviewDensityFixture}=await import(pathToFileURL(join(web,'test/overviewDensityFixtures.ts')).href);
const receipts={source:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),startedAt:new Date().toISOString(),cases:[],errors:[],limits:['Read-only fictional App fixture, no live verification','200% text-only enlargement is computed-font/line-height enlargement; no browser-zoom execution','Runtime3a9 and fixture/harness are separately source-bound; only Provider resource ownership differs from b45'],files:[]};
for(const p of ['apps/web/test/overviewDensityFixtures.ts','apps/web/test/overviewDensityBrowser.tsx','apps/web/test/browserRunner.ts','apps/web/src/overview/overview.css','apps/web/src/overview/KpiStrip.tsx','apps/web/src/overview/OverviewProvider.tsx','apps/web/src/overview/OverviewLayout.tsx','apps/web/src/overview/OverviewEvidence.tsx','apps/web/src/shell/Dock.tsx']){let b=readFileSync(join(root,p));receipts.files.push({path:p,sha256:createHash('sha256').update(b).digest('hex')});}
execFileSync('git',['diff','--quiet','3a9e66c0ddd3bd6e1afc44b50f67833ca44b6d1a','--','apps/web/src'],{cwd:root});
function save(){writeFileSync(join(out,'receipt.json'),JSON.stringify(receipts,null,2)+'\n');}
const assert=(v,m)=>{if(!v)throw Error(m)};
if(!existsSync(join(out,'build/test/overviewDensityBrowser.html'))) await build({root:web,configFile:join(web,'vite.config.ts'),logLevel:'silent',build:{outDir:join(out,'build'),emptyOutDir:true,rollupOptions:{input:join(web,'test/overviewDensityBrowser.html')}}});
const executablePath='/Users/lukebradford/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const browser=await chromium.launch({executablePath,headless:true});
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.woff':'font/woff','.svg':'image/svg+xml'};
async function pageAt(width,height,theme,scenario='normal-loops'){
 const fixture=overviewDensityFixture(scenario),context=await browser.newContext({viewport:{width,height},deviceScaleFactor:1,colorScheme:theme}),page=await context.newPage(),requests=[],errors=[];page.setDefaultTimeout(7000);
 page.on('pageerror',e=>errors.push(e.stack||e.message));
 await page.route('**/*',async route=>{const r=route.request(),u=new URL(r.url()),key=u.pathname+u.search;requests.push({method:r.method(),path:key});if(r.method()!=='GET')return route.fulfill({status:409,body:'independent read-only harness refused write'});if(key in fixture.api)return route.fulfill({contentType:'application/json',body:JSON.stringify(fixture.api[key])});const file=join(out,'build',u.pathname);if(file.startsWith(join(out,'build'))&&existsSync(file)&&!u.pathname.startsWith('/api/'))return route.fulfill({contentType:mime[extname(file)]||'application/octet-stream',body:readFileSync(file)});return route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:'not found'})});});
 await page.goto('http://mc.test/test/overviewDensityBrowser.html');await page.locator('#agentsList .trow:not(.head)').nth(10).waitFor();await page.waitForFunction(()=>document.querySelector('#machineSummaryP .machine-chart')&&document.querySelector('#page-overview')?.textContent.includes('41.2k'));await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 if(!(await page.locator('#dock').evaluate(e=>e.classList.contains('collapsed'))))await page.locator('#dockHead [title="Collapse FLIGHT to its rail"]').click();
 return {page,context,requests,errors,fixture};
}
async function facts(page){return page.evaluate(()=>{const grid=document.querySelector('.overview-grid'),r=document.querySelector('#agentsList');const rect=s=>{let e=document.querySelector(s);return e?e.getBoundingClientRect().toJSON():null};return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},grid:{width:grid.clientWidth,height:grid.clientHeight,scrollHeight:grid.scrollHeight,scrollTop:grid.scrollTop,...grid.dataset},crewRows:document.querySelectorAll('#agentsList .trow:not(.head)').length,loops:[...document.querySelectorAll('#agentsP .loop-chip')].map(e=>e.textContent),lanes:document.querySelectorAll('#timelineP .overview-lane').length,roster:{client:r.clientWidth,scroll:r.scrollWidth},histories:document.querySelectorAll('.overview-history-domain > .panel').length,outerOverflow:document.documentElement.scrollWidth>innerWidth,crew:rect('#agentsP'),pipeline:rect('#pipelineP'),machine:rect('#machineSummaryP'),active:document.activeElement?.outerHTML.slice(0,300)}})}
async function shot(page,name){await page.screenshot({path:join(out,name+'.png')})}
async function endpoint(page,selector){return page.locator(selector).last().evaluate(e=>{e.scrollIntoView({block:'nearest'});let r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {text:e.textContent,rect:r.toJSON(),painted:hit===e||e.contains(hit)}})}
try{
 const a=await pageAt(1920,1080,'light'),p=a.page,c={name:'all-api-path-provider-reflow-1920-4K-1920',initial:await facts(p)};receipts.cases.push(c);
 await p.waitForSelector('#quotaSummaryP');
 const stable=async()=>{await p.evaluate(()=>document.fonts.ready);await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))};
 const counts=()=>Object.fromEntries([...new Set(a.requests.filter(r=>r.path.startsWith('/api/')).map(r=>r.path))].sort().map(path=>[path,a.requests.filter(r=>r.path===path).length]));
 await stable();c.before=counts();await shot(p,'provider-1920-before');
 await p.setViewportSize({width:3840,height:2160});await p.waitForFunction(()=>document.querySelector('.overview-grid')?.dataset.allHistories==='true'&&document.querySelector('.overview-provider .evidence-inline #quotaP'));await stable();c.wide=await facts(p);c.afterWide=counts();await shot(p,'provider-4K-after');assert(JSON.stringify(c.before)===JSON.stringify(c.afterWide),'API paths changed on summary-to-full '+JSON.stringify({before:c.before,after:c.afterWide}));
 await p.setViewportSize({width:1920,height:1080});await p.waitForFunction(()=>document.querySelector('.overview-grid')?.dataset.allHistories==='false'&&document.querySelector('#quotaSummaryP'));await stable();c.after=await facts(p);c.afterCompact=counts();await shot(p,'provider-1920-after');assert(JSON.stringify(c.before)===JSON.stringify(c.afterCompact),'API paths changed on full-to-summary '+JSON.stringify({before:c.before,after:c.afterCompact}));
 c.requests=a.requests.filter(r=>r.path.startsWith('/api/'));c.errors=a.errors;assert(c.errors.length===0,'browser page errors');assert(c.initial.crewRows===11&&c.initial.loops.length===2&&c.initial.lanes===13,'initial combinednormal counts');assert(c.after.crewRows===11&&c.after.loops.length===2&&c.after.lanes===13,'final combinednormal counts');assert(!c.after.outerOverflow&&c.after.grid.scrollHeight<=c.after.grid.height+1,'normal allocation changed');await a.context.close();
 execFileSync('git',['diff','--quiet','3a9e66c0ddd3bd6e1afc44b50f67833ca44b6d1a','--','apps/web/src'],{cwd:root});receipts.finishedAt=new Date().toISOString();receipts.status='completed';save();
}catch(e){receipts.errors.push(e.stack||String(e));receipts.status='failed';save();console.error(e);process.exitCode=1}finally{await browser.close()}
console.log(JSON.stringify({status:receipts.status,cases:receipts.cases.map(c=>c.name),errors:receipts.errors}));
