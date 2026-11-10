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
const save=()=>writeFileSync(join(output,'receipt.json'),JSON.stringify(report,null,2));
const sourceCheck=()=>{
 if(execFileSync('git',['rev-parse','HEAD'],{cwd:wt,encoding:'utf8'}).trim()!==head)throw Error('Source head changed');
 execFileSync('git',['diff','--exit-code','--','apps/web/src'],{cwd:wt});
};
sourceCheck();save();
await build({root:join(wt,'apps/web'),configFile:join(wt,'apps/web/vite.config.ts'),logLevel:'silent',build:{outDir:buildDir,emptyOutDir:true,rollupOptions:{input:join(wt,'apps/web/test/controllerGraphBrowser.html')}}});
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
writeFileSync(join(output,'fixture.json'),JSON.stringify(api,null,2));
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
let recording;
try{
 const {ctx,page}=await context('comparison',true);recording=ctx;
 await page.goto('http://comparison.test/',{waitUntil:'load'});
 const graph=page.frames().find(f=>f.url().startsWith('http://graph.test/'));
 const prototype=page.frames().find(f=>f.url().startsWith('http://prototype.test/'));
 await graph.waitForSelector('.comms-node');await prototype.waitForSelector('canvas');
 await graph.evaluate(()=>document.fonts.ready);await prototype.evaluate(()=>document.fonts.ready);await pause(1500);
 report.comparison={graph:await inspect(graph),prototype:await prototype.evaluate(()=>({viewport:{width:innerWidth,height:innerHeight},fonts:document.fonts.status,title:document.title,nodes:document.querySelectorAll('svg circle').length}))};
 await page.screenshot({path:join(output,'side-by-side-before.png')});
 for(let i=0;i<6;i++){await message(graph,i);if(i===3){api['/api/comms/open'].items=[];await graph.evaluate(()=>window.__refetchAgents());}await pause(2000);}
 report.comparison.after=await inspect(graph);await page.screenshot({path:join(output,'side-by-side-after.png')});
 const videoPath=await page.video().path();await ctx.close();recording=null;
 copyFileSync(videoPath,join(output,'prototype-and-app.webm'));
}catch(e){report.errors.push({phase:'comparison',error:e.stack??String(e)});if(recording)await recording.close();}
save();

