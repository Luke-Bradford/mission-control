import { COMMS_CAPCOM } from "@mc/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendComms } from "../src/comms.ts";
import type { CcConfig } from "../src/config.ts";
import {
  askQa,
  QA_ASK_DAILY_LIMIT,
  QA_ASK_TOKEN_CAP,
  QA_ASK_TOOLS,
  type QaAskDeps,
} from "../src/qa-ask.ts";
import { Store } from "../src/store.ts";

const DAY = Date.parse("2026-10-30T00:00:00Z");
const pr = (number: number) =>
  ({
    repoId: "shop-app",
    number,
    title: "t",
    url: "https://github.com/o/shop-app/pull/4",
    branch: "fix/9-x",
    ticket: "shop-app#9",
    state: "open",
    isDraft: false,
    review: null,
    ci: "pending",
    createdAt: 1,
    updatedAt: 2,
    mergedAt: null,
    mergeCommitSha: null,
    headSha: null,
    mergeable: null,
    author: null,
    assignees: [],
    checks: [],
    closingIssues: [],
  }) as const;

const seat = (id: string, role: string) => ({
  id,
  role,
  accountId: "claude-main",
  model: "sonnet",
  area: [],
  ...(role === "RETRO" ? { mode: "scratch" } : {}),
});

let store: Store;
let busy: Set<string>;
let deps: QaAskDeps;
const runner = vi.fn();

beforeEach(() => {
  store = new Store(":memory:");
  store.upsertPullRequests("shop-app", [pr(4)], 0);
  busy = new Set();
  runner.mockReset();
  runner.mockResolvedValue({
    answer: "The cache test covers the miss path.",
    sources: ["test/cache.test.ts", "finding 2"],
    tokens: 1200,
  });
  const config = {
    crew: {
      worktrees: "/w",
      maxSeats: 4,
      sessions: [
        {
          id: "s1",
          repoId: "shop-app",
          checkout: "/c",
          seats: [seat("guido-1", "GUIDO"), seat("RETRO-1", "RETRO"), seat("RETRO-2", "RETRO")],
        },
      ],
    },
  } as unknown as CcConfig;
  deps = {
    config,
    store,
    now: () => DAY + 3600e3,
    seatBusy: (id) => busy.has(id),
    runner,
    send: (from, text, ref) =>
      sendComms(
        {
          store,
          crew: () => ["guido-1", "RETRO-1", "RETRO-2"],
          knownSecrets: async () => [],
          now: () => DAY + 3600e3,
          seatSender: false,
        },
        from,
        { to: COMMS_CAPCOM, text, ref },
      ),
  };
});

const ask = (text = "Which tests cover the cache?", number = 4) =>
  askQa(deps, { repoId: "shop-app", pr: number, text, day: DAY });

describe("askQa", () => {
  it("starts one read-only run and stores its answer with ref PR n", async () => {
    const out = await ask();
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]?.[0]).toMatchObject({ repoId: "shop-app", pr: 4 });
    expect(out.ok).toBe(true);
    const stored = store.commsMessage(out.ok ? out.message.id : "");
    expect(stored).toMatchObject({
      from: expect.stringMatching(/^RETRO-/),
      to: COMMS_CAPCOM,
      ref: "PR 4",
    });
    expect(stored?.text).toContain("The cache test covers the miss path.");
    expect(stored?.text).toContain("test/cache.test.ts");
  });

  it("gives the run read tools only and the 100k token cap", async () => {
    await ask();
    const job = runner.mock.calls[0]?.[0];
    expect(job.tokenCap).toBe(100_000);
    expect(QA_ASK_TOKEN_CAP).toBe(100_000);
    expect(job.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(QA_ASK_TOOLS.some((t) => /write|edit|bash|notebook/i.test(t))).toBe(false);
  });

  it("refuses the sixth question in a day with the reason, and runs nothing", async () => {
    for (let i = 0; i < QA_ASK_DAILY_LIMIT; i++) expect((await ask()).ok).toBe(true);
    const sixth = await ask();
    expect(sixth).toMatchObject({ ok: false, status: 429 });
    expect(!sixth.ok && sixth.error).toContain("5 questions per PR per day");
    expect(runner).toHaveBeenCalledTimes(QA_ASK_DAILY_LIMIT);
  });

  it("counts per PR and per day", async () => {
    store.upsertPullRequests("shop-app", [pr(5)], 0);
    for (let i = 0; i < QA_ASK_DAILY_LIMIT; i++) await ask();
    expect((await ask("other", 5)).ok).toBe(true);
    const next = await askQa(deps, {
      repoId: "shop-app",
      pr: 4,
      text: "tomorrow",
      day: DAY + 24 * 3600e3,
    });
    expect(next.ok).toBe(true);
  });

  it("asks the seat that last reviewed the PR, else any free review seat", async () => {
    const id = store.requestReview({
      authorRunId: "a",
      repoId: "shop-app",
      seatId: "RETRO-2",
      prNumber: 4,
      sha: "s",
      epoch: 1,
      attempt: 1,
      round: 1,
      at: 1,
    });
    store.setReviewState(id ?? 0, ["queued"], "reported", { at: 2 });
    await ask();
    expect(runner.mock.calls[0]?.[0].seatId).toBe("RETRO-2");
    busy.add("RETRO-2");
    await ask();
    expect(runner.mock.calls[1]?.[0].seatId).toBe("RETRO-1");
  });

  it("answers 404 for an unknown PR and 503 when no review seat is free", async () => {
    expect(await ask("q", 99)).toMatchObject({ ok: false, status: 404 });
    busy.add("RETRO-1").add("RETRO-2");
    expect(await ask()).toMatchObject({ ok: false, status: 503 });
    expect(runner).not.toHaveBeenCalled();
  });

  it("answers 502 when the run fails", async () => {
    runner.mockRejectedValue(new Error("over the token cap"));
    const out = await ask();
    expect(out).toMatchObject({ ok: false, status: 502 });
    expect(!out.ok && out.error).toContain("over the token cap");
  });
});
