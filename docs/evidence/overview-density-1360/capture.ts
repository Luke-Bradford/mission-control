import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NOW } from './codex-overview-density/apps/web/test/fixtures.ts';
import { overviewDensityFixture } from './codex-overview-density/apps/web/test/overviewDensityFixtures.ts';
import { decodePng, diffImages } from './codex-overview-density/apps/server/src/pr-evidence/png.ts';

const controller=import.meta.dirname, afterRoot=join(controller,'codex-overview-density'),beforeRoot=join(controller,'codex-overview-density-baseline15205');
const destination=process.argv[2];if(!destination)throw Error('Give a private capture output directory');
const out=join(destination,'images');mkdirSync(out,{recursive:true,mode:0o700});
const {build}=await import(pathToFileURL(createRequire(join(afterRoot,'apps/web/package.json')).resolve('vite')).href);
const {chromium}=createRequire(join(afterRoot,'apps/server/package.json'))('playwright-core');
const cache=join(homedir(),'Library/Caches/ms-playwright');
const browserPath=process.env.MC_BROWSER_EXECUTABLE??readdirSync(cache).filter(x=>x.startsWith('chromium_headless_shell-')).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})).flatMap(x=>readdirSync(join(cache,x)).filter(d=>d.startsWith('chrome-headless-shell')).map(d=>join(cache,x,d,'chrome-headless-shell'))).find(existsSync);
if(!browserPath)throw Error('No real browser');
const sourceSha=(root:string)=>execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
if(execFileSync('git',['status','--porcelain','--','apps/web/src','apps/web/test'],{cwd:afterRoot,encoding:'utf8'}).trim())throw Error('Final capture needs committed web source and harness');
if(execFileSync('git',['status','--porcelain','--','apps/web/src'],{cwd:beforeRoot,encoding:'utf8'}).trim())throw Error('Baseline production source must match its commit');
const versions=[{name:'before',root:beforeRoot,sha:sourceSha(beforeRoot)},{name:'after',root:afterRoot,sha:sourceSha(afterRoot)}];
for(const file of ['overviewDensityBrowser.html','overviewDensityBrowser.tsx'])copyFileSync(join(afterRoot,'apps/web/test',file),join(beforeRoot,'apps/web/test',file));
const cases:any[]=[];
for(const scheme of ['light','dark']){
  for(const [width,height]of[[1280,900],[1440,900],[1600,1000],[1920,1080],[2560,1440],[1600,700]])
    for(const state of width===2560?['folded','expanded']:['default','expanded'])cases.push({key:`overview-${width}x${height}-${scheme}-${state}`,width,height,scheme,state,scenario:'default'});
  for(const width of [1280,1600,1920])
    for(const state of ['default','expanded'])cases.push({key:`long-${width}x1000-${scheme}-${state}`,width,height:1000,scheme,state,scenario:'long'});
  for(const scenario of ['empty','one','many','long','loading','error','stale','disconnected'])cases.push({key:`state-${scenario}-1600x700-${scheme}`,width:1600,height:700,scheme,state:'expanded',scenario});
}
for(const scheme of ['light','dark']) {
 for(const state of ['default','expanded'])cases.push({key:`mixed-1600x1000-${scheme}-${state}`,width:1600,height:1000,scheme,state,scenario:'mixed'});
 cases.push({key:`subcent-1600x1000-${scheme}-expanded`,width:1600,height:1000,scheme,state:'expanded',scenario:'subcent'});
}
const receipts:any[]=[],focused:any[]=[];
for(const version of versions){
  const root=join(version.root,'apps/web'),buildDir=join(destination,`${version.name}-build`);
  await build({root,configFile:join(root,'vite.config.ts'),logLevel:'error',build:{outDir:buildDir,emptyOutDir:true,rollupOptions:{input:join(root,'test/overviewDensityBrowser.html')}}});
  const browser=await chromium.launch({executablePath:browserPath,headless:true});
  try{
    for(const c of cases){
      const context=await browser.newContext({viewport:{width:c.width,height:c.height},deviceScaleFactor:1,colorScheme:c.scheme});
      const page=await context.newPage(),errors:string[]=[];const browserVersion=browser.version();page.on('pageerror',(e:Error)=>errors.push(e.message));
      const fixture=overviewDensityFixture(c.scenario==='subcent'?'default':c.scenario);
      if(c.scenario==='subcent') fixture.summary.kpis.spendToday.series=Array.from({length:30},(_,i)=>i===5?0:i%2?.002:.001);
      const api=fixture.api;
      const apiSha256=createHash('sha256').update(JSON.stringify(api)).digest('hex');
      await page.route('**/*',async(route:any)=>{
        const url=new URL(route.request().url()),key=url.pathname+url.search;
        if(url.origin!=='http://mc.test'){await route.abort();return;}
        if(key in api){await route.fulfill({contentType:'application/json',body:JSON.stringify(api[key])});return;}
        const file=normalize(join(buildDir,url.pathname));
        if(file.startsWith(buildDir)&&existsSync(file)&&statSync(file).isFile()){
          await route.fulfill({contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.png':'image/png'}as Record<string,string>)[extname(file)]??'application/octet-stream',body:readFileSync(file)});return;
        }
        await route.fulfill({status:404,contentType:'application/json',body:'{"error":"Controlled fixture route not supplied"}'});
      });
      try{
        await page.goto(`http://mc.test/test/overviewDensityBrowser.html?state=${c.scenario}`,{waitUntil:'load'});
        await page.waitForSelector('#agentsList');
        await page.waitForFunction((scenario:string)=>{
          const view=document.querySelector('#page-overview');
          const text=view?.textContent??'';
          if(scenario==='loading')return !!view&&!!document.querySelector('.crew-skeleton');
          if(scenario==='error')return text.includes('Could not load overview metrics');
          if(scenario==='empty')return document.querySelector('#agentsList')?.getAttribute('aria-busy')==='false'&&!!view?.querySelector('#machP [title="No machine sample yet"]');
          return ['41.2k','41%','63%','12%'].every(v=>text.includes(v))&&['20.5','412'].every(v=>(document.querySelector('#machP')?.textContent??'').includes(v))&&document.querySelectorAll('#agentsList .trow:not(.head)').length===(scenario==='one'?1:scenario==='many'?50:scenario==='mixed'?9:11);
        },c.scenario);
        await page.evaluate(async()=>{await document.fonts.ready;await new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())));});
        if(c.state==='folded'){
          const control=page.locator('[title="Collapse FLIGHT to its rail"]');
          if(await control.isVisible())await control.click();
        }
        if(c.state==='expanded'){
          const control=page.locator('#dock .dockrail button');
          if(await control.isVisible())await control.click();
        }
        if(c.scenario==='mixed' && await page.locator('.loops-strip .loop-chip').count()!==2)throw Error('Mixed fixture lost an observed loop');
        if(c.scenario==='subcent' && version.name==='after') {
          await page.selectOption('[aria-label="Measured Overview history"]','spend');
          await page.waitForFunction(()=>document.querySelector('.measured-reading')?.textContent?.includes('~$0.002 USD/min'));
        }
        if(errors.length)throw Error(`${version.name}/${c.key}: ${errors.join('; ')}`);
        const metrics=await page.evaluate(()=>{const shell=document.querySelector('.shell')as HTMLElement;const crew=document.querySelector<HTMLElement>('#agentsList');return{kpiHeights:[...document.querySelectorAll('.overview-kpi')].map(e=>e.getBoundingClientRect().height),crewColumns:[...document.querySelectorAll<HTMLElement>('#agentsList .head > *')].map(e=>({label:e.textContent,width:e.getBoundingClientRect().width,textAlign:getComputedStyle(e).textAlign})),crewRows:document.querySelectorAll('#agentsList .trow:not(.head)').length,crewScroll:crew?{height:crew.clientHeight,contentHeight:crew.scrollHeight,overflow:getComputedStyle(crew).overflowY}:null,panels:[...document.querySelectorAll<HTMLElement>('#page-overview .panel')].map(e=>({id:e.id,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,scroll:e.scrollHeight,client:e.clientHeight})),docWidth:document.documentElement.scrollWidth,width:innerWidth,gutter:getComputedStyle(shell).paddingLeft,mainWidth:document.querySelector('main')?.getBoundingClientRect().width,firstCrewRowHeight:document.querySelector('.trow:not(.head)')?.getBoundingClientRect().height,dockWidth:document.querySelector('#dock')?.getBoundingClientRect().width,collapsed:document.querySelector('#dock')?.classList.contains('collapsed')};});
        if(metrics.docWidth>c.width)throw Error(`${version.name}/${c.key}: horizontal overflow`);
        const file=`${c.key}-${version.name}.png`;await page.screenshot({path:join(out,file)});
        receipts.push({...c,apiSha256,browserVersion,deviceScaleFactor:1,readiness:c.scenario==='loading'?'Deliberately pending APIs':c.scenario==='error'?'Controlled 503 collection failure':c.scenario==='empty'?'Zero crew seats and empty machine sample':'Awaited quota 41%/63%/12%, Machine 20.5/412 and exact crew row count',interaction:c.scenario==='subcent'?(version.name==='after'?'Selected existing cost history; no additional API request':'Detailed history selector absent at baseline; same sub-cent API readings supplied'):'Initial settled page and requested rail state',version:version.name,sourceSha:version.sha,file,sha256:createHash('sha256').update(readFileSync(join(out,file))).digest('hex'),metrics,pageErrors:errors,capturedAt:Date.now(),provenance:'Controlled fictional Overview APIs, frozen fixture clock, actual full production App and CSS at 1x. No live-data claim. Viewport capture; lower content is reached through real page/list scrolling.'});
        const focusTargets=c.scenario==='mixed'?['agentsP']:c.scenario==='subcent'?['overviewHistoryP']:c.scenario==='long'?['agentsP']:c.scenario==='default'&&c.height!==700&&[1280,1600,1920].includes(c.width)?['overview-metrics','agentsP',...([1600,1920].includes(c.width)?['quotaP','quotaSummaryP','overviewHistoryP']:[]),...(c.width===1920?['pipelineP','timelineP','machP','overviewNextP']:[])]:[];
        for(const id of focusTargets){
          const locator=page.locator(id==='overview-metrics'?'.overview-metrics':`#${id}`);
          if(!await locator.count()){
            focused.push({...c,apiSha256,id,key:`${c.key}-${id}`,version:version.name,sourceSha:version.sha,file:null,provenance:'This component did not exist at the baseline source. Full-App viewport comparison is retained; no substitute screenshot is presented as this component.'});
            continue;
          }
          const focusFile=`${c.key}-${id}-${version.name}.png`;
          await locator.screenshot({path:join(out,focusFile)});
          focused.push({...c,apiSha256,id,key:`${c.key}-${id}`,version:version.name,sourceSha:version.sha,file:focusFile,sha256:createHash('sha256').update(readFileSync(join(out,focusFile))).digest('hex'),capturedAt:Date.now(),provenance:'Focused changed panel from the same full-App page, after real scrollIntoView; distinct from viewport frame.'});
        }
        if(errors.length)throw Error(`${version.name}/${c.key}: ${errors.join('; ')}`);
      }finally{await context.close();}
      if(receipts.length%10===0)console.log(`${version.name}: ${receipts.length} actual captures retained`);
    }
  }finally{await browser.close();}
}
const pairs=[];
for(const c of cases){const before=receipts.find(r=>r.key===c.key&&r.version==='before'),after=receipts.find(r=>r.key===c.key&&r.version==='after');if(!before||!after)throw Error('Missing actual pair');if(before.apiSha256!==after.apiSha256)throw Error('Mismatched fixture data in actual pair');
 const diff=diffImages(decodePng(readFileSync(join(out,before.file))),decodePng(readFileSync(join(out,after.file))));const file=`${c.key}-diff.png`;writeFileSync(join(out,file),diff.png);pairs.push({...c,before:before.file,after:after.file,diff:file,changedPixels:diff.changedPixels,changedPercent:diff.changedPercent});}
