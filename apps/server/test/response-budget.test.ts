import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  HUD_PAGE_BUDGET_BYTES,
  HUD_RESPONSE_BUDGET_BYTES,
  type PrCheck,
  type PullRequestView,
  type Run,
  type RunDigest,
} from "@mc/core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

/**
 * #1192: each HUD page's first load, built from a large fixture (what a few months of the live hub
 * holds), stays under the budgets. The routes are the ones a page asks for on arrival, in the form
 * `docs/hud-response-budgets.md` gives; a page that fetches a whole history fails here.
 */
const DAY = 86_400_000;
/** A response is built within this long on the large fixture (the page shows data within 1 s). */
const RESPONSE_MS = 1000;
const SEAT_IDS = [
  "flight-1",
  ...Array.from({ length: 5 }, (_, i) => `guido-${i + 1}`),
  ...Array.from({ length: 4 }, (_, i) => `inco-${i + 1}`),
  ...Array.from({ length: 4 }, (_, i) => `retro-${i + 1}`),
];
const REPOS = ["mission-control", "shop-app", "site-builder"];
const FLIGHT = "flight-1";
const HEAVY = SEAT_IDS[1] as string;

const PAGES: Record<string, string[]> = {
  Overview: [
    "/api/crew?shape=summary",
    ...REPOS.map((r) => `/api/repos/${r}/prs?shape=summary`),
    `/api/agents/${FLIGHT}/stream?limit=20`,
    "/api/flight",
    "/api/activity",
    "/api/overview",
  ],
  Comms: [
    ...SEAT_IDS.map((id) => `/api/comms/agents/${id}?summary=1`),
    `/api/comms/agents/${HEAVY}`,
    "/api/comms/crew",
    "/api/comms/flight",
    "/api/crew?shape=summary",
  ],
  Board: [
    ...REPOS.map((r) => `/api/repos/${r}/prs?linked=1&shape=summary`),
    "/api/crew?shape=summary",
    `/api/boards/${REPOS[0]}`,
  ],
  Audit: ["/api/audit?range=30d"],
  Agent: [
    `/api/repos/${REPOS[0]}/prs?shape=summary`,
    `/api/agents/${HEAVY}/runs`,
    "/api/activity",
    `/api/agents/${HEAVY}/stream?limit=20`,
    `/api/crew/${HEAVY}`,
  ],
};

/** Seeded text that gzip cannot squash, as real messages, titles and ids are not repetitive. */
let seed = 7;
const next = (): number => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed;
};
const noise = (words: number): string =>
  Array.from({ length: words }, () => next().toString(36)).join(" ");

let dir: string;
let store: Store;
let app: ReturnType<typeof buildApp>;

