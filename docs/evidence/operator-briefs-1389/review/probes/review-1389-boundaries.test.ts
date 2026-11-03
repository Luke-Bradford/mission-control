import { type AttentionBrief, type BriefAction, NEW_LOOP, OPERATOR_HEADER } from "@mc/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type AppDeps, buildApp } from "../src/api.ts";
import { bindCompleteBrief } from "../src/brief-prepare.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { FLIGHT_OPERATOR_ACTOR_HEADER } from "../src/flight/operator-call.ts";
import { attentionItems } from "../src/hud.ts";
import { Store } from "../src/store.ts";
import { liveBriefSeat } from "./brief-fixture.ts";

const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error("Missing fixture value");
  return value;
};

const AT = Date.parse("2026-11-03T12:00:00Z"),
  SHA = "a".repeat(40),
  KEY = "note:decision:target";
const config: CcConfig = {
  operator: { id: "operator", timezone: "UTC" },
  accounts: [{ id: "a", vendor: "claude", alertAt: 85, stopAt: 95 }],
  repos: [{ id: "repo", github: "o/repo", project: 1, statusMap: {}, autonomy: "merge" }],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
  crew: {
    worktrees: "/tmp/wt",
    maxSeats: 2,
    sessions: [
      {
        id: "s",
        repoId: "repo",
        checkout: "/tmp/co",
        seats: [
          { id: "FLIGHT-1", role: "FLIGHT", accountId: "a", model: "x", area: [] },
          { id: "GUIDO-1", role: "GUIDO", accountId: "a", model: "x", area: [] },
        ],
      },
    ],
  },
};
let store: Store;
let apps: ReturnType<typeof buildApp>[];
beforeEach(() => {
  store = new Store(":memory:");
  apps = [];
  liveBriefSeat(store, "FLIGHT-1", "flight", AT);
  liveBriefSeat(store, "GUIDO-1", "target", AT);
  store.addRunCommit({ runId: "target", repoId: "repo", branch: "feature/1", sha: SHA, at: AT });
  store.raiseNote({
    key: "decision:target",
    kind: "ready",
    runId: "target",
    seatId: "GUIDO-1",
    repoId: "repo",
    text: "A fixture operator decision",
    at: AT,
  });
});
afterEach(async () => {
  for (const app of apps) await app.close();
  store.close();
});
const app = (deps: Partial<AppDeps> = {}) => {
  const value = buildApp({
    config,
    store,
    bus: new ChangeBus(),
    now: () => AT,
    operatorToken: "operator-fixture",
    supervisor: {
      status: () => ({ enabled: true, note: null }),
    } as unknown as AppDeps["supervisor"],
    ...deps,
  });
  apps.push(value);
  return value;
};
async function brief(action: BriefAction, key = KEY) {
  const item = attentionItems(config, store, AT).find((entry) => entry.key === key);
  if (!item) throw new Error(`missing source ${key}`);
  const content: AttentionBrief = {
    for: "operator",
    at: AT,
    context: "The fixture needs a real operator choice.",
    ask: "Apply the displayed action?",
    recommendation: "Apply this fully specified action.",
    basis: "Retained fixture source",
    did: [],
    checked: [],
    decision: {
      whyOperator: {
        kind: "floor-approval",
        explanation: "This action needs the operator's explicit choice.",
      },
      consulted: [],
      costOfDelay: "The fixture remains waiting.",
      waiting: "An explicit operator choice.",
    },
    recommendedOptionId: "apply",
    options: [
      {
        id: "apply",
        label: "Apply",
        answer: "Apply the specified action.",
        consequence: "Perform only the typed displayed action.",
        reversibility: {
          kind: "partly-reversible",
          detail: "Depends on the exact displayed action.",
        },
        action,
      },
      {
        id: "wait",
        label: "Wait",
        answer: "Keep waiting.",
        consequence: "Keep the operator hold.",
        reversibility: { kind: "reversible", detail: "The operator can refresh this choice." },
        action: {
          kind: "attention-hold",
          reason: "Wait for the operator.",
          condition: { kind: "manual" },
        },
      },
    ],
  };
  const bound = await bindCompleteBrief({ config, store, now: () => AT }, item, content, {
    seatId: "FLIGHT-1",
    runId: "flight",
  });
  store.addBrief({ key, ...bound });
  const saved = required(store.briefs().get(key));
  return {
    briefId: required(saved.id),
    sourceRevision: required(saved.binding).sourceRevision,
    optionId: "apply",
    requestId: "request-one",
  };
}
const post = (
  a: ReturnType<typeof app>,
  payload: object,
  key = KEY,
  headers: Record<string, string> = {},
) =>
  a.inject({
    method: "POST",
    url: `/api/attention/${encodeURIComponent(key)}/choice`,
    headers: { [OPERATOR_HEADER]: "operator-fixture", ...headers },
    payload,
  });

