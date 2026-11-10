import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,readdirSync,mkdirSync,existsSync} from 'node:fs';
import {join,normalize,extname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';

const wt='/private/tmp/mc-1513-complete-proposal';
const output=readFileSync('/tmp/mc-1513-complete-preview-path','utf8').trim();
const head='708bbe76f08196ad2ccde7368c0189f0bbc0f8a6';
const requireWeb=createRequire(join(wt,'apps/web/package.json'));
const {build}=await import(requireWeb.resolve('vite'));
const {chromium}=createRequire(join(wt,'apps/server/package.json'))('playwright-core');
const {desktopFixture}=await import(join(wt,'apps/web/test/desktopFixtures.ts'));
const {seatRow,NOW,boardItem}=await import(join(wt,'apps/web/test/fixtures.ts'));
const {proposalMessages,proposalTickets}=await import(join(wt,'apps/web/test/controller1513Data.ts'));
const report={kind:'design proposal, not product acceptance',head,startedAt:new Date().toISOString(),output,facts:[],errors:[],apiFailures:[],interactions:[],previewSources:[]};
const save=()=>writeFileSync(join(output,'receipt.json'),JSON.stringify(report,null,2));
if(execFileSync('git',['rev-parse','HEAD'],{cwd:wt,encoding:'utf8'}).trim()!==head)throw Error('Base head moved');
execFileSync('git',['diff','--exit-code','--','apps/web/src'],{cwd:wt});
for(const name of ['controller1513Data.ts','controller1513Preview.tsx','controller1513Preview.css']){const p=join(wt,'apps/web/test',name);report.previewSources.push({file:name,sha256:createHash('sha256').update(readFileSync(p)).digest('hex')});}
save();
const {api,rows}=desktopFixture('default');
for(const row of rows)row.displayCallSign=row.id.toUpperCase();
const flight=seatRow({id:'flight-1',index:rows.length,role:'FLIGHT',hudState:'running',run:null});
api['/api/crew?shape=summary']={rows:[...rows,flight],firstRunToday:null};
api['/api/away/digest']={active:false,groups:['needYouNow','safePrsReady','draftsToWalkThrough','failures','flightDecisions','messagesDrafted'].map(kind=>({kind,items:[]}))};
api['/api/flight/brief']={session:null,sections:[],watch:[],planned:[],drafts:[]};
flight.displayCallSign='FLIGHT';
const directs=new Map();let directNumber=0;
for(const row of rows){const messages=Array.from({length:12},(_,i)=>{const n=directNumber++;return{id:`direct:${row.id}:${i}`,at:NOW-(12-i)*60000,from:i%2?row.id:'CAPCOM',to:i%2?'CAPCOM':row.id,senderKind:i%2?'seat':'operator',operator:i%2===0,text:i%2?'The comparison is ready; the next step is recorded.':'Please retain the comparison with this ticket.',ticket:n<18?'shop-app#3350':n<27?'shop-app#3351':n<33?'shop-app#3352':null,label:null,ref:null,replyTo:i===1?`direct:${row.id}:0`:null,mentions:[],reactions:[],pinned:false};});directs.set(row.id,messages);api[`/api/comms/agents/${row.id}?summary=1`]={contacts:[{id:'CAPCOM',count:12,lastAt:NOW-60000}],unread:row.id==='guido-1'?1:0,directUnread:row.id==='guido-1'?1:0};}
const guidoHub=directs.get('guido-1');
for(let i=10;i<12;i++){const m=guidoHub[i];m.from=i%2?'MC':'guido-1';m.to=i%2?'guido-1':'MC';m.senderKind=i%2?'hub':'seat';m.operator=false;m.text=i%2?'The check request settled when the pull request merged.':'Please retain this notice in the ticket record.';}
const contactsFor=id=>id==='guido-1'?[{id:'CAPCOM',count:10},{id:'MC',count:2}]:[{id:'CAPCOM',count:12}];
api['/api/comms/agents/guido-1?summary=1']={contacts:contactsFor('guido-1'),unread:1,directUnread:1};
const flightMessages=proposalMessages.slice(-6).map((m,i)=>({...m,id:`flight:${i}`,from:i%2?'flight-1':'CAPCOM',to:i%2?'CAPCOM':'flight-1',senderKind:i%2?'flight':'operator',operator:i%2===0,ticket:null}));
const controllerMessages=proposalMessages.slice(-5).map((m,i)=>({...m,id:`controller:${i}`,from:i%2?'flight-1':'CONTROLLER',to:i%2?'CONTROLLER':'flight-1',senderKind:i%2?'flight':'controller',operator:false,ticket:null}));
const all=[...proposalMessages,...[...directs.values()].flat(),...flightMessages,...controllerMessages];
for(const t of proposalTickets){const n=all.filter(m=>m.ticket===`shop-app#${t.number}`).length;if(n!==t.count)throw Error(`Fixture count ${t.number}: ${n} differs from ${t.count}`);}
const response=messages=>({messages,hasMore:false,unread:0});
Object.assign(api,{'/api/comms/crew':response(proposalMessages),'/api/comms/crew?history=1':response(proposalMessages),'/api/comms/flight':response(flightMessages),'/api/comms/mentions':{mentions:[]},'/api/comms/pins':{messages:[]},'/api/comms/read':{ok:true},'/api/comms/links':{links:rows.map((r,i)=>({from:r.id,to:'CAPCOM',count:12,lastAt:NOW-60000,lastId:`direct:${r.id}:11`,lastText:'The comparison is ready.'}))},'/api/comms/open':{items:[]},'/api/comms/feed':{messages:proposalMessages.slice(-6)},'/api/comms/chatter':{pairs:[]},'/api/comms/traffic':{hours:rows.map(r=>({from:r.id,to:'CAPCOM',count:12,hour:NOW-3600000}))},'/api/comms/metrics':{p95BySeat:[],bySeat:[]},'/api/boards/shop-app':proposalTickets.map(t=>boardItem({issueNumber:t.number,title:t.title,status:t.status})), '/api/comms/agents/flight-1?summary=1':{contacts:[{id:'CAPCOM',count:6},{id:'CONTROLLER',count:5}],unread:0,directUnread:0}});
writeFileSync(join(output,'fixture.json'),JSON.stringify({fictional:true,clock:NOW,api,allRecordedMessages:all.length,ticketCounts:proposalTickets},null,2));
const previewFile=join(wt,'apps/web/test/controller1513Preview.tsx');
for(const stage of ['before','after'])await build({root:join(wt,'apps/web'),configFile:join(wt,'apps/web/vite.config.ts'),logLevel:'silent',plugins:stage==='after'?[{name:'controller-proposal-only',enforce:'pre',resolveId(id){if(/\/(CommsNav|TicketsList|CommsGraph)\.tsx$/.test(id)||id.endsWith('/pages/TicketPage.tsx'))return previewFile;}}]:[],build:{outDir:join(output,stage),emptyOutDir:true,rollupOptions:{input:join(wt,'apps/web/test/desktopBrowser.html')}}});
const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml','.png':'image/png'};
const contexts=new Map();
function answer(path,method){
 if(method!=='GET')return path.startsWith('/api/comms/read')||path.startsWith('/api/comms/mentions/seen')?{status:200,data:{ok:true}}:{status:409,data:{error:'This design preview does not send messages.'}};
 if(path in api)return{status:200,data:api[path]};
 const url=new URL(path,'http://fixture.test');const p=url.pathname;
 if(p==='/api/comms/crew')return{status:200,data:response(proposalMessages)};
 if(p==='/api/comms/flight')return{status:200,data:response(flightMessages)};
 if(p.startsWith('/api/comms/agents/')){const parts=p.split('/');const id=decodeURIComponent(parts[4]??'');if(parts[5]==='contacts'){const contact=decodeURIComponent(parts[6]??'');const list=id==='flight-1'?(contact==='CONTROLLER'?controllerMessages:flightMessages):(directs.get(id)??[]).filter(m=>m.from===contact||m.to===contact);return{status:200,data:response(list)};}if(parts[5]==='inbox')return{status:200,data:response(directs.get(id)??[])};if(directs.has(id))return{status:200,data:{contacts:contactsFor(id),messages:directs.get(id),unread:0,directUnread:0}};}
 if(p.startsWith('/api/comms/tickets/')){const ref=decodeURIComponent(p.slice('/api/comms/tickets/'.length)),key=url.searchParams.get('ticket')??`shop-app${ref}`,t=proposalTickets.find(t=>key===`shop-app#${t.number}`);return{status:200,data:{...response(all.filter(m=>m.ticket===key)),ticket:{ref,linkedPr:null,title:t?.title??null,status:t?.status??null,owner:'GUIDO-1',repoId:'shop-app',issueNumber:t?.number??null}}};}
 if(p.startsWith('/api/tickets/')){const number=Number(p.split('/').at(-1)),t=proposalTickets.find(t=>t.number===number)??proposalTickets[0];return{status:200,data:{repoId:'shop-app',number,title:t.title,url:`https://github.com/octo-org/shop-app/issues/${number}`,state:'open',status:t.status,priority:'p1',size:'M',labels:['type:feature'],outcome:'Quotes load from the cache.',doneWhen:[{text:'The comparison is recorded',checked:true},{text:'Eviction is covered',checked:false}],body:'## Outcome\nQuotes load from the cache.',bodyTruncated:false,githubError:null,runs:[],prs:[],timeline:all.filter(m=>m.ticket===`shop-app#${number}`).map(m=>({key:m.id,kind:'comms',id:m.id,at:m.at,from:m.from,to:m.to,label:m.label,text:m.text})).reverse(),nextBefore:null}};}
 return{status:404,data:{error:'Not in this controlled fixture'}};
}
const server=createServer((req,res)=>{const url=new URL(req.url,'http://127.0.0.1');let stage=url.searchParams.get('captureStage')??'after';const referer=req.headers.referer??'';if(referer.includes('captureStage=before'))stage='before';if(req.headers.cookie?.includes('capture-stage=before'))stage='before';if(url.pathname.startsWith('/api/')){const r=answer(url.pathname+url.search,req.method);if(r.status===404)report.apiFailures.push({path:req.url,stage});res.writeHead(r.status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(r.data));return;}const root=join(output,stage);let file=normalize(join(root,url.pathname));if(!file.startsWith(root+'/')||!existsSync(file)||!extname(file))file=join(root,'test/desktopBrowser.html');res.writeHead(200,{'content-type':mime[extname(file)]??'application/octet-stream','cache-control':'no-store'});res.end(readFileSync(file));});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(7461,'127.0.0.1',resolve)});
report.previewURL='http://127.0.0.1:7461/test/desktopBrowser.html?path=%2Fcomms%2Fcrew';save();
console.log(JSON.stringify({phase:'preview server ready',url:report.previewURL,output}));
const browser=await chromium.launch({executablePath:'/Users/lukebradford/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell',headless:true});
try{
 for(const [width,height] of [[1280,900],[1600,1000],[1920,940],[1600,700]])for(const theme of ['dark','light'])for(const stage of ['before','after']){
  const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:1,colorScheme:theme});await context.addCookies([{name:'capture-stage',value:stage,url:'http://127.0.0.1:7461'}]);const page=await context.newPage();page.on('pageerror',e=>report.errors.push({stage,width,height,theme,error:e.stack??String(e)}));
  try{await page.goto(`http://127.0.0.1:7461/test/desktopBrowser.html?captureStage=${stage}`,{waitUntil:'load'});await page.click('a[href="/comms"]');await page.waitForSelector('.comms-nav-top');await page.click('.comms-nav-top:nth-of-type(2)');await page.waitForSelector('.comms-bubble');await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   const facts={stage,width,height,theme,capturedAt:new Date().toISOString(),comms:await page.evaluate(()=>({sideScroll:document.documentElement.scrollWidth-innerWidth,body:document.body.innerText,mentionsVisible:[...document.querySelectorAll('.comms-mentions')].some(n=>n.getClientRects().length>0),fonts:document.fonts.status,dpr:devicePixelRatio,zoom:visualViewport?.scale,theme:getComputedStyle(document.documentElement).colorScheme}))};await page.screenshot({path:join(output,`comms-${stage}-${width}x${height}-${theme}.png`)});
   if(stage==='after'){await page.fill('#p1513-search','Quote cache');const n=await page.locator('.p1513-tickets li').count();if(n!==1)throw Error(`Search returned${n}`);await page.click('.comms-ticket-open');}else await page.click('.comms-ticket-open');
   await page.waitForSelector('.tk-event');await page.evaluate(()=>document.fonts.ready);facts.ticket=await page.evaluate(()=>({sideScroll:document.documentElement.scrollWidth-innerWidth,body:document.body.innerText,recordScroll:document.querySelector('.p1513-events')?.scrollHeight,recordHeight:document.querySelector('.p1513-events')?.clientHeight,pageHeight:document.documentElement.scrollHeight,viewportHeight:innerHeight}));await page.screenshot({path:join(output,`ticket-${stage}-${width}x${height}-${theme}.png`)});report.facts.push(facts);save();
  }catch(e){report.errors.push({stage,width,height,theme,error:e.stack??String(e)});save();}finally{await context.close();}
 }
}finally{await browser.close();}
execFileSync('git',['diff','--exit-code','--','apps/web/src'],{cwd:wt});report.captureEndedAt=new Date().toISOString();report.artifacts=readdirSync(output).filter(x=>x.endsWith('.png')).map(name=>({name,sha256:createHash('sha256').update(readFileSync(join(output,name))).digest('hex')}));report.serverPID=process.pid;save();console.log(JSON.stringify({phase:'capture complete; preview stays available',url:report.previewURL,output,facts:report.facts.length,errors:report.errors,apiFailures:[...new Set(report.apiFailures.map(x=>x.path))],images:report.artifacts.length}));