const check = (i: number): PrCheck => ({
  id: `PRC_${noise(3).replaceAll(" ", "")}`,
  workflow: "CI",
  name: `job ${i}`,
  kind: "check",
  state: "passing",
  conclusion: "success",
  attempt: 1,
  url: `https://github.com/o/repo/actions/runs/${noise(1)}/job/${noise(1)}`,
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "mc-budget-"));
  mkdirSync(join(dir, "worktrees"));
  store = new Store(join(dir, "db.sqlite"));
  const now = Date.now();
  const seat = (id: string) => ({
    id,
    role: id.startsWith("flight")
      ? "FLIGHT"
      : id.startsWith("guido")
        ? "GUIDO"
        : id.startsWith("inco")
          ? "INCO"
          : "RETRO",
    accountId: "demo",
    model: "opus",
    area: id.startsWith("guido") ? ["apps/server/**"] : [],
  });
  const config: CcConfig = {
    operator: { id: "operator", timezone: "UTC" },
    accounts: [],
    repos: REPOS.map((id) => ({
      id,
      github: `o/${id}`,
      project: 1,
      statusMap: { Todo: "planned" },
      autonomy: "draft" as const,
    })),
    poll: { usageMinutes: 30, githubSeconds: 60 },
    loops: [],
    crew: {
      worktrees: join(dir, "worktrees"),
      maxSeats: SEAT_IDS.length,
      sessions: [
        {
          id: "demo",
          repoId: REPOS[0] as string,
          checkout: join(dir, "checkout"),
          seats: SEAT_IDS.map(seat),
        },
      ],
    },
  };

  // Pull requests: a few months of them per repo, most long merged, each with a dozen checks.
  for (const repoId of REPOS) {
    const prs: PullRequestView[] = Array.from({ length: 400 }, (_, i) => {
      const age = (400 - i) * 0.5;
      return {
        repoId,
        number: i + 1,
        title: noise(9),
        url: `https://github.com/o/${repoId}/pull/${i + 1}`,
        branch: `feature/${i + 1}-${noise(3).replaceAll(" ", "-")}`,
        ticket: i % 3 === 0 ? null : `${repoId}#${i + 1}`,
        state: i >= 395 ? "open" : "merged",
        isDraft: false,
        review: null,
        ci: "passing",
        createdAt: now - (age + 1) * DAY,
        updatedAt: now - age * DAY,
        mergedAt: i >= 395 ? null : now - age * DAY,
        mergeCommitSha: noise(7).replaceAll(" ", ""),
        headSha: noise(7).replaceAll(" ", ""),
        mergeable: "MERGEABLE",
        author: "someone",
        assignees: ["someone"],
        checks: Array.from({ length: 12 }, (_, n) => check(n)),
        closingIssues: [i + 1],
      };
    });
    store.upsertPullRequests(repoId, prs, now);
  }

  // Comms: a long history between every seat and its neighbours, messages of a few hundred bytes.
  for (let i = 0; i < 4000; i++) {
    const body = noise(60);
    const from = SEAT_IDS[i % SEAT_IDS.length] as string;
    const to = SEAT_IDS[(i * 7 + 1) % SEAT_IDS.length] as string;
    if (from !== to)
      store.addComms({
        from,
        to,
        text: `${i} ${body}`,
        at: now - (4000 - i) * 60_000,
        ticket: null,
      });
  }

  // Runs with digests: thirty per seat, the digest as heavy as a long run leaves it.
  const digest = (): RunDigest => ({
    toolCalls: 400,
    turns: 120,
    lastEventAt: now,
    model: "opus",
    contextTokens: 120_000,
    contextWindow: 200_000,
    liveTool: null,
    tools: Object.fromEntries(
      Array.from({ length: 25 }, (_, n) => [
        `tool${n}`,
        {
          calls: 10,
          failed: 1,
          durationsMs: Array.from(
            { length: 50 },
            () => Number(noise(1).length) * 137 + (seed % 9973),
          ),
        },
      ]),
    ),
    subagents: [],
    minuteTokens: Array.from({ length: 120 }, (_, n): [number, number] => [
      now - n * 60_000,
      1000 + (next() % 5000),
    ]),
    turnUsage: Array.from({ length: 60 }, () => ({ input: 100, output: 200, cacheRead: 3000 })),
    background: [],
    compactions: 1,
    attemptUsage: Array.from({ length: 300 }, (_, n) => ({
      id: `m${n}`,
      at: now - n * 1000,
      tokens: 1000,
    })),
    toolStarts: Array.from({ length: 300 }, (_, n) => now - n * 1000),
  });
  for (const id of SEAT_IDS) {
    for (let n = 1; n <= 30; n++) {
      const run: Run = {
        id: `${id}-r${n}`,
        agentId: id,
        repoId: REPOS[0] as string,
        seq: n,
        startedAt: now - (31 - n) * 3_600_000,
        endedAt: n === 30 ? null : now - (30 - n) * 3_600_000,
        status: n === 30 ? "running" : "ok",
        sessionId: null,
        model: "opus",
        branch: `feature/${n}-work`,
        ticket: `${REPOS[0]}#${n}`,
        costUsd: 1.5,
        tokens: { input: 1000, output: 2000, cacheRead: 30000, cacheCreate: 500 },
        transcriptPath: "",
        prs: [],
        summary: "Did the work and reported it.",
      };
      store.upsertRun(run);
      store.setDigest(run.id, digest());
    }
  }

  // FLIGHT's transcript: two thousand events.
  const lines = Array.from({ length: 2000 }, (_, i) =>
    JSON.stringify({
      type: "assistant",
      message: { id: `m${i}`, content: [{ type: "text", text: `${i} ${noise(60)}` }] },
      parent_tool_use_id: null,
      timestamp: new Date(now - (2000 - i) * 1000).toISOString(),
    }),
  );
  for (const id of [FLIGHT, HEAVY]) {
    const path = join(dir, `${id}.jsonl`);
    writeFileSync(path, `${lines.join("\n")}\n`);
    store.upsertRun({
      id: `${id}-r30`,
      agentId: id,
      repoId: REPOS[0] as string,
      seq: 30,
      startedAt: now - 3_600_000,
      endedAt: null,
      status: "running",
      sessionId: null,
      model: "opus",
      branch: null,
      ticket: null,
      costUsd: null,
      tokens: null,
      transcriptPath: path,
      prs: [],
      summary: null,
    });
  }
  app = buildApp({ config, store, bus: new ChangeBus() });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

it.each(Object.entries(PAGES))("%s: first load stays within the budgets", async (page, urls) => {
  const sizes: { url: string; bytes: number; ms: number }[] = [];
  for (const url of urls) {
    const started = performance.now();
    const res = await app.inject({ url });
    const ms = performance.now() - started;
    expect(res.statusCode, url).toBe(200);
    sizes.push({ url, bytes: gzipSync(res.rawPayload).length, ms });
  }
  const total = sizes.reduce((sum, s) => sum + s.bytes, 0);
  const report = sizes.map((s) => `${kb(s.bytes)} ${Math.round(s.ms)}ms ${s.url}`).join("\n");
  console.info(`${page}: ${kb(total)} gzipped\n${report}`);
  for (const s of sizes)
    expect(s.ms, `${s.url} took ${Math.round(s.ms)} ms`).toBeLessThan(RESPONSE_MS);
  for (const s of sizes)
    expect(s.bytes, `${s.url} is ${kb(s.bytes)}\n${report}`).toBeLessThanOrEqual(
      HUD_RESPONSE_BUDGET_BYTES,
    );
  expect(total, `${page} is ${kb(total)}\n${report}`).toBeLessThanOrEqual(HUD_PAGE_BUDGET_BYTES);
});
