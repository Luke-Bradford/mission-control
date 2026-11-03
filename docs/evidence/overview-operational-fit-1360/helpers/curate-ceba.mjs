import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync,existsSync,mkdirSync,readFileSync,readdirSync,statSync,writeFileSync} from 'node:fs';
import {join,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
const [controller,repo]=process.argv.slice(2); if(!controller||!repo)throw Error('Give the controller directory and repository worktree.');
const out=join(repo,'docs/evidence/overview-operational-fit-1360');
for(const name of ['current','baseline','diff','focus','history','records','helpers'])mkdirSync(join(out,name),{recursive:true});
const hash=x=>createHash('sha256').update(x).digest('hex');
const normalized=[];
function retain(src,dest){const body=readFileSync(src);mkdirSync(join(out,dest,'..'),{recursive:true});copyFileSync(src,join(out,dest));return{file:dest,sha256:hash(body),bytes:body.length};}
function textRecord(src,dest){const original=readFileSync(src),body=Buffer.from(original.toString().split(controller).join('$CONTROLLER'));mkdirSync(join(out,dest,'..'),{recursive:true});writeFileSync(join(out,dest),body);normalized.push({file:dest,originalSha256:hash(original),sha256:hash(body),normalization:body.equals(original)?'none':'controller-directory prefix replaced by $CONTROLLER'});}
const beforeDir=join(controller,'overview-operational-final-baseline'),afterDir=join(controller,'overview-operational-final-ceba037e');
const before=JSON.parse(readFileSync(join(beforeDir,'geometry.json'))),after=JSON.parse(readFileSync(join(afterDir,'geometry.json')));
const source=after[0].runtimeSource,base=before[0].runtimeSource;
execFileSync('git',['diff','--quiet',source,'--','apps/web/src'],{cwd:repo});
const selected=r=>r.facts.viewport.width>=1920||[
'normal-loops-1280x900-dpr1-light-folded.png','normal-loops-1440x900-dpr1-dark-open.png','normal-loops-1600x1000-dpr1-light-folded.png','normal-loops-1600x700-dpr1-dark-open.png'].includes(r.png.file);
const pairs=[];const derivations=[];
let png;
if(process.argv.includes('--images'))png=await import(pathToFileURL(join(repo,'apps/server/src/pr-evidence/png.ts')).href);
for(const a of after){const b=before.find(x=>x.png.file===a.png.file);if(!b||a.fixtureSha256!==b.fixtureSha256||a.fixtureClock!==b.fixtureClock||JSON.stringify(a.bindings)!==JSON.stringify(b.bindings))throw Error('Unmatched fixture/helper/clock '+a.png.file);
for(const [dir,r]of [[beforeDir,b],[afterDir,a]])if(hash(readFileSync(join(dir,r.png.file)))!==r.png.sha256)throw Error('PNG hash mismatch');
const keep=selected(a),key=a.png.file.replace(/\.png$/,'');
const pair={key,viewport:a.facts.viewport,theme:a.scheme,rail:a.state,baselineSource:base,renderedSource:source,baselineCapturedAt:b.capturedAt,capturedAt:a.capturedAt,fixtureClock:a.fixtureClock,apiSha256:a.fixtureSha256,bindings:a.bindings,retained:keep,before:keep?'baseline/'+a.png.file:null,after:keep?'current/'+a.png.file:null,diff:keep?'diff/'+key+'.png':null,baselinePng:b.png,currentPng:a.png,baselineFacts:b.facts,currentFacts:a.facts};
if(keep){retain(join(beforeDir,b.png.file),pair.before);retain(join(afterDir,a.png.file),pair.after);if(png){const diff=png.diffImages(png.decodePng(readFileSync(join(beforeDir,b.png.file))),png.decodePng(readFileSync(join(afterDir,a.png.file))));writeFileSync(join(out,pair.diff),diff.png);pair.changedPixels=diff.changedPixels;pair.changedPercent=diff.changedPercent;}}
pairs.push(pair);}
textRecord(join(beforeDir,'geometry.json'),'records/baseline-render-checks.json');textRecord(join(afterDir,'geometry.json'),'records/current-render-checks.json');
for(const name of ['OverviewOperational.browser.test.ts','overviewDensityFixtures.ts','overviewDensityBrowser.tsx','browserRunner.ts','fixture-api.json'])retain(join(afterDir,name),'helpers/'+name);
for(const name of ['fixtures.ts','desktopFixtures.ts','agentV2Fixture.ts','overviewDensityBrowser.html'])retain(join(repo,'apps/web/test',name),'helpers/'+name);
for(const [dir,names,prefix]of [
['overview-independent-c371',['text-enlargement-200percent.png','reader-history-end.png'],'c371-failed'],
['overview-independent-b45',['text-enlargement-200percent.png','reader-history-end.png','4K-reader-history-end.png','reader-provider.png','reader-timeline.png','reader-machine.png'],'b45-corrected'],
['overview-enlargement-baseline',['d192-text200-full.png','b45-text200-full.png','d192-keyboard-agent-detail.png','b45-keyboard-agent-detail.png'],'1392-inherited'],
['overview-operational-3a9-states',['overview-empty-1600x700-light-initial.png','overview-one-1600x700-dark-initial.png','overview-many-bottom-1600x700-light-after.png','overview-long-1280x1000-dark-folded-after.png','overview-loading-1600x700-light-initial.png','overview-error-1600x700-dark-initial.png','overview-stale-1600x700-light-after.png','overview-disconnected-1600x700-dark-after.png'],'3a9-states'],
['overview-operational-3a9-keyboard-paint-settled',['work-focus-after-pan-light.png','work-focus-after-pan-dark.png','allowance-narrow-reader-light.png','allowance-wide-reader-dark.png'],'3a9-keyboard']
])for(const name of names)retain(join(controller,dir,name),'history/'+prefix+'-'+name);
for(const dir of ['overview-independent-c371','overview-independent-b45','overview-independent-3a9','overview-enlargement-baseline'])for(const name of ['receipt.json','source-artifacts.json','check.mjs','run.log'])if(existsSync(join(controller,dir,name)))textRecord(join(controller,dir,name),'records/'+dir+'-'+name);
for(const name of ['review-1360-c37197aa.md','review-1360-b45f26dc.md','review-1360-3a9e66c0.md','review-1360-fc4a7d35.md','review-1360-enlargement-disposition.md','crew-text-enlargement-followup.md','review-1360-f4906650.md','overview-runtime-f490-public-summary.json','overview-ci-attempt1-public-summary.json'])textRecord(join(controller,name),'records/'+name);
for(const name of ['mc-overview-redesign-guard-units.log','mc-overview-redesign-reflow-units.log','mc-overview-b45-composition.log','mc-overview-provider-chrome-units.log','mc-overview-c371-reader-red.log','mc-overview-b45-correction-browser.log','mc-overview-focus-intent-red.log','mc-overview-focus-intent-green.log','mc-overview-focus-final-green.log','mc-overview-3a9-legacy-browser.log','mc-overview-3a9-layout-recheck.log','mc-overview-3a9-states-browser.log','mc-overview-3a9-subcent-keyboard.log','mc-overview-3a9-subcent-recheck.log','mc-overview-3a9-subcent-sticky-proof.log','mc-overview-3a9-keyboard-settled.log','mc-overview-3a9-keyboard-paint-settled.log','mc-overview-final-types.log','mc-overview-final-lint2.log','mc-overview-final-build.log','mc-overview-final-current-capture.log','mc-overview-final-baseline-capture.log','mc-overview-final-f490-normal.log','mc-overview-final-f490-combined.log','mc-overview-final-notices-units.log','mc-overview-final-notices-lint.log','mc-overview-final-notices-build.log','mc-overview-stale-combined-types.log','mc-overview-constrained-red.log','mc-overview-constrained-stale-red.log','mc-1393-ci-migration-format.log','mc-1393-ci-migration-five-files.log','mc-overview-ceba-types.log','mc-overview-ceba-lint.log','mc-overview-ceba-build.log','mc-overview-final-ceba-normal.log','mc-overview-final-ceba-combined.log'])textRecord(join('/tmp',name),'records/'+name);
for(const [dir,names]of [['overview-operational-3a9-keyboard-paint-settled',['context-scroll-trace-light.json','context-scroll-trace-dark.json','sticky-precondition-light.json','sticky-precondition-dark.json','work-focus-after-pan-light.json','work-focus-after-pan-dark.json']],['overview-operational-3a9-states',['render-checks.json']]])for(const name of names)textRecord(join(controller,dir,name),'records/'+dir+'-'+name);

const corrections=[];
for(const age of ['fresh','stale'])for(const scheme of ['light','dark']){
const redDir=join(controller,age==='fresh'?'overview-constrained-fc4a-red':'overview-constrained-13d-stale-red');
const redName=readdirSync(redDir).find(n=>n.endsWith('-'+scheme+'.json')&&(age==='fresh'||n.includes('-mixed-')));
const b=JSON.parse(readFileSync(join(redDir,redName)))[0];
const greenDir=join(controller,'overview-constrained-final-ceba037e');
const a=JSON.parse(readFileSync(join(greenDir,`constrained-${age}-mixed-${scheme}.json`)))[0];
if(a.apiSha256!==b.apiSha256)throw Error('Correction API mismatch '+age+scheme);
const key=`${age}-constraint-${scheme}`,before=retain(join(redDir,b.file),`history/${key}-before.png`),after=retain(join(greenDir,a.file),`focus/${key}-after.png`);
corrections.push({key,before,after,baselineSource:b.source,renderedSource:a.source,apiSha256:a.apiSha256,fixtureClock:a.fixtureClock,baselineCapturedAt:b.capturedAt,capturedAt:a.capturedAt,baselineFacts:b.facts,currentFacts:a.facts});
}
for(const name of readdirSync(join(controller,'overview-constrained-final-ceba037e')).filter(n=>n.endsWith('.json')))textRecord(join(controller,'overview-constrained-final-ceba037e',name),'records/final-'+name);
retain(join(repo,'apps/web/test/OverviewConstraintBudget.browser.test.ts'),'helpers/OverviewConstraintBudget.browser.test.ts');

if(png){for(const key of ['normal-loops-1920x1080-dpr1-light-folded','normal-loops-3840x2160-dpr1-dark-open']){const pair=pairs.find(x=>x.key===key);for(const panel of ['crew','metrics'])for(const [side,dir,facts]of [['before',beforeDir,pair.baselineFacts],['after',afterDir,pair.currentFacts]]){const r=png.decodePng(readFileSync(join(dir,key+'.png'))),box=facts[panel]??facts.primary?.[panel];if(!box)continue;const d=pair.viewport.dpr,x=Math.max(0,Math.floor(box.x*d)),y=Math.max(0,Math.floor(box.y*d)),w=Math.min(r.width-x,Math.ceil(box.width*d)),h=Math.min(r.height-y,Math.ceil(box.height*d));if(w<=0||h<=0)continue;const data=new Uint8Array(w*h*4);for(let row=0;row<h;row++)data.set(r.data.subarray(((y+row)*r.width+x)*4,((y+row)*r.width+x+w)*4),row*w*4);writeFileSync(join(out,'focus',key+'-'+panel+'-'+side+'.png'),png.encodePng({width:w,height:h,data}));derivations.push({file:'focus/'+key+'-'+panel+'-'+side+'.png',source:side==='before'?pair.baselineSource:pair.renderedSource,sourcePng:side==='before'?pair.baselinePng:pair.currentPng,cropCss:box,pixelRect:{x,y,width:w,height:h},method:'direct viewport intersection; no rerender'});}}}
if(png)writeFileSync(join(out,'derivations.json'),JSON.stringify(derivations,null,2));
writeFileSync(join(out,'render-checks.json'),JSON.stringify({generatedAt:new Date().toISOString(),baselineSource:base,renderedSource:source,totalPairs:pairs.length,retainedPairs:pairs.filter(x=>x.retained).length,corrections,method:'Same full-App harness, controlled source-shaped API JSON and frozen clock; actual viewport screenshots before acceptance assertions. Baseline readiness is not current-layout acceptance. Diff uses repository PNG tolerance24; crops intersect the actual viewport.',pairs},null,2));
writeFileSync(join(out,'records/normalization.json'),JSON.stringify(normalized,null,2));
writeFileSync(join(out,'README.md'),'# Overview operational fit — current controlled evidence\n\nRendered product `'+source+'` versus delivered baseline `'+base+'`. All values are fictional source-shaped data; no actual operational data is published. '+pairs.length+' matched full-App pairs / '+pairs.length*2+' renders were captured; '+pairs.filter(x=>x.retained).length+' pairs are retained here. The complete named matrix and all geometry/hash/source/clock bindings are in [render-checks.json](render-checks.json). Raw nonretained frames remain in the controller archive.\n\n'+pairs.filter(x=>x.retained).map(x=>'- '+x.key+': [before]('+x.before+'), [after]('+x.after+'), [diff]('+x.diff+').').join('\n')+'\n');
console.log(JSON.stringify({source,baseline:base,pairs:pairs.length,retained:pairs.filter(x=>x.retained).length,images:!!png}));
