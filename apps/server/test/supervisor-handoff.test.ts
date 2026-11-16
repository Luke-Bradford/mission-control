import "./supervisor-harness.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NEW_LOOP } from "@mc/core";
import { expect, it, vi } from "vitest";
import { externalReviewKey } from "../src/review/external.ts";
import { blockedHere, skipTestsIf } from "./sandbox-gaps.ts";
import { clone, git, make, prep, store, until, userLines } from "./supervisor-harness.ts";

skipTestsIf(await blockedHere("crew-run"));

const extraSeat = {
  id: "guido-2",
  role: "GUIDO",
  accountId: "claude-main",
  model: "haiku",
  area: ["apps/**"],
};

it("reserves the destination seat while its handoff status is still being captured", async () => {
  const { sup } = make({ extraSeat });
  sup.start();
  await sup.startRun("guido-1", 42);
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  let release!: () => void;
  prep.handoffGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await sup.endRun("guido-1");
  await until(() => expect(prep.handoffChecks).toBeGreaterThan(0));
  const taking = sup.startRun("guido-2", 42);
  try {
    await expect(sup.startRun("guido-2", 43)).rejects.toMatchObject({ status: 409 });
  } finally {
    release();
    prep.handoffGate = null;
  }
  const next = await taking;
  expect(store.seatSession("guido-2")?.runId).toBe(next.runId);
  expect(store.runs("guido-2", 10)).toHaveLength(1);
});

it("hands a stopped author's dirty worktree and recorded context to another seat", async () => {
  const { sup } = make({ extraSeat });
  sup.start();
  const first = await sup.startRun("guido-1", 42);
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  const path = store.seatSession("guido-1")?.worktree;
  if (!path) throw new Error("missing checkout");
  writeFileSync(join(path, "preserved.txt"), "unfinished work\n");
  store.addEvidence(first.runId, "The parser is fixed; tests remain", 1);
  await sup.endRun("guido-1");
  const second = await sup.startRun("guido-2", 42);
  expect(second.branch).toBe(first.branch);
  expect(store.seatSession("guido-2")?.worktree).toBe(path);
  expect(store.seatSession("guido-1")?.worktree).toBeNull();
  expect(readFileSync(join(path, "preserved.txt"), "utf8")).toBe("unfinished work\n");
  expect(store.receivedHandoff(second.runId)).toMatchObject({
    runId: first.runId,
    fromSeat: "guido-1",
    acceptedBy: "guido-2",
    gitState: "ready",
    gitStatus: expect.arrayContaining(["?? preserved.txt"]),
  });
  await until(() =>
    expect(userLines().some((s) => s.includes("The parser is fixed; tests remain"))).toBe(true),
  );
  expect(userLines().at(-1)).toContain("Handoff from guido-1");
});

it("preserves a removed crew author's aside and lets another configured seat adopt it", async () => {
  const { sup, cfg } = make({ extraSeat });
  sup.start();
  const first = await sup.startRun("guido-1", 42, { loop: NEW_LOOP });
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  const aside = await sup.setAside(first.runId);
  if (!aside) throw new Error("missing aside");
  writeFileSync(join(aside.worktree, "preserved.txt"), "removed seat's work");
  store.setRunLoop(first.runId, { ...NEW_LOOP, aside: { ...aside, wake: false } });
  const session = cfg.crew?.sessions[0];
  if (!session) throw new Error("missing session");
  session.seats = session.seats.filter((s) => s.id !== "guido-1");
  expect(sup.endRemovedAside?.(first.runId)).toBe(true);
  expect(store.openHandoff("mc", "mc#42")?.runId).toBe(first.runId);
  const next = await sup.startRun("guido-2", 42);
  expect(store.seatSession("guido-2")?.worktree).toBe(aside.worktree);
  expect(readFileSync(join(aside.worktree, "preserved.txt"), "utf8")).toBe("removed seat's work");
  expect(store.receivedHandoff(next.runId)?.fromSeat).toBe("guido-1");
});

it("refuses takeover until an engine-ended author's held close has actually stopped its CLI", async () => {
  const { sup } = make({ extraSeat });
  sup.start();
  const first = await sup.startRun("guido-1", 42);
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  let release!: () => void;
  prep.closeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ending = sup.endRunByEngine(first.runId);
  try {
    await until(() => expect(prep.closing).toBeGreaterThan(0));
    expect(store.run(first.runId)?.endedAt).not.toBeNull();
    await expect(sup.startRun("guido-2", 42)).rejects.toMatchObject({ status: 409 });
    expect(store.openHandoff("mc", "mc#42")?.acceptedRunId).toBeNull();
  } finally {
    release();
    prep.closeGate = null;
  }
  await ending;
  const next = await sup.startRun("guido-2", 42);
  expect(store.receivedHandoff(next.runId)?.runId).toBe(first.runId);
});

