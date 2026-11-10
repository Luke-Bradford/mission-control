import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,readdirSync,mkdirSync,existsSync,copyFileSync} from 'node:fs';
import {join,normalize,extname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';

const wt='/private/tmp/mc-1663-controller-evidence-81c';
const output=readFileSync('/tmp/mc-1663-controller-81c-evidence-path','utf8').trim();
const head='81c6608b9fcba540b6d8b4888f3c88e4e1fd8d6d';
const requireWeb=createRequire(join(wt,'apps/web/package.json'));
const {build}=await import(requireWeb.resolve('vite'));
const {chromium}=createRequire(join(wt,'apps/server/package.json'))('playwright-core');
const {CONFIG,seatRow}=await import(join(wt,'apps/web/test/fixtures.ts'));
const buildDir=join(output,'build');
const report={head,startedAt:new Date().toISOString(),output,observations:[],phases:[],errors:[],requests:[],unhandledApi:[]};
const save=()=>writeFileSync(join(output,'motion-probe-receipt.json'),JSON.stringify(report,null,2));
const sourceCheck=()=>{
 if(execFileSync('git',['rev-parse','HEAD'],{cwd:wt,encoding:'utf8'}).trim()!==head)throw Error('Source head changed');
 execFileSync('git',['diff','--exit-code','--','apps/web/src'],{cwd:wt});
};
sourceCheck();save();
// Reuse the frozen build from the completed CPU capture.
const now=Date.now(),ids=['flight-1',...Array.from({length:9},(_,i)=>`seat-${i+1}`)];
const roles=['GUIDO','RETRO','INCO','FAO','OPS'];
const rows=ids.map((id,index)=>seatRow({id,index,role:index===0?'FLIGHT':roles[index%roles.length],hudState:index%3===0?'running':'idle',run:null}));
const links=ids.flatMap((from,i)=>[{from,to:ids[(i+1)%ids.length],count:2+i%7,lastId:`initial-${i}`,lastAt:now-i*3500,lastText:`Existing message ${i}`},{from,to:i===0?'CAPCOM':'flight-1',count:1+i%4}]).filter(l=>l.from!==l.to);
const api={
 '/api/config':CONFIG,'/api/crew?shape=summary':{rows,firstRunToday:null},'/api/attention':[],
 '/api/flight':{seat:{id:'flight-1'},decisions:[]},'/api/comms/crew':{messages:[],hasMore:false},
 '/api/comms/flight':{messages:[]},'/api/comms/mentions':{mentions:[]},'/api/comms/pins':{messages:[]},
 '/api/comms/read':{ok:true},'/api/comms/links':{links},'/api/comms/chatter':{pairs:[]},'/api/comms/traffic':{hours:[]},
 '/api/comms/metrics':{p95BySeat:[],bySeat:[]},'/api/comms/open':{items:[{id:'controlled-ask',label:'question',from:'seat-1',to:'seat-2',ticket:null,waitedMs:840000,question:'Which branch should be reviewed?'}]},
 '/api/comms/feed':{messages:ids.slice(0,6).map((from,i)=>({id:`feed-${i}`,from,to:'flight-1',at:now-i*60000,text:`Existing crew update ${i}`}))}
};
writeFileSync(join(output,'motion-probe-fixture.json'),JSON.stringify(api,null,2));
const initialLinks=JSON.stringify(links),initialFeed=JSON.stringify(api['/api/comms/feed']),initialOpen=JSON.stringify(api['/api/comms/open']);
const originalPrototype=readFileSync('/tmp/mc-1671-agents-accessibility/docs/prototype/comms-living-graph.html','utf8');
report.prototypeSha256=createHash('sha256').update(originalPrototype).digest('hex');
const fonts=readdirSync(join(buildDir,'assets')).filter(x=>x.endsWith('.woff2'));
const prototypeFonts=['sans','mono'].flatMap(kind=>[400,500,600].flatMap(weight=>{
 const file=fonts.find(x=>x.startsWith(`ibm-plex-${kind}-latin-${weight}-normal`));
 return file?[`@font-face{font-family:'IBM Plex ${kind==='sans'?'Sans':'Mono'}';font-weight:${weight};src:url('http://graph.test/assets/${file}') format('woff2')}`]:[];
})).join('\n');
const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml'};
const executablePath='/Users/lukebradford/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function routeAll(route){
 const url=new URL(route.request().url());
 if(url.host==='comparison.test')return route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:#05080c;color:#e6eaef;font:16px sans-serif}main{display:grid;grid-template-columns:1fr 1fr}header{height:48px;padding:12px;border:1px solid #2a3848}iframe{display:block;width:100%;height:940px;border:1px solid #2a3848}</style></head><body><main><section><header>Actual app · PR1675 · ${head.slice(0,7)} · controlled 10-seat fixture</header><iframe src="http://graph.test/test/controllerGraphBrowser.html?at=%2Fcomms%2Fchart"></iframe></section><section><header>Committed approved prototype · Comms unchanged from686252d · historical fixture</header><iframe src="http://prototype.test/"></iframe></section></main></body></html>`});
 if(url.host==='prototype.test')return route.fulfill({contentType:'text/html',body:originalPrototype});
 if(url.host==='cdnjs.cloudflare.com')return route.fulfill({contentType:'application/javascript',body:readFileSync('/tmp/r1671/d3.js')});
 if(url.host==='fonts.googleapis.com')return route.fulfill({contentType:'text/css',body:prototypeFonts});
 if(url.host!=='graph.test')return route.fulfill({status:404,body:'External networking disabled in controlled evidence'});
 const key=url.pathname+url.search;
 if(key in api){report.requests.push({at:Date.now(),method:route.request().method(),path:key});return route.fulfill({contentType:'application/json',body:JSON.stringify(api[key])});}
 const file=normalize(join(buildDir,url.pathname));
 if(file.startsWith(buildDir+'/')&&existsSync(file)&&!url.pathname.startsWith('/api/'))return route.fulfill({contentType:mime[extname(file)]??'application/octet-stream',body:readFileSync(file)});
 if(url.pathname.startsWith('/api/'))report.unhandledApi.push({path:key,method:route.request().method()});return route.fulfill({status:404,contentType:'application/json',body:'{"error":"not in controlled fixture"}'});
}
async function inspect(frame){return frame.evaluate(()=>({title:document.title,viewport:{width:innerWidth,height:innerHeight},visibility:document.visibilityState,dpr:devicePixelRatio,zoom:visualViewport?.scale,theme:getComputedStyle(document.documentElement).colorScheme,fonts:document.fonts.status,sideScroll:document.documentElement.scrollWidth-innerWidth,names:[...document.querySelectorAll('.comms-node-name')].map(x=>x.textContent),waitingNodes:document.querySelectorAll('.comms-node.waiting').length,headings:[...document.querySelectorAll('h1,h2,h3,.panel-title')].map(x=>x.textContent),buttons:[...document.querySelectorAll('button')].map(x=>x.textContent),animations:document.getAnimations().length}));}
async function message(frame,index){
 const link=links.find(l=>l.from==='seat-1'&&l.to==='seat-2');
 link.count++;link.lastId=`controlled-new-${index}`;link.lastAt=Date.now();link.lastText=`Controlled new message ${index}`;
 api['/api/comms/feed'].messages.unshift({id:link.lastId,from:link.from,to:link.to,at:link.lastAt,text:link.lastText});
 const sent=performance.now();await frame.evaluate(()=>window.__refetchAgents());
 report.observations.push({kind:'synthetic agents resource update',index,sentAt:Date.now(),bridgeRoundTripMs:performance.now()-sent});
}
async function context(name,video=false){
 const options={executablePath,headless:true,viewport:{width:video?3840:1920,height:video?988:940},deviceScaleFactor:1,colorScheme:'dark',reducedMotion:'no-preference'};
 if(video)options.recordVideo={dir:join(output,'video'),size:{width:3840,height:988}};
 const ctx=await chromium.launchPersistentContext(join(output,`profile-${name}`),options);
 await ctx.route('**/*',routeAll);const page=ctx.pages()[0];page.on('pageerror',e=>report.errors.push({phase:name,error:e.stack??String(e)}));return{ctx,page};
}

