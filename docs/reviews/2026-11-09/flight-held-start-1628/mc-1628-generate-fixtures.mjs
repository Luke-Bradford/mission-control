import {writeFileSync} from 'node:fs';
import {createFlightWatch as afterWatch} from '/tmp/mc-review-fix-1628/apps/server/src/flight/watch.ts';
import {createFlightWatch as beforeWatch} from '/tmp/mc-review-fix-1628/apps/server/src/flight/mc1628BaselineWatch.ts';
import {Store} from '/tmp/mc-review-fix-1628/apps/server/src/store.ts';
import {ChangeBus} from '/tmp/mc-review-fix-1628/apps/server/src/bus.ts';
import {attentionItems} from '/tmp/mc-review-fix-1628/apps/server/src/hud.ts';
const now=Date.UTC(2026,10,9,12,1);
const seats=[{id:'flight-1',role:'FLIGHT'},...['guido-1','guido-2','inco-1'].map(id=>({id,role:id.startsWith('inco')?'INCO':'GUIDO'}))].map(s=>({...s,accountId:'fixture-account',model:'fixture',area:[]}));
const config={operator:{id:'operator',timezone:'Europe/London'},accounts:[{id:'fixture-account',vendor:'claude',alertAt:80,stopAt:95}],repos:[{id:'shop-app',github:'fictional/shop-app',project:1,statusMap:{},autonomy:'draft'}],loops:[],poll:{usageMinutes:30,githubSeconds:60},crew:{worktrees:'/fictional/worktrees',maxSeats:4,sessions:[{id:'fixture',repoId:'shop-app',checkout:'/fictional/clone',seats}]}};
const result={fixture:'three overdue crew blockers; existing quota note; trusted operator message; pending seat change blocks start',now,phases:{}};
for(const [phase,createWatch] of [['before',beforeWatch],['after',afterWatch]]){
 const store=new Store(':memory:');const bus=new ChangeBus();let t=now-60000;let watch;
 try{
 store.setSeatSession({seatId:'flight-1',runId:null,cliSessionId:null,state:'idle',reason:null,worktree:null,updatedAt:now-3600000});
 store.addUsage({accountId:'fixture-account',window:'7d',at:t-1000,pct:95,resetAt:now+3600000,source:'fixture'});
 for(const [i,from] of ['guido-1','guido-2','inco-1'].entries())store.addComms({at:now-3600000,from,to:'flight-1',ticket:'shop-app#'+(101+i),text:['The cache check needs its recorded scope clarified.','The import check needs the existing dependency confirmed.','The layout check needs its accepted reference confirmed.'][i],label:'blocker'});
 watch=createWatch({config,store,bus,enabled:true,now:()=>t,blocked:()=>true,supervisor:{status:()=>({enabled:true,note:null}),on:()=>()=>{},busy:()=>[],seatFacts:()=>null,sessionAlive:()=>false,startWatch:async()=>{throw Error('Fixture must never start a provider')},send:async()=>{throw Error('Fixture must never send')},endRunByEngine:async()=>{},resumeRun:async()=>{throw Error('Fixture must never resume')}}});
 await watch.check();t=now;store.addComms({at:now,from:'CAPCOM',to:'flight-1',ticket:null,text:'Please review the waiting work.'});await watch.check();
 const attention=attentionItems(config,store,t);const own=attention.filter(x=>x.owner==='operator');if(own.length!==1||own[0].notTriaging?.keys.length!==3)throw Error('Fixture did not project one alert over three blockers: '+JSON.stringify(attention));
 if(phase==='after'&&!own[0].text.includes('message is saved'))throw Error('After fixture lacks safe reason');
 result.phases[phase]={attention,notes:store.notes(),operatorAlerts:own.length};
 }finally{watch?.stop();store.close()}
}
writeFileSync('/tmp/mc-1628-alert-fixtures.json',JSON.stringify(result,null,2));console.log(JSON.stringify({phases:Object.fromEntries(Object.entries(result.phases).map(([k,v])=>[k,{operatorAlerts:v.operatorAlerts,text:v.attention.find(x=>x.owner==='operator').text}]))}));
