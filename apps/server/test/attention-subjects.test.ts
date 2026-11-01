import { NEW_LOOP, type Run } from "@mc/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { confirmedResumeAfter, pendingRunApproval } from "../src/attention-subjects.ts";
import { resolvedCommsReason } from "../src/comms.ts";
import { Store } from "../src/store.ts";

let store: Store;
const run = (patch: Partial<Run> = {}): Run => ({
  id: "run",
  agentId: "seat",
  repoId: "repo",
  seq: 1,
  startedAt: 1,
  endedAt: null,
  status: "running",
  sessionId: null,
  model: null,
  branch: "feature/7",
  ticket: "repo#7",
  costUsd: null,
  tokens: null,
  transcriptPath: "",
  prs: [],
  summary: null,
  loop: NEW_LOOP,
  ...patch,
});
const pr = {
  repoId: "repo",
  number: 7,
  title: "PR",
  url: "u",
  branch: "feature/7",
  ticket: "repo#7",
  state: "merged" as const,
  isDraft: false,
  review: null,
  ci: null,
  createdAt: 1,
  updatedAt: 5,
  mergedAt: 5,
  headSha: "head",
  mergeable: null,
};
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());
it("uses an exact-head passing controller check, retaining missing, failed and old-head approvals", () => {
  store.upsertPullRequests("repo", [{ ...pr, state: "open", mergedAt: null }], 10);
  const r = run({
    loop: {
      ...NEW_LOOP,
      prNumber: 7,
      controllerCheckRequired: true,
      controllerCheck: { sha: "head", from: "ci", pass: true },
    },
  });
  expect(pendingRunApproval(store, r)).toBe(false);
  expect(
    pendingRunApproval(store, {
      ...r,
      loop: { ...(r.loop as typeof NEW_LOOP), controllerCheck: undefined },
    }),
  ).toBe(true);
  expect(
    pendingRunApproval(store, {
      ...r,
      loop: {
        ...(r.loop as typeof NEW_LOOP),
        controllerCheck: { sha: "old", from: "ci", pass: true },
      },
    }),
  ).toBe(true);
});
it.each(["closed", "merged"] as const)(
  "retires approval display for a %s PR without clearing its saved controls",
  (state) => {
    const r = run({
      loop: {
        ...NEW_LOOP,
        prNumber: 7,
        controllerCheckRequired: true,
        mergeHold: { by: "CAPCOM", reason: "Pending approval", at: 2 },
        uat: { accepted: false, sha: "head", from: "ci" },
      },
    });
    store.upsertRun(r);
    store.upsertPullRequests("repo", [{ ...pr, state: "open", mergedAt: null }], 10);
    expect(pendingRunApproval(store, r)).toBe(true);
    const m = store.addComms({
      at: 4,
      from: "seat",
      to: "CAPCOM",
      ticket: "repo#7",
      text: "May I merge?",
      ref: "PR 7",
    });
    if (!m) throw Error("missing message");
    expect(resolvedCommsReason(store, m)).toBeNull();
    store.upsertPullRequests("repo", [{ ...pr, state }], 10);
    expect(pendingRunApproval(store, r)).toBe(false);
    expect(resolvedCommsReason(store, m)).toBe("The related PR resolved.");
    expect(store.run(r.id)?.loop).toEqual(r.loop);
  },
);
it("does not resolve a new ticket or PR question from an earlier merge", () => {
  store.upsertPullRequests("repo", [pr], 10);
  const m = store.addComms({
    at: 10,
    from: "flight",
    to: "CAPCOM",
    ticket: "repo#7",
    text: "What about the follow-up?",
  });
  if (!m) throw Error("missing message");
  expect(resolvedCommsReason(store, m, false)).toBeNull();
  expect(resolvedCommsReason(store, { ...m, ref: "PR 7" }, false)).toBeNull();
  store.upsertPullRequests("repo", [{ ...pr, mergedAt: 15, updatedAt: 15 }], 15);
  expect(resolvedCommsReason(store, m, false)).toBe("The related PR merged.");
});
it("honors a fixed CAPCOM target while disabling inference of a FLIGHT watch run", () => {
  store.upsertRun(run({ endedAt: 8 }));
  const m = store.addComms({
    at: 4,
    from: "CAPCOM",
    to: "crew",
    ticket: null,
    text: "Targeted blocker",
    label: "blocker",
    targetRunId: "run",
  });
  if (!m) throw Error("missing message");
  expect(resolvedCommsReason(store, m, false)).toBe("The related run ended.");
});
it("retains a budget-held ended run until the operator explicitly settles the question", () => {
  store.upsertRun(
    run({
      endedAt: 8,
      loop: {
        ...NEW_LOOP,
        phase: "parked",
        parked: { kind: "budget", reason: "Hold", ended: true },
      },
    }),
  );
  const m = store.addComms({
    at: 4,
    from: "seat",
    to: "CAPCOM",
    ticket: null,
    text: "Need approval",
    label: "blocker",
  });
  if (!m) throw Error("missing message");
  expect(resolvedCommsReason(store, m)).toBeNull();
  store.settleCommsItem(m.id, "CAPCOM", "Approved dismissal", 10);
  expect(resolvedCommsReason(store, m)).toBe("The conversation was settled.");
});
it("confirms the attempt start, preserving a newer blocker raised before init completed", () => {
  const r = run();
  store.upsertRun(r);
  store.addLoopEvent("run:resume-confirmed:8", r.id, "Session resumed", 12);
  expect(confirmedResumeAfter(store, r, 4)).toBe(true);
  expect(confirmedResumeAfter(store, r, 10)).toBe(false);
  const m = store.addComms({
    at: 4,
    from: "seat",
    to: "CAPCOM",
    ticket: null,
    text: "Blocked",
    label: "blocker",
  });
  if (!m) throw Error("missing message");
  expect(resolvedCommsReason(store, m)).toBe("The related run resumed.");
  expect(resolvedCommsReason(store, { ...m, at: 10 })).toBeNull();
});
it("keeps newer-ended sender and fixed-ended-target messages out of current crew despite an older active aside", () => {
  store.upsertRun(run({ id: "aside", startedAt: 1 }));
  store.upsertRun(run({ id: "newer", seq: 2, startedAt: 3, endedAt: 8 }));
  store.addComms({ at: 5, from: "seat", to: "crew", ticket: null, text: "Ended sender" });
  store.addComms({
    at: 6,
    from: "CAPCOM",
    to: "crew",
    ticket: null,
    text: "Ended target",
    targetRunId: "newer",
  });
  store.addComms({ at: 7, from: "CAPCOM", to: "crew", ticket: null, text: "General operator" });
  expect(store.commsPage({ crew: true }, 50, undefined, 0).rows.map((m) => m.text)).toEqual([
    "General operator",
  ]);
  expect(store.commsPage({ crew: true }, 50).rows).toHaveLength(3);
});