const {ctx,page}=await context('motion-probe');try{await page.goto('http://graph.test/test/controllerGraphBrowser.html?at=%2Fcomms%2Fchart',{waitUntil:'load'});await page.waitForSelector('.comms-node');await pause(2500);await message(page,300);await page.waitForSelector('.comms-particle');const samples=[];for(let i=0;i<6;i++){samples.push(await page.evaluate(()=>{const c=document.querySelector('.comms-particle'),m=c?.querySelector('animateMotion'),r=c?.getBoundingClientRect();return{at:performance.now(),svgTime:c?.ownerSVGElement?.getCurrentTime(),animationStart:(()=>{try{return m?.getStartTime()}catch{return null}})(),x:r?.x,y:r?.y,opacity:c?getComputedStyle(c).opacity:null,ctm:c?.getCTM()?{x:c.getCTM().e,y:c.getCTM().f}:null}}));await pause(120);}report.motionSamples=samples;report.motionChanged=samples.some(s=>Math.abs(s.x-samples[0].x)>1||Math.abs(s.y-samples[0].y)>1);await page.screenshot({path:join(output,'motion-baseline-stalled-1920x940-dark.png')});report.controlIntervention='Browser-only beginElement() on the already inserted motion/opacity elements; no source edit';await page.evaluate(()=>{const circle=document.querySelector('.comms-particle');for(const a of circle?.querySelectorAll('animateMotion,animate')??[])a.beginElement();});const control=[];for(let i=0;i<4;i++){await pause(120);control.push(await page.evaluate(()=>{const c=document.querySelector('.comms-particle'),r=c?.getBoundingClientRect();return{at:performance.now(),x:r?.x,y:r?.y}}));}report.controlSamples=control;report.controlMoved=control.some(s=>Math.abs(s.x-control[0].x)>1||Math.abs(s.y-control[0].y)>1);await page.screenshot({path:join(output,'motion-control-beginElement-1920x940-dark.png')});save();console.log(JSON.stringify({motionChanged:report.motionChanged,controlMoved:report.controlMoved,samples,control,errors:report.errors}));}finally{await ctx.close();}