it("keeps unfinished work when the engine ends an active or set-aside author", async () => {
  const { sup } = make({ extraSeat });
  sup.start();
  const first = await sup.startRun("guido-1", 42, {
    loop: { ...NEW_LOOP, controllerCheckRequired: true },
  });
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  const path = store.seatSession("guido-1")?.worktree;
  if (!path) throw new Error("missing checkout");
  writeFileSync(join(path, "preserved.txt"), "keep me");
  await sup.endRunByEngine(first.runId);
  expect(existsSync(path)).toBe(true);
  const next = await sup.startRun("guido-2", 42);
  expect(store.run(next.runId)?.loop?.controllerCheckRequired).toBe(true);
  await until(() => expect(store.seatSession("guido-2")?.state).toBe("idle"));
  const aside = await sup.setAside(next.runId);
  expect(aside).not.toBeNull();
  const nextRun = store.run(next.runId);
  if (!nextRun?.loop || !aside) throw new Error("missing aside");
  store.setRunLoop(next.runId, { ...nextRun.loop, aside: { ...aside, wake: false } });
  await sup.endRunByEngine(next.runId);
  expect(readFileSync(join(path, "preserved.txt"), "utf8")).toBe("keep me");
  expect(store.openHandoff("mc", "mc#42")?.runId).toBe(next.runId);
});

it("inherits only source-owned commits that are on the preserved branch", async () => {
  const { sup } = make({ extraSeat });
  sup.start();
  const first = await sup.startRun("guido-1", 42);
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  const path = store.seatSession("guido-1")?.worktree;
  if (!path) throw new Error("missing checkout");
  writeFileSync(join(path, "owned.txt"), "owned");
  git(path, "add", "owned.txt");
  git(path, "commit", "-m", "saved work");
  const sha = git(path, "rev-parse", "HEAD");
  store.addRunCommit({ runId: first.runId, repoId: "mc", branch: first.branch, sha, at: 1 });
  store.addRunCommit({
    runId: first.runId,
    repoId: "mc",
    branch: first.branch,
    sha: "a".repeat(40),
    at: 1,
  });
  await sup.endRun("guido-1");
  const second = await sup.startRun("guido-2", 42);
  expect(store.runCommits(second.runId)).toEqual([sha]);
  expect(git(clone, "rev-parse", first.branch)).toBe(sha);
});

it("starts the returned seat on the open PR's own ref, not the ended run's local branch", async () => {
  const { sup } = make({ extraSeat });
  sup.start();
  const first = await sup.startRun("guido-1", 42, { loop: NEW_LOOP });
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  const path = store.seatSession("guido-1")?.worktree;
  if (!path) throw new Error("missing checkout");
  writeFileSync(join(path, "pr.txt"), "pr");
  git(path, "add", "pr.txt");
  git(path, "commit", "-m", "pr work");
  const tip = git(path, "rev-parse", "HEAD");
  const head = "feature/42-pr-head";
  git(path, "push", "origin", `HEAD:refs/heads/${head}`);
  store.setRunLoop(first.runId, { ...NEW_LOOP, prNumber: 9 });
  store.upsertPullRequests(
    "mc",
    [
      {
        repoId: "mc",
        number: 9,
        title: "PR",
        url: "u",
        branch: head,
        ticket: "mc#42",
        state: "open",
        isDraft: false,
        review: null,
        ci: "pending",
        createdAt: 1,
        updatedAt: 1,
        mergedAt: null,
        headSha: tip,
        mergeable: null,
      },
    ],
    1,
  );
  // the hub's own review of the PR head reported after the first author ended
  const reviewId = store.requestReview({
    authorRunId: externalReviewKey("mc", 9),
    repoId: "mc",
    seatId: "retro",
    prNumber: 9,
    sha: tip,
    epoch: 0,
    attempt: 1,
    round: 1,
    at: 2,
  });
  if (reviewId === null) throw new Error("review not queued");
  store.setReviewState(reviewId, ["queued"], "running", { runId: "retro:x", at: 3 });
  store.recordFindings(reviewId, "retro:x", {
    verdict: { spec: "pass", quality: "fail" },
    summary: "one finding",
    findings: [
      {
        severity: "Important",
        file: "pr.txt",
        line: 1,
        summary: "the pr file is wrong",
        scenario: "it breaks",
        fix: "fix the pr file",
      },
    ],
    at: 4,
  });
  await sup.endRun("guido-1");
  const second = await sup.startRun("guido-2", 42);
  await until(() => expect(userLines().some((l) => l.includes("the pr file is wrong"))).toBe(true));
  const brief = userLines().find((l) => l.includes("the pr file is wrong")) ?? "";
  expect(brief).toContain(`Branch: ${head}`);
  expect(brief).not.toContain(`Branch: ${first.branch}`);
  expect(first.branch).not.toBe(head);
  expect(second.branch).toBe(head);
  expect(store.run(second.runId)?.branch).toBe(head);
  const worktree = store.seatSession("guido-2")?.worktree;
  if (!worktree) throw new Error("missing checkout");
  expect(git(worktree, "symbolic-ref", "HEAD")).toBe(`refs/heads/${head}`);
  expect(git(worktree, "rev-parse", "HEAD")).toBe(tip);
});

