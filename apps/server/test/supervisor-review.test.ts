// Register the shared mocks before importing the modules under test.
import "./supervisor-harness.ts";

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_PROFILES,
  NEW_LOOP,
  NOT_ASIDE,
  type Profile,
  READONLY_BUILTINS,
  READONLY_TOOLS,
  REVIEW_FULL_MODEL,
  REVIEW_NOT_WANTED,
  type Run,
  type RunLoop,
  type RunProfile,
  retiringText,
  reworkFirstText,
  seatBusyText,
  ticketInReviewText,
} from "@mc/core";
import { describe, expect, it, vi } from "vitest";
import { CliHold } from "../src/cli-update.ts";
import type { CrewSeatConfig } from "../src/config.ts";
import { seatMayTake } from "../src/engine/queue.ts";
import { reviewBrief, watchBrief } from "../src/runtime/brief.ts";
import { CREW_LOCK_FILE, clonePeers, type SupervisorEvent } from "../src/runtime/supervisor.ts";
import { crewTokenPath } from "../src/store.ts";
import {
  BRANCH,
  boardCard,
  bus,
  clone,
  dbPath,
  dir,
  git,
  HUB_ROOT,
  make,
  noKeepers,
  prep,
  recorded,
  refusal,
  root,
  seatState,
  store,
  TICKET,
  until,
  userLines,
} from "./supervisor-harness.ts";