it("records a displayed floor grant only through the authenticated existing operator route", async () => {
  const request = await brief({
    kind: "floor-grant",
    rule: "repo-rules",
    scope: "fixture exact scope",
    until: new Date(AT + 60_000).toISOString(),
    reason: "Explicit fixture grant",
  });
  const a = app();
  expect(
    (await a.inject({ method: "POST", url: `/api/attention/${KEY}/choice`, payload: request }))
      .statusCode,
  ).toBe(401);
  expect(store.getSetting("flight.approvals")).toBeNull();
  const response = await post(a, request);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ state: "applied" });
  expect(store.getSetting("flight.approvals")).toContain("fixture exact scope");
  expect(store.flightDecisions(0, 10)).toContainEqual(
    expect.objectContaining({ kind: "approval", basis: "Explicit fixture grant" }),
  );
});
it("keeps delegated FLIGHT provenance on protected grants, while the direct operator route remains usable", async () => {
  const action = {
    kind: "floor-grant" as const,
    rule: "repo-rules" as const,
    scope: "fixture",
    until: new Date(AT + 60_000).toISOString(),
    reason: "Explicit fixture grant",
  };
  const request = await brief(action),
    a = app();
  const response = await post(a, request, KEY, {
    [FLIGHT_OPERATOR_ACTOR_HEADER]: JSON.stringify({ seatId: "FLIGHT-1", runId: "flight" }),
  });
  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({ state: "refused" });
  expect(store.getSetting("flight.approvals")).toBeNull();
  const accepted = await post(a, { ...request, requestId: "actual-operator-choice" });
  expect(accepted.statusCode, accepted.body).toBe(200);
  expect(accepted.json()).toMatchObject({ state: "applied", actor: { operator: true } });
  const refusedAgain = await post(a, request, KEY, {
    [FLIGHT_OPERATOR_ACTOR_HEADER]: JSON.stringify({ seatId: "FLIGHT-1", runId: "flight" }),
  });
  expect(refusedAgain.statusCode).toBe(403);
  expect(refusedAgain.json()).toMatchObject({ state: "refused" });
  const { kind: _kind, ...payload } = action;
  expect(
    (
      await a.inject({
        method: "POST",
        url: "/api/flight/approvals",
        headers: { [OPERATOR_HEADER]: "operator-fixture" },
        payload,
      })
    ).statusCode,
  ).toBe(200);
});
it.each(["review-resume", "review-rework"] as const)(
  "dispatches %s to the displayed review park with the existing engine hook",
  async (kind) => {
    store.setRunLoop("target", {
      ...NEW_LOOP,
      phase: "parked",
      parked: { kind: "review", reason: "Findings", ended: false },
    });
    const request = await brief(
      kind === "review-resume"
        ? { kind, runId: "target", sha: SHA }
        : { kind, runId: "target", sha: SHA, text: "Address the displayed findings." },
    );
    const onOperatorMessage = vi.fn(async (_run, _by, options) => {
      if (options?.beforeLift) await options.beforeLift();
      return { lifted: true as const };
    });
    const a = app({ engine: { status: () => ({ on: true, note: null }), onOperatorMessage } });
    const response = await post(a, request);
    expect(response.statusCode).toBe(200);
    expect(onOperatorMessage).toHaveBeenCalledWith("target", "CAPCOM", expect.any(Object));
    if (kind === "review-rework")
      expect(
        store.comms(0, "target").some((line) => line.text === "Address the displayed findings."),
      ).toBe(true);
  },
);
it("dispatches a run controller verdict with exact head and evidence, preserving independence", async () => {
  store.setRunLoop("target", {
    ...NEW_LOOP,
    phase: "parked",
    parked: { kind: "controller-check", reason: "Check", ended: false },
    controllerCheck: { sha: SHA, from: "ci", pass: false },
    touches: { sha: SHA, paths: ["apps/server/src/flight/tools.ts"] },
  });
  const request = await brief({
    kind: "controller-check",
    target: { kind: "run", runId: "target", sha: SHA },
    verdict: "pass",
    evidence: "fixture receipt",
  });
  const controllerCheck = vi.fn(async () => ({ lifted: true as const }));
  const a = app({
    engine: {
      status: () => ({ on: true, note: null }),
      onOperatorMessage: vi.fn(),
      controllerCheck,
    },
  });
  const response = await post(a, request, KEY, {
    [FLIGHT_OPERATOR_ACTOR_HEADER]: JSON.stringify({ seatId: "FLIGHT-1", runId: "flight" }),
  });
  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({ state: "refused" });
  expect(controllerCheck).not.toHaveBeenCalled();
  const accepted = await post(a, { ...request, requestId: "independent-controller-choice" });
  expect(accepted.statusCode, accepted.body).toBe(200);
  expect(accepted.json()).toMatchObject({ state: "applied" });
  expect(controllerCheck).toHaveBeenCalledWith("target", "pass", SHA, "Evidence: fixture receipt");
  // A confirmed refusal leaves the real operator free to choose; the normal direct route also retains authority.
  expect(
    (
      await a.inject({
        method: "POST",
        url: "/api/runs/target/controller-check",
        headers: { [OPERATOR_HEADER]: "operator-fixture" },
        payload: { sha: SHA, verdict: "pass", note: "Evidence: fixture receipt" },
      })
    ).statusCode,
  ).toBe(200);
  expect(controllerCheck).toHaveBeenCalledWith("target", "pass", SHA, "Evidence: fixture receipt");
});
it("records an external decision honestly without performing an external operation", async () => {
  const request = await brief({ kind: "record-decision" });
  const response = await post(app(), request);
  expect(response.json()).toMatchObject({
    state: "applied",
    text: "Decision recorded. No external action was performed.",
  });
  expect(store.flightDecisions(0, 10)).toContainEqual(
    expect.objectContaining({
      decision: expect.stringContaining("No external action was performed"),
    }),
  );
});
it("shares attention-hold guards and does not treat a wait as a grant", async () => {
  const request = await brief({
    kind: "attention-hold",
    reason: "Hold this exact decision.",
    condition: { kind: "manual" },
  });
  const response = await post(app(), request);
  expect(response.statusCode).toBe(200);
  expect(store.getSetting("attention-holds")).toContain("Hold this exact decision.");
  expect(store.getSetting("flight.approvals")).toBeNull();
});
it("dispatches run UAT acceptance to the exact displayed PR head without supplying a merge", async () => {
  store.upsertPullRequests(
    "repo",
    [
      {
        repoId: "repo",
        number: 7,
        title: "Fixture PR",
        url: "https://example.test/7",
        branch: "feature/1",
        base: "main",
        ticket: "repo#1",
        state: "open",
        isDraft: false,
        review: null,
        ci: "passing",
        createdAt: AT,
        updatedAt: AT,
        mergedAt: null,
        headSha: SHA,
        mergeable: "MERGEABLE",
      },
    ],
    AT,
  );
  store.setRunLoop("target", {
    ...NEW_LOOP,
    phase: "parked",
    prNumber: 7,
    parked: { kind: "uat", reason: "Operator acceptance", ended: false },
    uat: { sha: SHA, from: "ci", accepted: false },
  });
  const request = await brief({
    kind: "uat",
    repoId: "repo",
    number: 7,
    sha: SHA,
    action: "accept",
  });
  const uat = vi.fn(async () => ({ lifted: true as const }));
  const a = app({
    engine: { status: () => ({ on: true, note: null }), onOperatorMessage: vi.fn(), uat },
  });
  const response = await post(a, request);
  expect(response.statusCode).toBe(200);
  expect(uat).toHaveBeenCalledWith("target", "accept", SHA, undefined);
  expect(store.pullRequest("repo", 7)?.state).toBe("open");
});
it.each(["hold", "release"] as const)(
  "shares the run merge-%s service and keeps the configured actor",
  async (action) => {
    store.setRunLoop("target", {
      ...NEW_LOOP,
      phase: "parked",
      parked: { kind: "merge-hold", reason: "Operator hold", ended: false },
      mergeHold: { by: "CAPCOM", reason: "Fixture hold", at: AT },
    });
    const request = await brief({
      kind: "merge-hold",
      target: { kind: "run", runId: "target", sha: SHA },
      action,
      ...(action === "hold" ? { reason: "Explicit displayed reason" } : {}),
    });
    const holdMerge = vi.fn(async () => ({ ok: true as const })),
      releaseMergeHold = vi.fn(async () => ({ ok: true as const }));
    const a = app({
      engine: {
        status: () => ({ on: true, note: null }),
        onOperatorMessage: vi.fn(),
        holdMerge,
        releaseMergeHold,
      },
    });
    const response = await post(a, request);
    expect(response.statusCode).toBe(200);
    if (action === "hold")
      expect(holdMerge).toHaveBeenCalledWith("target", "CAPCOM", "Explicit displayed reason");
    else expect(releaseMergeHold).toHaveBeenCalledWith("target", "CAPCOM");
  },
);
it("uses only explicit operator authority to recover the actual runaway breaker", async () => {
  store.setSetting("flight.runaway", JSON.stringify({ at: AT, reason: "Fixture loop" }));
  store.raiseNote({
    key: "flight-runaway",
    kind: "flag",
    runId: null,
    seatId: null,
    repoId: null,
    text: "Fixture runaway",
    at: AT,
  });
  const key = "note:flight-runaway",
    request = await brief({ kind: "breaker-recovery" }, key);
  const response = await post(app(), request, key);
  expect(response.statusCode).toBe(200);
  expect(store.getSetting("flight.runaway")).toBeNull();
  expect(store.flightDecisions(0, 20)).toContainEqual(
    expect.objectContaining({ kind: "hub", about: "runaway breaker" }),
  );
});
it("preserves a handler's strict payload contract and never accepts a producer URL", async () => {
  const request = await brief({ kind: "record-decision" });
  const a = app();
  expect((await post(a, { ...request, action: { url: "/api/flight/approvals" } })).statusCode).toBe(
    400,
  );
  expect(store.briefChoice(required(required(store.briefs().get(KEY)).binding).epoch)).toBeNull();
  expect(store.getSetting("flight.approvals")).toBeNull();
});

