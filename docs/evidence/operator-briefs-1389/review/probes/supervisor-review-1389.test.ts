import "./supervisor-harness.ts";
import {expect,it} from "vitest";
import {withinBriefDispatch,checkBriefDispatch} from "../src/brief-dispatch.ts";
import {make,seatState,store,until,userLines} from "./supervisor-harness.ts";
it("REVIEW1389 engine send-back retains final brief guard in queued provider send",async()=>{
 const {sup}=make(); sup.start();
 const {runId}=await sup.startRun("guido-1",42);
 await until(()=>expect(seatState("guido-1")).toBe("idle"));
 let current=true; let checks=0;
 const delivery=withinBriefDispatch(()=>{checks++;if(!current)throw new Error("Bound source changed");},()=>{
  checkBriefDispatch();
  const sent=sup.send(runId,"review1389-controller-fail","Stale verdict must never reach provider");
  current=false;
  return sent;
 });
 let result:unknown; try { result=await delivery; } catch(e){result=String(e);}
 if(result==="sent") await until(()=>expect(userLines()).toHaveLength(2));
 console.info("REVIEW1389 final-send facts",{result,checks,lines:userLines().length});
 expect({checks,lines:userLines().length}).toEqual({checks:2,lines:1});
});