/** guido-1 ends ticket 42; guido-2 takes it over in guido-1's tree, commits, and is set aside. */
async function handedOverAside(sup: ReturnType<typeof make>["sup"]) {
  const first = await sup.startRun("guido-1", 42, { loop: NEW_LOOP });
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  const path = store.seatSession("guido-1")?.worktree;
  if (!path) throw new Error("missing checkout");
  await sup.endRun("guido-1");
  const handed = await sup.startRun("guido-2", 42, { loop: NEW_LOOP });
  expect(store.seatSession("guido-2")?.worktree).toBe(path);
  await until(() => expect(store.seatSession("guido-2")?.state).toBe("idle"));
  writeFileSync(join(path, "waiting.txt"), "committed while waiting\n");
  git(path, "add", "waiting.txt");
  git(path, "commit", "-qm", "waiting work");
  const sha = git(path, "rev-parse", "HEAD");
  const aside = await sup.setAside(handed.runId);
  if (!aside) throw new Error("missing aside");
  store.setRunLoop(handed.runId, { ...NEW_LOOP, aside: { ...aside, wake: false } });
  return { path, branch: first.branch, handed, sha };
}
const headOf = (path: string) => git(path, "rev-parse", "--abbrev-ref", "HEAD");

it("a handed-over run waits (409, still aside) while the first seat's new run holds the tree, then resumes with its commits", async () => {
  const { sup } = make({ extraSeat });
  sup.start();
  const { path, branch, handed, sha } = await handedOverAside(sup);
  await sup.startRun("guido-1", 43);
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  expect(headOf(path)).not.toBe(branch);
  await expect(sup.wakeRun(handed.runId)).rejects.toMatchObject({ status: 409 });
  expect(store.run(handed.runId)?.endedAt).toBeNull();
  expect(store.run(handed.runId)?.loop?.aside).not.toBeNull();
  expect(headOf(path)).not.toBe(branch);
  await sup.endRun("guido-1");
  await sup.wakeRun(handed.runId);
  expect(store.seatSession("guido-2")).toMatchObject({ runId: handed.runId, worktree: path });
  expect(headOf(path)).toBe(branch);
  expect(git(path, "rev-parse", "HEAD")).toBe(sha);
});

it("a handed-over run's wake is refused while the first seat's start is still claiming its ticket", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const claim = vi.fn(async (_repo: unknown, issue: number) => {
    if (issue === 43) await gate;
  });
  const { sup } = make({ extraSeat, claim });
  sup.start();
  const { path, branch, handed } = await handedOverAside(sup);
  const starting = sup.startRun("guido-1", 43);
  try {
    // the tree is on ticket 43's branch, but guido-1's seat row does not name it yet
    await until(() => expect(claim).toHaveBeenCalledWith(expect.anything(), 43));
    expect(store.seatSession("guido-1")?.runId ?? null).toBeNull();
    await expect(sup.wakeRun(handed.runId)).rejects.toMatchObject({ status: 409 });
    expect(headOf(path)).not.toBe(branch);
    expect(headOf(path)).toMatch(/^feature\/43/);
  } finally {
    release();
  }
  await starting;
  expect(headOf(path)).toMatch(/^feature\/43/);
  expect(store.run(handed.runId)?.endedAt).toBeNull();
});

it("the first seat's start waits (409) while a handed-over run holds its tree, and moves it once that run ended", async () => {
  const { sup } = make({ extraSeat });
  sup.start();
  const first = await sup.startRun("guido-1", 42);
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  const path = store.seatSession("guido-1")?.worktree;
  if (!path) throw new Error("missing checkout");
  await sup.endRun("guido-1");
  const handed = await sup.startRun("guido-2", 42);
  await until(() => expect(store.seatSession("guido-2")?.state).toBe("idle"));
  const before = store.runs("guido-1", 10).length;
  await expect(sup.startRun("guido-1", 43)).rejects.toMatchObject({ status: 409 });
  expect(store.runs("guido-1", 10)).toHaveLength(before);
  expect(headOf(path)).toBe(first.branch);
  // the handed-over run ends: its seat row still names the tree, but no run holds it
  await sup.endRun("guido-2");
  expect(store.seatSession("guido-2")?.worktree).toBe(path);
  expect(store.run(handed.runId)?.endedAt).not.toBeNull();
  const other = await sup.startRun("guido-1", 43);
  expect(store.seatSession("guido-1")?.worktree).toBe(path);
  expect(headOf(path)).toBe(other.branch);
});