it("1389 keeps explicit budget recovery bound to the displayed park and never defaults it", async () => {
  store.setRunLoop("target", {
    ...NEW_LOOP,
    phase: "parked",
    parked: { kind: "budget", reason: "Fixture budget exhausted", ended: false },
  });
  const request = await brief({ kind: "run-resume", runId: "target", parkKind: "budget" });
  expect(store.briefs().get(KEY)?.defaultAt).toBeUndefined();
  const onOperatorMessage = vi.fn(async () => ({ lifted: true as const }));
  const a = app({ engine: { status: () => ({ on: true, note: null }), onOperatorMessage } });
  const response = await post(a, request);
  expect(response.statusCode, response.body).toBe(200);
  expect(onOperatorMessage).toHaveBeenCalledWith("target", "CAPCOM");
});

it("1389 sends an explicit ordinary answer to the displayed run without an unpark", async () => {
  const request = await brief({
    kind: "answer",
    seatId: "GUIDO-1",
    runId: "target",
    text: "Use the existing approved path.",
  });
  const message = vi.fn(async (_seat, _text, options) => {
    options.beforeWrite();
  });
  const a = app({
    supervisor: {
      status: () => ({ enabled: true, note: null }),
      message,
    } as unknown as AppDeps["supervisor"],
  });
  const response = await post(a, request);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({
    state: "applied",
    text: "Answer sent to the displayed run.",
  });
  expect(message).toHaveBeenCalledWith(
    "GUIDO-1",
    "Use the existing approved path.",
    expect.objectContaining({
      expectedRunId: "target",
      interrupt: false,
      questions: "none",
      enforcePause: true,
    }),
  );
});

