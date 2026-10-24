import "./supervisor-harness.ts";

import type { Run, RunPlan } from "@mc/core";
import { describe, expect, it } from "vitest";
import { runView } from "../src/runview.ts";
import { boardCard, make, store, TICKET } from "./supervisor-harness.ts";

describe("run plan snapshot", () => {
  it.each([
    { body: "## Plan\n\nBuild it.", reported: true, plan: { by: "fao-1", at: 100, ref: "mc#42" } },
    { body: "## Plan\n\nBuild it.", reported: false, plan: { by: null, at: null, ref: "mc#42" } },
    { body: TICKET.body, reported: false, plan: { skipped: "Size S" } },
  ] satisfies { body: string; reported: boolean; plan: RunPlan }[])(
    "records and serves $plan",
    async ({ body, reported, plan }) => {
      if (reported) {
        const planner: Run = {
          id: "planner",
          agentId: "fao-1",
          repoId: "mc",
          seq: 1,
          startedAt: 1,
          endedAt: 100,
          status: "ok",
          sessionId: null,
          model: null,
          branch: null,
          ticket: "mc#42",
          costUsd: null,
          tokens: null,
          transcriptPath: "",
          prs: [],
          summary: null,
        };
        store.upsertRun(planner);
        store.addLoopEvent(`${planner.id}:plan`, planner.id, "Plan written", 100);
      }
      store.replaceBoard("mc", [boardCard(42, { size: reported ? "M" : "S" })]);
      const { sup, cfg } = make({ fetchTicket: async () => ({ ...TICKET, body }) });
      sup.start();
      const { runId } = await sup.startRun("guido-1", 42);
      const run = store.run(runId);
      if (run === null) throw new Error("missing run");
      expect(run.plan).toEqual(plan);
      expect(runView(cfg, store, run, new Map()).plan).toEqual(plan);
    },
  );
});