describe("questions and strays", () => {
  const stray = (path: string, agentId = "guido-1") => ({
    sessionId: "mc-crew",
    path,
    agentId,
    kind: "outside" as const,
    at: 1,
  });

  it("a message to the seat answers its open questions", async () => {
    const { sup } = make();
    sup.start();
    const { runId } = await sup.startRun("guido-1", 42);
    store.addQuestion({ agentId: "guido-1", runId, text: "one?", at: 1 });
    store.addQuestion({ agentId: "retro", runId: "retro:1", text: "two?", at: 1 });
    const emitted: string[] = [];
    bus.subscribe((t) => emitted.push(t));
    await sup.message("guido-1", "per customer", { interrupt: false });
    expect(store.openQuestions().map((q) => q.text)).toEqual(["two?"]);
    expect(emitted).toContain("attention");
  });

  it("FLIGHT's message options spare passed questions, or close none", async () => {
    const { sup } = make();
    sup.start();
    const { runId } = await sup.startRun("guido-1", 42);
    const passed = store.addQuestion({ agentId: "guido-1", runId, text: "passed?", at: 1 });
    store.passQuestion(passed, 2);
    store.addQuestion({ agentId: "guido-1", runId, text: "open?", at: 1 });
    await sup.message("guido-1", "nudge", { interrupt: false, questions: "none" });
    expect(store.openQuestions().map((q) => q.text)).toEqual(["passed?", "open?"]);
    await sup.message("guido-1", "answer", { interrupt: false, questions: "unpassed" });
    expect(store.openQuestions().map((q) => q.text)).toEqual(["passed?"]);
  });

  it("an interrupt alone answers nothing", async () => {
    const { sup } = make();
    sup.start();
    const { runId } = await sup.startRun("guido-1", 42);
    store.addQuestion({ agentId: "guido-1", runId, text: "one?", at: 1 });
    await sup.interrupt("guido-1");
    expect(store.openQuestions()).toHaveLength(1);
  });

  it("the run's end closes its questions and clears its strays, not another seat's", async () => {
    const { sup } = make();
    sup.start();
    const { runId } = await sup.startRun("guido-1", 42);
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    store.addQuestion({ agentId: "guido-1", runId, text: "one?", at: 1 });
    store.addStrays([stray("docs/a.md"), stray("docs/b.md", "retro")]);
    await sup.endRun("guido-1");
    expect(store.openQuestions()).toEqual([]);
    expect(store.strays().map((s) => s.path)).toEqual(["docs/b.md"]);
  });

  it("a run that crashes closes them too", async () => {
    const { sup } = make();
    sup.start();
    const { runId } = await sup.startRun("guido-1", 42);
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    store.addQuestion({ agentId: "guido-1", runId, text: "one?", at: 1 });
    store.addStrays([stray("docs/a.md")]);
    await sup.message("guido-1", "DIE", { interrupt: false });
    await until(() => expect(seatState("guido-1")).toBe("error"));
    expect(store.openQuestions()).toEqual([]);
    expect(store.strays()).toEqual([]);
  });

  it("ending a run with no process (left by a stopped hub) closes them too", async () => {
    const { sup } = make();
    store.upsertRun({
      id: "guido-1:old",
      agentId: "guido-1",
      repoId: "mc",
      seq: 1,
      startedAt: 1,
      endedAt: null,
      status: "running",
      sessionId: "s",
      model: "haiku",
      branch: BRANCH,
      ticket: "mc#42",
      costUsd: null,
      tokens: null,
      transcriptPath: "",
      prs: [],
      summary: null,
    });
    store.setSeatSession({
      seatId: "guido-1",
      runId: "guido-1:old",
      cliSessionId: "s",
      state: "idle",
      reason: null,
      worktree: null,
      updatedAt: 1,
    });
    store.addQuestion({ agentId: "guido-1", runId: "guido-1:old", text: "one?", at: 1 });
    store.addStrays([stray("docs/a.md")]);
    // start() would resume it; the lock is taken without resuming by a disabled reattach
    sup.start();
    await until(() => expect(seatState("guido-1")).toBe("error")); // no worktree: failed resume
    expect(store.openQuestions()).toEqual([]);
    expect(store.strays()).toEqual([]);
  });

  it("endRun on a run with no process (none was resumed) closes them too", async () => {
    const { sup } = make();
    sup.start(); // nothing active yet: nothing to resume
    store.upsertRun({
      id: "guido-1:old",
      agentId: "guido-1",
      repoId: "mc",
      seq: 1,
      startedAt: 1,
      endedAt: null,
      status: "running",
      sessionId: "s",
      model: "haiku",
      branch: BRANCH,
      ticket: "mc#42",
      costUsd: null,
      tokens: null,
      transcriptPath: "",
      prs: [],
      summary: null,
    });
    store.setSeatSession({
      seatId: "guido-1",
      runId: "guido-1:old",
      cliSessionId: "s",
      state: "idle",
      reason: null,
      worktree: null,
      updatedAt: 1,
    });
    store.addQuestion({ agentId: "guido-1", runId: "guido-1:old", text: "one?", at: 1 });
    store.addStrays([stray("docs/a.md")]);
    await sup.endRun("guido-1");
    expect(store.seatSession("guido-1")).toMatchObject({ state: "idle", runId: null });
    expect(store.openQuestions()).toEqual([]);
    expect(store.strays()).toEqual([]);
  });

  it("endRun with hold on a run with no process stops the seat, out of rotation", async () => {
    const { sup } = make();
    sup.start();
    store.upsertRun({
      id: "guido-1:old",
      agentId: "guido-1",
      repoId: "mc",
      seq: 1,
      startedAt: 1,
      endedAt: null,
      status: "running",
      sessionId: "s",
      model: "haiku",
      branch: BRANCH,
      ticket: "mc#42",
      costUsd: null,
      tokens: null,
      transcriptPath: "",
      prs: [],
      summary: null,
    });
    store.setSeatSession({
      seatId: "guido-1",
      runId: "guido-1:old",
      cliSessionId: "s",
      state: "idle",
      reason: null,
      worktree: null,
      updatedAt: 1,
    });
    await sup.endRun("guido-1", { hold: true });
    expect(store.seatSession("guido-1")).toMatchObject({ state: "stopped", runId: null });
    expect(seatMayTake(store, "guido-1")).toBe(false);
  });

  it("endRun on a run with no process folds its transcript, so a stale DONE. summary is replaced", async () => {
    const { sup } = make();
    sup.start();
    const transcriptPath = join(dir, "old.jsonl");
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({ type: "result", total_cost_usd: 0.5, result: "DONE. The PR is up. More." })}\n`,
    );
    store.upsertRun({
      id: "guido-1:old",
      agentId: "guido-1",
      repoId: "mc",
      seq: 1,
      startedAt: 1,
      endedAt: null,
      status: "running",
      sessionId: "s",
      model: "haiku",
      branch: BRANCH,
      ticket: "mc#42",
      costUsd: null,
      tokens: null,
      transcriptPath,
      prs: [],
      summary: "DONE.",
    });
    store.setSeatSession({
      seatId: "guido-1",
      runId: "guido-1:old",
      cliSessionId: "s",
      state: "idle",
      reason: null,
      worktree: null,
      updatedAt: 1,
    });
    await sup.endRun("guido-1");
    expect(store.run("guido-1:old")).toMatchObject({
      status: "ok",
      summary: "The PR is up. More.",
      costUsd: 0.5,
    });
    expect(store.digest("guido-1:old")).not.toBeNull();
  });

  it("inClone queues work per clone", async () => {
    const { sup } = make();
    const order: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const a = sup.inClone(clone, async () => {
      order.push("a start");
      await gate;
      order.push("a end");
    });
    const b = sup.inClone(clone, async () => {
      order.push("b");
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["a start"]);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(["a start", "a end", "b"]);
  });
});

describe("folding", () => {
  it("fills the run's tokens, model and digest from the transcript", async () => {
    const { sup } = make();
    sup.start();
    const { runId } = await sup.startRun("guido-1", 42);
    // tokens can be stored before the result line brings the cost: wait for every field
    await until(() => {
      const run = store.run(runId);
      expect(run?.tokens).not.toBeNull();
      expect(run?.model).toBe("claude-haiku-5-5");
      expect(run?.costUsd).toBeGreaterThan(0);
      expect(run?.summary).toMatch(/^echo: You are GUIDO-1, the backend developer/);
      expect(store.digest(runId)).not.toBeNull();
    });
  });

  it("logs a fold that fails to write, and the seat carries on", async () => {
    const { sup, log } = make();
    sup.start();
    await sup.startRun("guido-1", 42);
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    vi.spyOn(store, "upsertRun").mockImplementation(() => {
      throw new Error("database is locked");
    });
    await sup.message("guido-1", "PROGRESS", { interrupt: false });
    await until(() =>
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/database is locked/)),
    );
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    // a throttled fold, after the turn, fails the same way without an uncaught exception
    await new Promise((r) => setTimeout(r, 1100));
  });
});

describe("startWatch", () => {
  const FLIGHT: CrewSeatConfig = {
    id: "flight-1",
    role: "FLIGHT",
    accountId: "claude-main",
    model: "opus",
    area: [],
  };
  const flightMake = () => {
    // roles/FLIGHT.md is the controller's file; this test brings its own role brief
    const rolesDir = join(dir, "roles");
    mkdirSync(rolesDir, { recursive: true });
    writeFileSync(join(rolesDir, "FLIGHT.md"), "# FLIGHT: head agent\n");
    return make({ rolesDir, extraSeat: FLIGHT });
  };
  const BRIEF = watchBrief({
    call: "FLIGHT-1",
    repo: "o/mc",
    seats: [{ call: "GUIDO-1", area: ["apps/**"] }],
  });

  it("sends a brief that lists the session's developer seats and their areas", async () => {
    const { sup } = flightMake();
    sup.start();
    await sup.startWatch("flight-1");
    await until(() => expect(userLines()).toHaveLength(1));
    expect(userLines()[0]).toContain(
      "Developer seats and the files each may change: GUIDO-1: apps/**. start_seat refuses",
    );
  });

  it("is refused while the CLI is held, and starts no run", async () => {
    const hold = new CliHold();
    hold.hold("held for the CLI");
    const rolesDir = join(dir, "roles");
    mkdirSync(rolesDir, { recursive: true });
    writeFileSync(join(rolesDir, "FLIGHT.md"), "# FLIGHT: head agent\n");
    const { sup } = make({ rolesDir, extraSeat: FLIGHT, cliHold: hold });
    sup.start();
    const e = await refusal(sup.startWatch("flight-1"));
    expect([e.status, e.message]).toEqual([409, "held for the CLI"]);
    expect(store.runs("flight-1", 1)).toEqual([]);
  });

  it("runs with no ticket and no branch, in a detached worktree", async () => {
    const { sup, fetchTicket } = flightMake();
    sup.start();
    const out = await sup.startWatch("flight-1");
    const wt = join(root, "mc-crew", "flight-1-watch");
    expect(fetchTicket).not.toHaveBeenCalled();
    expect(store.run(out.runId)).toMatchObject({ branch: null, ticket: null, endedAt: null });
    expect(store.run(out.runId)?.loop ?? null).toBeNull();
    expect(store.seatSession("flight-1")?.worktree).toBe(wt);
    expect(() => git(wt, "symbolic-ref", "--quiet", "HEAD")).toThrow();
    await until(() => expect(recorded().length).toBeGreaterThan(0));
    const start = recorded()[0];
    expect(start.cwd).toBe(wt);
    const argv = start.argv as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("opus");
    expect(argv[argv.indexOf("--tools") + 1]).toBe(READONLY_BUILTINS.join(","));
    expect(
      argv.slice(argv.indexOf("--allowedTools") + 1, argv.indexOf("--disallowedTools")),
    ).toEqual([
      ...READONLY_TOOLS,
      "mcp__mc__log_decision",
      "mcp__mc__read_ticket",
      "mcp__mc__answer_question",
      "mcp__mc__start_seat",
      "mcp__mc__message_seat",
      "mcp__mc__flight_state",
      "mcp__mc__promote",
      "mcp__mc__end_run",
      "mcp__mc__accept_ruling",
      "mcp__mc__merge_pr",
      "mcp__mc__settle_park",
      "mcp__mc__rerun_ci",
      "mcp__mc__edit_card",
      "mcp__mc__dismiss_item",
      "mcp__mc__sync_main",
      "mcp__mc__create_ticket",
      "mcp__mc__comment_ticket",
      "mcp__mc__brief_item",
      "mcp__mc__read_pr",
      "mcp__mc__read_ci_log",
      "mcp__mc__gh_read",
      "mcp__mc__list_tickets",
      "mcp__mc__update_brief",
      "mcp__mc__draft_reply",
      "mcp__mc__track",
      "mcp__mc__untrack",
      "mcp__mc__ledger",
      "mcp__mc__remember",
      "mcp__mc__forget",
      "mcp__mc__recall",
    ]);
    await until(() => expect(userLines()).toEqual([BRIEF]));
  });

  it("ending the watch seat's run stops it, so the watch does not restart it", async () => {
    const { sup, cfg } = flightMake();
    sup.start();
    await sup.startWatch("flight-1");
    expect(prep.peers.at(-1)).toEqual(clonePeers(cfg, HUB_ROOT));
    await until(() => expect(seatState("flight-1")).toBe("idle"));
    await sup.endRun("flight-1");
    expect(seatState("flight-1")).toBe("stopped");
  });

  it("appends first after a blank line", async () => {
    const { sup } = flightMake();
    sup.start();
    await sup.startWatch("flight-1", { first: "X" });
    await until(() => expect(userLines()).toEqual([`${BRIEF}\n\nX`]));
  });

  it("is refused for a retiring watch seat", async () => {
    const { sup, cfg } = flightMake();
    sup.start();
    const flight = cfg.crew?.sessions[0]?.seats.find((s) => s.id === "flight-1");
    if (flight) flight.retiring = true;
    try {
      const e = await refusal(sup.startWatch("flight-1"));
      expect([e.status, e.message]).toEqual([409, retiringText("FLIGHT-1")]);
      expect(store.seatSession("flight-1")).toBeNull();
    } finally {
      // FLIGHT is shared by the tests of this block
      if (flight) delete flight.retiring;
    }
  });

  it("is refused for a seat that is not a watch seat, and startRun for FLIGHT", async () => {
    const { sup } = flightMake();
    sup.start();
    const a = await refusal(sup.startWatch("guido-1"));
    expect([a.status, a.message]).toEqual([409, "GUIDO-1 is not a watch seat."]);
    const b = await refusal(sup.startRun("flight-1", 42));
    expect([b.status, b.message]).toEqual([
      409,
      "FLIGHT-1 runs the crew and is started without a ticket.",
    ]);
  });
});

describe("startReview", () => {
  const RESUMED = "resumed after a restart; send a message to continue";
  const scratch = (id: number) => join(root, "mc-crew", `retro-review-${id}`);

  /** An author run with a pushed PR head, and a review of it in `starting`. */
  function reviewOfPush(
    opts: { state?: "queued" | "starting"; pushSha?: string; profile?: RunProfile } = {},
  ) {
    const seed = join(dir, "seed");
    const fork = git(seed, "rev-parse", "HEAD");
    git(seed, "checkout", "-q", "-b", "pr");
    writeFileSync(join(seed, "a.txt"), "a\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-qm", "pr change");
    git(seed, "push", "-q", "origin", "pr");
    const sha = git(seed, "rev-parse", "HEAD");
    git(seed, "checkout", "-q", "main");
    const author: Run = {
      id: "guido-1:20261020T000000Z",
      agentId: "guido-1",
      repoId: "mc",
      seq: 1,
      startedAt: 1,
      endedAt: null,
      status: "running",
      sessionId: "s",
      model: "haiku",
      branch: BRANCH,
      ticket: "mc#42",
      ticketTitle: TICKET.title,
      costUsd: null,
      tokens: null,
      transcriptPath: join(dir, "author.jsonl"),
      prs: [],
      summary: null,
      ...(opts.profile === undefined ? {} : { profile: opts.profile }),
    };
    store.upsertRun(author);
    store.setRunPush({ runId: author.id, sha: opts.pushSha ?? sha, at: 1 });
    store.setSeatSession({
      seatId: "guido-1",
      runId: author.id,
      cliSessionId: "c",
      state: "running",
      reason: null,
      worktree: join(root, "mc-crew", "guido-1-42"),
      updatedAt: 1,
    });
    const reviewId = store.requestReview({
      authorRunId: author.id,
      repoId: "mc",
      seatId: "guido-1",
      prNumber: 9,
      sha,
      epoch: 0,
      attempt: 1,
      round: 1,
      at: 1,
    }) as number;
    if ((opts.state ?? "starting") === "starting") {
      store.setReviewState(reviewId, ["queued"], "starting", { at: 2 });
    }
    return { reviewId, sha, fork, author };
  }

  it("refuses scratch storage inside hub data before preparing a review", async () => {
    const r = reviewOfPush();
    const worktrees = join(dir, "db", "scratch");
    const { sup } = make({ scratchRetro: true, worktrees });
    sup.start();
    await expect(sup.startReview("retro", r.reviewId)).rejects.toThrow(
      "outside the hub data directory",
    );
    // start() makes the folder for the crew lock; no review checkout was prepared in it
    expect(readdirSync(worktrees).filter((f) => f !== CREW_LOCK_FILE)).toEqual([]);
    expect(store.runs("retro", 1)).toEqual([]);
  });

  async function started() {
    const r = reviewOfPush();
    const m = make({ scratchRetro: true });
    m.sup.start();
    const { runId } = await m.sup.startReview("retro", r.reviewId);
    await until(() => expect(seatState("retro")).toBe("idle"));
    return { ...m, ...r, runId };
  }

  it("a review brief names the repo's review commands", async () => {
    const r = reviewOfPush();
    const { sup } = make({
      scratchRetro: true,
      repo: { commands: { writer: ["uv run ruff check"], review: ["uv run pytest"] } },
    });
    sup.start();
    await sup.startReview("retro", r.reviewId);
    await until(() => expect(userLines()).toHaveLength(1));
    const brief = userLines()[0] as string;
    expect(brief).toContain("`uv run pytest` followed by a test file path");
    expect(brief).not.toContain("pnpm");
    expect(brief).not.toContain("ruff");
  });

  it("startReview starts a review whose sha the pushed sha carries", async () => {
    const pushSha = "e".repeat(40);
    const r = reviewOfPush({ pushSha });
    store.setRunLoop(r.author.id, { ...NEW_LOOP, carry: { from: r.sha, to: pushSha } });
    const { sup } = make({ scratchRetro: true });
    sup.start();
    await expect(sup.startReview("retro", r.reviewId)).resolves.toMatchObject({
      runId: expect.any(String),
    });
  });

  /** A review of an author run whose profile has this review depth; the review run's model. */
  async function reviewModel(depth: "light" | "full"): Promise<string | null> {
    const model = await reviewRunModel(depth);
    await until(() => expect(recorded().length).toBeGreaterThan(0));
    const argv = recorded()[0].argv as string[];
    // the CLI is launched on the model the depth calls for, as the run row says
    expect(argv[argv.indexOf("--model") + 1]).toBe(depth === "full" ? REVIEW_FULL_MODEL : "haiku");
    return model;
  }

  async function reviewRunModel(depth: "light" | "full"): Promise<string | null> {
    const base = DEFAULT_PROFILES[0] as Profile;
    const r = reviewOfPush({
      profile: {
        profile: { ...base, reviewer: { role: "RETRO", depth } },
        route: { by: "size", size: "M" },
        hash: "h",
      },
    });
    const { sup } = make({ scratchRetro: true });
    sup.start();
    const { runId } = await sup.startReview("retro", r.reviewId);
    return store.run(runId)?.model ?? null;
  }

  it("a full-depth review runs on the full-depth model", async () => {
    expect(await reviewModel("full")).toBe(REVIEW_FULL_MODEL);
  });

  it("a light review runs on the seat's model", async () => {
    expect(await reviewModel("light")).toBe("haiku");
  });

  it("a superseded review ends without missing-report diagnostics", async () => {
    const r = reviewOfPush();
    const { sup } = make({ scratchRetro: true });
    sup.start();
    const { runId } = await sup.startReview("retro", r.reviewId);
    await until(() => expect(seatState("retro")).toBe("idle"));
    store.setReviewState(r.reviewId, ["running"], "superseded", { at: Date.now() });
    await sup.endRunByEngine(runId);
    expect(store.run(runId)?.noReport).toBeUndefined();
    expect(store.notes().filter((n) => n.key === `no_report:${runId}`)).toEqual([]);
  });

  it("startReview launches a scratch run", async () => {
    const r = reviewOfPush();
    const { sup, cfg } = make({ scratchRetro: true });
    sup.start();
    const { runId } = await sup.startReview("retro", r.reviewId);
    expect(prep.peers.at(-1)).toEqual(clonePeers(cfg, HUB_ROOT));
    expect(store.run(runId)).toMatchObject({
      agentId: "retro",
      reviewId: r.reviewId,
      branch: null,
      ticket: "mc#42",
      ticketTitle: TICKET.title,
    });
    expect(store.seatSession("retro")).toMatchObject({
      runId,
      worktree: scratch(r.reviewId),
    });
    expect(git(scratch(r.reviewId), "rev-parse", "HEAD")).toBe(r.sha);
    expect(existsSync(join(scratch(r.reviewId), ".mc-review", "pr.diff"))).toBe(true);
    await until(() => expect(userLines()).toHaveLength(1));
    const [start] = recorded();
    const argv = start.argv as string[];
    expect(start.cwd).toBe(scratch(r.reviewId));
    expect(argv).toContain("mcp__mc__report_findings");
    expect(userLines()[0]).toBe(
      reviewBrief({
        call: "RETRO",
        repo: "o/mc",
        issue: 42,
        title: TICKET.title,
        prNumber: 9,
        sha: r.sha,
        mergeBase: r.fork,
        round: 1,
        body: TICKET.body,
        bodyTruncated: false,
        bodyLength: TICKET.body.length,
        notes: [],
        prevSha: null,
        prevFindings: [],
        diffCut: false,
        since: false,
        touches: [],
        commands: [],
      }),
    );
    const fs = JSON.parse(argv[argv.indexOf("--settings") + 1] as string).sandbox.filesystem;
    expect(fs.denyRead).toContain(join(root, "mc-crew", "guido-1-42"));
  });

  describe("model", () => {
    async function modelOf(
      over: Parameters<typeof make>[0],
      reviewOver?: Parameters<typeof reviewOfPush>[0],
    ) {
      const r = reviewOfPush(reviewOver);
      const { sup } = make({ scratchRetro: true, ...over });
      // the CLI's init later replaces the run's model with the one it reports
      const upsert = vi.spyOn(store, "upsertRun");
      sup.start();
      await sup.startReview("retro", r.reviewId);
      await until(() => expect(userLines()).toHaveLength(1));
      const argv = recorded()[0]?.argv as string[];
      const written = upsert.mock.calls.find(([run]) => run.reviewId === r.reviewId);
      upsert.mockRestore();
      return [written?.[0].model, argv[argv.indexOf("--model") + 1]];
    }

    it("a small change is reviewed on the light model", async () => {
      store.replaceBoard("mc", [boardCard(42)]);
      expect(await modelOf({ retroLightModel: "sonnet" })).toEqual(["sonnet", "sonnet"]);
    });

    it("a larger change keeps the seat's model", async () => {
      store.replaceBoard("mc", [boardCard(42, { size: "M" })]);
      expect(await modelOf({ retroLightModel: "sonnet" })).toEqual(["haiku", "haiku"]);
    });

    it("a bug keeps the seat's model at any size", async () => {
      store.replaceBoard("mc", [boardCard(42)]);
      expect(
        await modelOf({
          retroLightModel: "sonnet",
          fetchTicket: async () => ({ ...TICKET, labels: ["bug"] }),
        }),
      ).toEqual(["haiku", "haiku"]);
    });

    it("a full-depth profile keeps the full-depth model over the light model", async () => {
      store.replaceBoard("mc", [boardCard(42)]);
      expect(
        await modelOf(
          { retroLightModel: "sonnet" },
          {
            profile: {
              profile: {
                ...(DEFAULT_PROFILES[0] as Profile),
                reviewer: { role: "RETRO", depth: "full" },
              },
              route: { by: "size", size: "S" },
              hash: "h",
            },
          },
        ),
      ).toEqual([REVIEW_FULL_MODEL, REVIEW_FULL_MODEL]);
    });

    it("no light model: the seat's model", async () => {
      store.replaceBoard("mc", [boardCard(42)]);
      expect(await modelOf({})).toEqual(["haiku", "haiku"]);
    });
  });

  it("startReview is refused while the CLI is held, and starts no run", async () => {
    const r = reviewOfPush();
    const hold = new CliHold();
    hold.hold("held for the CLI");
    const { sup } = make({ scratchRetro: true, cliHold: hold });
    sup.start();
    const e = await refusal(sup.startReview("retro", r.reviewId));
    expect([e.status, e.message]).toEqual([409, "held for the CLI"]);
    expect(store.runs("retro", 1)).toEqual([]);
    expect(existsSync(scratch(r.reviewId))).toBe(false);
  });

  it("startReview refuses an unwanted review", async () => {
    const { sup } = make({ scratchRetro: true });
    sup.start();
    const queued = reviewOfPush({ state: "queued" });
    const a = await refusal(sup.startReview("retro", queued.reviewId));
    expect([a.status, a.message]).toEqual([409, REVIEW_NOT_WANTED]);
    // a push that moved on from the review's sha
    store.setRunPush({ runId: queued.author.id, sha: queued.fork, at: 3 });
    store.setReviewState(queued.reviewId, ["queued"], "starting", { at: 3 });
    const b = await refusal(sup.startReview("retro", queued.reviewId));
    expect([b.status, b.message]).toEqual([409, REVIEW_NOT_WANTED]);
    expect(existsSync(scratch(queued.reviewId))).toBe(false);
    expect(store.runs("retro", 1)).toEqual([]);
  });

  it("startReview refuses a seat that is not a review seat", async () => {
    const r = reviewOfPush();
    const { sup } = make();
    sup.start();
    const e = await refusal(sup.startReview("retro", r.reviewId));
    expect([e.status, e.message]).toEqual([409, "RETRO is not a review seat"]);
  });

  it("a review run's worktree goes when it crashes", async () => {
    const { sup, reviewId } = await started();
    await sup.message("retro", "DIE", { interrupt: false });
    await until(() => expect(seatState("retro")).toBe("error"));
    await until(() => expect(existsSync(scratch(reviewId))).toBe(false));
  });

  it("a review run's worktree goes when it is stopped", async () => {
    const { sup, reviewId } = await started();
    await sup.endRun("retro");
    await until(() => expect(existsSync(scratch(reviewId))).toBe(false));
  });

  it("a review run's worktree goes when the engine ends it", async () => {
    const { sup, reviewId, runId } = await started();
    await sup.endRunByEngine(runId);
    expect(existsSync(scratch(reviewId))).toBe(false);
  });

  it("a review run resumes in its scratch worktree", async () => {
    const { sup, reviewId } = await started();
    await sup.stopAll();
    await noKeepers();
    const again = make({ scratchRetro: true });
    again.sup.start();
    await until(() => expect(store.seatSession("retro")?.reason).toBe(RESUMED));
    expect(seatState("retro")).toBe("idle");
    await until(() => expect(recorded().filter((l) => Array.isArray(l.argv))).toHaveLength(2));
    expect(recorded().filter((l) => Array.isArray(l.argv))[1].cwd).toBe(scratch(reviewId));
    expect(existsSync(scratch(reviewId))).toBe(true);
  });

  it("fails a review run whose seat is no longer a scratch seat", async () => {
    const { sup, reviewId, runId } = await started();
    await sup.stopAll();
    make().sup.start();
    await until(() =>
      expect(store.seatSession("retro")).toMatchObject({
        state: "error",
        reason: "could not resume: the seat's mode changed",
      }),
    );
    expect(store.run(runId)?.status).toBe("failed");
    expect(store.run(runId)?.noReport).toBeUndefined();
    expect(store.notes().filter((n) => n.key === `no_report:${runId}`)).toEqual([]);
    await until(() => expect(existsSync(scratch(reviewId))).toBe(false));
    expect(recorded().filter((l) => Array.isArray(l.argv))).toHaveLength(1);
  });

  it("sweepScratch removes an ended review's worktree at start", async () => {
    const r = reviewOfPush();
    git(clone, "fetch", "-q", "origin");
    git(clone, "worktree", "add", "-q", "--detach", scratch(r.reviewId), r.sha);
    writeFileSync(join(root, "retro-review-notes"), "not a scratch\n");
    const { sup } = make({ scratchRetro: true });
    sup.start();
    await until(() => expect(existsSync(scratch(r.reviewId))).toBe(false));
    expect(existsSync(join(root, "retro-review-notes"))).toBe(true);
  });

  it("sweepScratch also removes a leftover review worktree still at the old flat path", async () => {
    const r = reviewOfPush();
    git(clone, "fetch", "-q", "origin");
    const flat = join(root, `retro-review-${r.reviewId}`);
    git(clone, "worktree", "add", "-q", "--detach", flat, r.sha);
    const { sup } = make({ scratchRetro: true });
    sup.start();
    await until(() => expect(existsSync(flat)).toBe(false));
  });
});

describe("a run set aside in review", () => {
  const REVIEW: RunLoop = { ...NEW_LOOP, phase: "review", prNumber: 12 };
  const wt = () => join(root, "mc-crew", "guido-1-42");
  const starts = () => recorded().filter((l) => Array.isArray(l.argv));
  const ended = (seen: SupervisorEvent[]) => seen.filter((e) => e.kind === "run-ended");

  async function idleRun() {
    const m = make();
    m.sup.start();
    const seen: SupervisorEvent[] = [];
    m.sup.on((e) => seen.push(e));
    const { runId } = await m.sup.startRun("guido-1", 42, { loop: REVIEW });
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    return { ...m, runId, seen };
  }

  /** The run set aside, its loop stored as the engine stores it. */
  async function aside(wake = false) {
    const r = await idleRun();
    const set = await r.sup.setAside(r.runId);
    expect(set).toEqual({ worktree: wt() });
    store.setRunLoop(r.runId, { ...REVIEW, aside: { worktree: wt(), wake } });
    return r;
  }

  it("setAside closes the process, frees the seat and keeps the run and its worktree", async () => {
    const { sup, runId, seen } = await idleRun();
    expect(existsSync(crewTokenPath(dbPath, runId))).toBe(true);
    expect(await sup.setAside(runId)).toEqual({ worktree: wt() });
    expect(store.seatSession("guido-1")).toMatchObject({
      runId: null,
      cliSessionId: null,
      state: "idle",
      reason: null,
      worktree: null,
    });
    expect(store.run(runId)).toMatchObject({ endedAt: null, status: "running" });
    expect(existsSync(wt())).toBe(true);
    expect(sup.seatFacts("guido-1")).toBeNull();
    expect(ended(seen)).toEqual([]);
    // the process's exit takes its token and files, and ends nothing
    await until(() => expect(existsSync(crewTokenPath(dbPath, runId))).toBe(false));
    expect(store.run(runId)).toMatchObject({ endedAt: null, status: "running" });
    expect(store.seatSession("guido-1")?.state).toBe("idle");
  });

  it("setAside answers null mid-turn, for an ended run and for a run the seat does not hold", async () => {
    const { sup, runId } = await idleRun();
    await sup.message("guido-1", "SLOW", { interrupt: false });
    await until(() => expect(seatState("guido-1")).toBe("running"));
    expect(await sup.setAside(runId)).toBeNull();
    expect(sup.seatFacts("guido-1")).not.toBeNull();
    expect(await sup.setAside("guido-1:nonesuch")).toBeNull();
    await sup.endRunByEngine(runId);
    expect(await sup.setAside(runId)).toBeNull();
  });

  it("setAside leaves a message already queued for the seat alone", async () => {
    const { sup, runId } = await idleRun();
    const queued = sup.message("guido-1", "SLOW", { interrupt: false });
    expect(await sup.setAside(runId)).toBeNull();
    await queued;
    await until(() => expect(seatState("guido-1")).toBe("running"));
    expect(store.seatSession("guido-1")?.runId).toBe(runId);
    expect(sup.seatFacts("guido-1")).not.toBeNull();
  });

  it("wakeRun keeps the crash that the seat was in as an Activity row", async () => {
    const { sup, runId } = await aside(false);
    const other = await sup.startRun("guido-1", 43, { loop: NEW_LOOP });
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    await sup.message("guido-1", "DIE", { interrupt: false });
    await until(() => expect(seatState("guido-1")).toBe("error"));
    const reason = store.seatSession("guido-1")?.reason as string;
    expect(store.seatSession("guido-1")?.runId).toBe(other.runId);
    await sup.wakeRun(runId);
    expect(store.seatSession("guido-1")).toMatchObject({ runId, state: "idle", reason: null });
    const rows = store.agentEvents(0).filter((e) => e.agentId === "guido-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ from: "error", to: "idle" });
    expect(rows[0]?.text).toContain(reason);
  });

  it("wakeRun onto a seat that was stopped records the stop too", async () => {
    const { sup, runId } = await aside(false);
    const other = await sup.startRun("guido-1", 43, { loop: NEW_LOOP });
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    await sup.endRun("guido-1", { hold: true });
    expect(store.seatSession("guido-1")).toMatchObject({ state: "stopped", runId: null });
    expect(other.runId).not.toBe(runId);
    await sup.wakeRun(runId);
    const rows = store.agentEvents(0).filter((e) => e.agentId === "guido-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ from: "stopped", to: "idle" });
  });

  it("a woken CLI that cannot find its session reports RESUME_FAILED", async () => {
    const m = make({ extraArgs: ["--fail-resume"] });
    m.sup.start();
    const { runId } = await m.sup.startRun("guido-1", 42, { loop: REVIEW });
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    await m.sup.setAside(runId);
    store.setRunLoop(runId, { ...REVIEW, aside: { worktree: wt(), wake: true } });
    await m.sup.wakeRun(runId);
    await until(() => expect(seatState("guido-1")).toBe("error"));
    expect(store.seatSession("guido-1")?.reason).toContain("could not resume the session");
  });

  it("endAsideRun ends a run that is set aside as the operator's, without waking a CLI", async () => {
    const { sup, runId, seen } = await aside(false);
    const before = store.seatSession("guido-1");
    await sup.endAsideRun(runId);
    expect(store.run(runId)).toMatchObject({ status: "ok", endedBy: "operator" });
    expect(store.run(runId)?.endedAt).not.toBeNull();
    expect(ended(seen)).toEqual([
      { kind: "run-ended", seatId: "guido-1", runId, endedBy: "operator" },
    ]);
    await until(() => expect(existsSync(wt())).toBe(false));
    expect(store.seatSession("guido-1")).toEqual(before);
    expect(starts()).toHaveLength(1);
  });

  it("endAsideRun is refused for a run that is not set aside", async () => {
    const { sup, runId } = await idleRun();
    const held = await refusal(sup.endAsideRun(runId));
    expect([held.status, held.message]).toEqual([409, NOT_ASIDE]);
    const none = await refusal(sup.endAsideRun("guido-1:nonesuch"));
    expect([none.status, none.message]).toEqual([409, NOT_ASIDE]);
    expect(store.run(runId)).toMatchObject({ endedAt: null });
  });

  it("endAsideRun is refused while the run is still on its seat, however its loop reads", async () => {
    const { sup, runId } = await idleRun();
    store.setRunLoop(runId, { ...REVIEW, aside: { worktree: wt(), wake: false } });
    const e = await refusal(sup.endAsideRun(runId));
    expect([e.status, e.message]).toEqual([409, NOT_ASIDE]);
    expect(store.run(runId)?.endedAt).toBeNull();
    expect(existsSync(wt())).toBe(true);
  });

  it("endAsideRun says the seat is busy while another run is starting on it", async () => {
    const { sup, runId } = await aside(false);
    const starter = sup.startRun("guido-1", 43, { loop: NEW_LOOP });
    const e = await refusal(sup.endAsideRun(runId));
    expect([e.status, e.message]).toEqual([409, seatBusyText("GUIDO-1")]);
    await starter;
    expect(store.run(runId)).toMatchObject({ endedAt: null });
    expect(existsSync(wt())).toBe(true);
  });

  it("wakeRun is refused while the CLI is held, and the run stays aside", async () => {
    const hold = new CliHold();
    const m = make({ cliHold: hold });
    m.sup.start();
    const { runId } = await m.sup.startRun("guido-1", 42, { loop: REVIEW });
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    await m.sup.setAside(runId);
    store.setRunLoop(runId, { ...REVIEW, aside: { worktree: wt(), wake: true } });
    hold.hold("held for the CLI");
    const e = await refusal(m.sup.wakeRun(runId));
    expect([e.status, e.message]).toEqual([409, "held for the CLI"]);
    expect(m.sup.seatFacts("guido-1")).toBeNull();
    expect(store.run(runId)).toMatchObject({ endedAt: null });
  });

  it("wakeRun resumes the same session in place", async () => {
    const { sup, runId } = await aside(true);
    const sessionId = store.run(runId)?.sessionId as string;
    expect(store.seatSession("guido-1")?.lastTurnEndedAt).not.toBeNull();
    await sup.wakeRun(runId);
    expect(sup.seatFacts("guido-1")).toMatchObject({ inTurn: false, resumedAt: null });
    expect(store.seatSession("guido-1")).toMatchObject({
      runId,
      state: "idle",
      reason: null,
      lastTurnEndedAt: null,
    });
    await sup.message("guido-1", "rework", { interrupt: false });
    await until(() => expect(starts()).toHaveLength(2));
    const second = starts()[1];
    const argv = second.argv as string[];
    expect(argv[argv.indexOf("--resume") + 1]).toBe(sessionId);
    expect(second.cwd).toBe(wt());
    expect(store.seatSession("guido-1")).toMatchObject({
      runId,
      cliSessionId: sessionId,
      worktree: wt(),
    });
    expect(userLines().filter((l) => l.startsWith("Carry on"))).toEqual([]);
  });

  it("wakeRun is refused for a run that is not aside and while the seat holds another run", async () => {
    const { sup, runId } = await aside(false);
    const none = await refusal(sup.wakeRun("guido-1:nonesuch"));
    expect([none.status, none.message]).toEqual([409, NOT_ASIDE]);
    store.setRunLoop(runId, { ...REVIEW, aside: null });
    const notAside = await refusal(sup.wakeRun(runId));
    expect([notAside.status, notAside.message]).toEqual([409, NOT_ASIDE]);
    store.setRunLoop(runId, { ...REVIEW, aside: { worktree: wt(), wake: false } });
    const other = await sup.startRun("guido-1", 43, { loop: NEW_LOOP });
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    const busy = await refusal(sup.wakeRun(runId));
    expect([busy.status, busy.message]).toEqual([409, "GUIDO-1 already has a run"]);
    expect(store.seatSession("guido-1")?.runId).toBe(other.runId);
    expect(store.run(runId)).toMatchObject({ endedAt: null });
  });

  it("wakeRun, worktree gone: the run ends failed and the seat row is left alone", async () => {
    const { sup, runId, seen } = await aside(true);
    git(clone, "worktree", "remove", "--force", wt());
    const before = store.seatSession("guido-1");
    const e = await refusal(sup.wakeRun(runId));
    expect(e.status).toBe(500);
    expect(e.message).toContain("could not resume");
    expect(store.run(runId)).toMatchObject({ status: "failed", endedBy: "exit" });
    expect(store.run(runId)?.endedAt).not.toBeNull();
    expect(ended(seen)).toEqual([{ kind: "run-ended", seatId: "guido-1", runId, endedBy: "exit" }]);
    expect(store.seatSession("guido-1")).toEqual(before);
    expect(starts()).toHaveLength(1);
  });

  it("startRun is refused while rework waits and on a ticket in review", async () => {
    const { sup, runId } = await aside(true);
    const first = await refusal(sup.startRun("guido-1", 43));
    expect([first.status, first.message]).toEqual([409, reworkFirstText("GUIDO-1", "mc#42")]);
    store.setRunLoop(runId, { ...REVIEW, aside: { worktree: wt(), wake: false } });
    const same = await refusal(sup.startRun("guido-1", 42));
    expect([same.status, same.message]).toEqual([409, ticketInReviewText("mc#42")]);
    const next = await sup.startRun("guido-1", 43);
    expect(store.run(next.runId)).toMatchObject({ endedAt: null });
  });

  it("endRunByEngine ends an aside run, removes its worktree and leaves the seat row", async () => {
    const { sup, runId, seen } = await aside(false);
    const other = await sup.startRun("guido-1", 43);
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    const row = store.seatSession("guido-1");
    await sup.endRunByEngine(runId);
    expect(store.run(runId)).toMatchObject({ status: "ok", endedBy: "engine" });
    expect(store.run(runId)?.endedAt).not.toBeNull();
    expect(ended(seen).filter((e) => e.runId === runId)).toEqual([
      { kind: "run-ended", seatId: "guido-1", runId, endedBy: "engine" },
    ]);
    expect(existsSync(wt())).toBe(false);
    expect(store.seatSession("guido-1")).toEqual(row);
    expect(store.seatSession("guido-1")?.runId).toBe(other.runId);
    expect(sup.seatFacts("guido-1")).not.toBeNull();
  });

  it("endRunByEngine leaves a note when an aside run's worktree will not go", async () => {
    const { sup, runId } = await aside(false);
    prep.failRemove = true;
    await sup.endRunByEngine(runId);
    expect(store.run(runId)).toMatchObject({ status: "ok", endedBy: "engine" });
    expect(store.notes()).toEqual([expect.objectContaining({ key: `cleanup:${runId}` })]);
    expect(existsSync(wt())).toBe(true);
  });

  it("a scratch seat is denied an aside worktree", async () => {
    const seed = join(dir, "seed");
    const r = await (async () => {
      git(seed, "checkout", "-q", "-b", "pr");
      writeFileSync(join(seed, "a.txt"), "a\n");
      git(seed, "add", "-A");
      git(seed, "commit", "-qm", "pr change");
      git(seed, "push", "-q", "origin", "pr");
      const sha = git(seed, "rev-parse", "HEAD");
      git(seed, "checkout", "-q", "main");
      return sha;
    })();
    const author: Run = {
      id: "guido-1:20261020T000000Z",
      agentId: "guido-1",
      repoId: "mc",
      seq: 1,
      startedAt: 1,
      endedAt: null,
      status: "running",
      sessionId: "s",
      model: "haiku",
      branch: BRANCH,
      ticket: "mc#42",
      ticketTitle: TICKET.title,
      costUsd: null,
      tokens: null,
      transcriptPath: join(dir, "author.jsonl"),
      prs: [],
      summary: null,
      loop: { ...REVIEW, aside: { worktree: wt(), wake: false } },
    };
    store.upsertRun(author);
    store.setRunPush({ runId: author.id, sha: r, at: 1 });
    const reviewId = store.requestReview({
      authorRunId: author.id,
      repoId: "mc",
      seatId: "guido-1",
      prNumber: 9,
      sha: r,
      epoch: 0,
      attempt: 1,
      round: 1,
      at: 1,
    }) as number;
    store.setReviewState(reviewId, ["queued"], "starting", { at: 2 });
    const { sup } = make({ scratchRetro: true });
    sup.start();
    await sup.startReview("retro", reviewId);
    await until(() => expect(starts()).toHaveLength(1));
    const argv = starts()[0].argv as string[];
    const fs = JSON.parse(argv[argv.indexOf("--settings") + 1] as string).sandbox.filesystem;
    expect(fs.denyRead).toContain(wt());
  });
});