it("1389 answers only the displayed question and leaves other questions unresolved", async () => {
  const first = store.addQuestion({
    agentId: "GUIDO-1",
    runId: "target",
    text: "Displayed question",
    at: AT,
  });
  const second = store.addQuestion({
    agentId: "GUIDO-1",
    runId: "target",
    text: "Other open question",
    at: AT,
  });
  const key = `ask:${first}`,
    request = await brief(
      {
        kind: "answer",
        seatId: "GUIDO-1",
        runId: "target",
        text: "Use the approved path for this question.",
      },
      key,
    );
  const message = vi.fn(async (_seat, _text, options) => {
    options.beforeWrite();
  });
  const a = app({
    supervisor: {
      status: () => ({ enabled: true, note: null }),
      message,
    } as unknown as AppDeps["supervisor"],
  });
  const response = await post(a, request, key);
  expect(response.statusCode, response.body).toBe(200);
  expect(store.question(first)?.answeredAt).toBe(AT);
  expect(store.question(second)?.answeredAt).toBeNull();
  expect(message).toHaveBeenCalledWith(
    "GUIDO-1",
    expect.any(String),
    expect.objectContaining({ questions: "none" }),
  );
});
it("1389 refuses a newly held question source before sending an unrelated answer", async () => {
  const first = store.addQuestion({
    agentId: "GUIDO-1",
    runId: "target",
    text: "Displayed question",
    at: AT,
  });
  const key = `ask:${first}`,
    request = await brief(
      { kind: "answer", seatId: "GUIDO-1", runId: "target", text: "Only the displayed answer." },
      key,
    );
  const second = store.addQuestion({
    agentId: "GUIDO-1",
    runId: "target",
    text: "Another genuine operator question",
    at: AT,
  });
  store.passQuestion(second, AT);
  const message = vi.fn();
  const a = app({
    supervisor: {
      status: () => ({ enabled: true, note: null }),
      message,
    } as unknown as AppDeps["supervisor"],
  });
  const response = await post(a, request, key);
  expect(response.statusCode).toBe(409);
  expect(message).not.toHaveBeenCalled();
  expect(store.question(first)?.answeredAt).toBeNull();
  expect(store.question(second)?.answeredAt).toBeNull();
});