const focusedPairs=[];
for(const before of focused.filter(r=>r.version==='before')){
  const after=focused.find(r=>r.key===before.key&&r.version==='after');
  if(!after)throw Error(`Missing focused result ${before.key}`);if(before.apiSha256!==after.apiSha256)throw Error('Mismatched focused fixture data');
  if(!before.file||!after.file){focusedPairs.push({key:before.key,before:before.file,after:after.file,diff:null,note:'Component absent in this source; see full-App pairs.'});continue;}
  const diff=diffImages(decodePng(readFileSync(join(out,before.file))),decodePng(readFileSync(join(out,after.file))));
  const file=`${before.key}-diff.png`;writeFileSync(join(out,file),diff.png);
  focusedPairs.push({key:before.key,before:before.file,after:after.file,diff:file,changedPixels:diff.changedPixels,changedPercent:diff.changedPercent,note:'Focused actual panel bounds can differ; pixel comparison uses the maximum canvas dimensions without rescaling.'});
}
const proof={captureHelperSha256:createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex'),designReference:'9111bd62bf42abf98fd831123f6fab78819acc41',deliveredMain:'f7ee4e26c2085997b31b37f1ab3585691da68a9b',harnessSha256:createHash('sha256').update(readFileSync(join(afterRoot,'apps/web/test/overviewDensityBrowser.tsx'))).digest('hex'),fixtureSha256:createHash('sha256').update(readFileSync(join(afterRoot,'apps/web/test/overviewDensityFixtures.ts'))).digest('hex'),focused,focusedPairs,fixtureClock: new Date(NOW).toISOString(),versions:versions.map(({name,sha})=>({name,sha})),capturedAt:Date.now(),provenance:'Controlled fictional fixtures, actual baseline/final source browser captures. No live hub, crew/model/observed-loop action, GitHub write or real private image authority claim.',cases:cases.length,captures:receipts.length,pairs,receipts};
writeFileSync(join(destination,'capture-checks.json'),JSON.stringify(proof,null,2),{mode:0o600});console.log(JSON.stringify({destination,versions:proof.versions,cases:cases.length,captures:receipts.length,pairs:pairs.length,pageErrors:receipts.reduce((n,r)=>n+r.pageErrors.length,0)}));