// Reset the controlled traffic after recording before the separate CPU observation.
links.splice(0,links.length,...JSON.parse(initialLinks));api['/api/comms/feed']=JSON.parse(initialFeed);api['/api/comms/open']=JSON.parse(initialOpen);
// CPU observation is deliberately separate from video encoding and the prototype's animation.
function processes(){return execFileSync('ps',['-axo','pid=,ppid=,time=,command='],{encoding:'utf8'}).split('\n').flatMap(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);if(!m)return[];let seconds=0;for(const part of m[3].split(':'))seconds=seconds*60+Number(part);return[{pid:Number(m[1]),ppid:Number(m[2]),cpu:seconds,command:m[4]}]});}
let measuring;
try{
 const {ctx,page}=await context('cpu');measuring=ctx;await page.goto('http://graph.test/test/controllerGraphBrowser.html?at=%2Fcomms%2Fchart',{waitUntil:'load'});await page.waitForSelector('.comms-node');await pause(3000);
 await page.screenshot({path:join(output,'graph-1920x940-dark.png')});report.graphContext=await inspect(page);
 report.geometry=await page.evaluate(()=>{const names=[...document.querySelectorAll('.comms-node-name')].map(n=>{const r=n.getBoundingClientRect();return{id:n.closest('.comms-node')?.getAttribute('data-id'),text:n.textContent,rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}}});const overlaps=[];for(let i=0;i<names.length;i++)for(let j=i+1;j<names.length;j++){const a=names[i].rect,b=names[j].rect;if(Math.min(a.right,b.right)>Math.max(a.left,b.left)&&Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top))overlaps.push([names[i].id,names[j].id]);}return{names,overlaps,clipped:names.filter(n=>n.rect.left<0||n.rect.right>innerWidth||n.rect.top<0||n.rect.bottom>innerHeight).map(n=>n.id)};});
 const root=processes().filter(p=>p.command.includes(`--user-data-dir=${join(output,'profile-cpu')}`)&&!p.command.includes('--type='));if(root.length!==1)throw Error('Cannot uniquely identify isolated Chrome root');report.browserRoot=root[0];
 const seen=new Map();function sample(){const ps=processes();let ids=new Set([root[0].pid]);for(;;){const next=new Set([...ids,...ps.filter(p=>ids.has(p.ppid)).map(p=>p.pid)]);if(next.size===ids.size)break;ids=next;}for(const p of ps)if(ids.has(p.pid))seen.set(p.pid,p);const all=[...seen.values()];return{at:Date.now(),wall:performance.now(),treeCPU:all.reduce((n,p)=>n+p.cpu,0),rendererCPU:all.filter(p=>p.command.includes('--type=renderer')).reduce((n,p)=>n+p.cpu,0),processes:all.map(p=>({pid:p.pid,cpu:p.cpu,renderer:p.command.includes('--type=renderer')}))};}
 async function phase(name,seconds,burst=false){const start=sample(),samples=[start],frames=[];let sent=0;const messageOffsetsMs=[];for(let second=1;second<=seconds;second++){if(burst&&second%3===1){messageOffsetsMs.push(performance.now()-start.wall);await message(page,100+sent);sent++;}await pause(Math.max(0,start.wall+second*1000-performance.now()));const before=performance.now();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>r(true))));frames.push(performance.now()-before);samples.push(sample());}const end=samples.at(-1),elapsed=(end.wall-start.wall)/1000;const result={name,seconds:elapsed,messages:sent,messageOffsetsMs,treeCPUPercent:100*(end.treeCPU-start.treeCPU)/elapsed,rendererCPUPercent:100*(end.rendererCPU-start.rendererCPU)/elapsed,maxFrameRoundTripMs:Math.max(...frames),samples};report.phases.push(result);save();return result;}
 await phase('idle graph',30);await phase('20-message burst',60,true);
 await page.evaluate(()=>{history.pushState(null,'','/');dispatchEvent(new PopStateEvent('popstate'));});await pause(2000);report.afterUnmount=await inspect(page);const startRequests=report.requests.length;await phase('graph unmounted on Overview',30);report.afterUnmount.graphResourceRequests=report.requests.slice(startRequests).filter(r=>['/api/comms/links','/api/comms/open','/api/comms/feed'].includes(r.path));
 const realNames=['FLIGHT','GUIDO-1','GUIDO-2','GUIDO-CX','INCO-1','INCO-CX','RETRO-1','RETRO-CX','FAO-1','OPS-1'];rows.forEach((r,i)=>r.displayCallSign=realNames[i]);
 await page.evaluate(()=>{history.pushState(null,'','/comms/chart');dispatchEvent(new PopStateEvent('popstate'));window.__refetchAgents();});await page.waitForSelector('.comms-node-name');await pause(1000);report.realisticNamesContext=await inspect(page);report.realisticNamesGeometry=await page.evaluate(()=>{const names=[...document.querySelectorAll('.comms-node-name')].map(n=>{const r=n.getBoundingClientRect();return{text:n.textContent,left:r.left,right:r.right,top:r.top,bottom:r.bottom}});const overlaps=[];for(let i=0;i<names.length;i++)for(let j=i+1;j<names.length;j++){const a=names[i],b=names[j];if(Math.min(a.right,b.right)>Math.max(a.left,b.left)&&Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top))overlaps.push([a.text,b.text]);}return{names,overlaps,clipped:names.filter(n=>n.left<0||n.right>innerWidth||n.top<0||n.bottom>innerHeight)};});await page.screenshot({path:join(output,'graph-realistic-names-1920x940-dark.png')});
 await ctx.close();measuring=null;
}catch(e){report.errors.push({phase:'cpu',error:e.stack??String(e)});if(measuring)await measuring.close();}
sourceCheck();report.endedAt=new Date().toISOString();report.artifacts=readdirSync(output).filter(x=>/\.(png|webm)$/.test(x)).map(name=>({name,sha256:createHash('sha256').update(readFileSync(join(output,name))).digest('hex')}));save();
console.log(JSON.stringify({output,errors:report.errors,phases:report.phases.map(({samples,...p})=>p),artifacts:report.artifacts}));