it("REVIEW1389 invalidates changed escalation question facts", async () => {
  const base = {id:"repo#99", repoId:"repo", issueNumber:99, title:"[operator-decision] Choose a budget", kind:"operator-decision" as const, source:"title" as const, openedAt:AT, url:"https://example.test/99", question:{question:"Spend 10 dollars?",recommendation:"Cap at 10",reasoning_quote:"Known bound",effort_sunk:"None",default_if_ignored:"Wait",answers:["10","wait"]}};
  store.replaceEscalations("repo", [base]);
  const key = "esc:repo#99";
  await brief({kind:"record-decision"}, key);
  store.replaceEscalations("repo", [{...base, question:{...base.question,question:"Spend 10000 dollars?",recommendation:"Cap at 10000",answers:["10000","wait"]}}]);
  const item = attentionItems(config,store,AT).find(i=>i.key===key);
  expect(item?.brief?.state?.freshness).toBe("stale");
});

it("REVIEW1389 cannot hide a passed question with a recording-only action", async () => {
  const id=store.addQuestion({agentId:"GUIDO-1",runId:"target",text:"Choose the required authority",at:AT});
  store.passQuestion(id,AT);
  const key=`ask:${id}`;
  const request=await brief({kind:"record-decision"},key);
  const response=await post(app(),request,key);
  expect(store.question(id)?.answeredAt).toBeNull();
  const item=attentionItems(config,store,AT).find(i=>i.key===key);
  expect({status:response.statusCode,acked:item?.acked}).not.toEqual({status:200,acked:true});
});
