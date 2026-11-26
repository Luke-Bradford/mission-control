// Times every request a HUD page makes on opening, on a COPY of the hub database (#2219).
// The app is built in-process, as the hub builds it, with no loops, crew or engine running, so
// nothing writes to GitHub or a loop. The database given is copied first; the copy is deleted after.
// Run from the repo root:
//   node --experimental-strip-types apps/server/scripts/first-load-timings.ts --db <db> [--config <config.yaml>] [--rounds 5] [--only <url>,<url>]
// Each GET is timed "cold", right after another connection writes one run row (as the live hub
// writes every second or so, which drops every cache keyed on the store's version), and "warm",
// repeated unchanged. Every sample must answer 2xx: a request that errs or times out is listed as
// failed and the run exits 1, so a missing route can never pass as a fast one.
// Without --config, the repos and seats come from the database. Routes with path parameters are
// filled with the database's newest ids (PARAM_ROUTES); one it cannot fill is listed as not timed.
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  commsAgentPath,
  crewDetailPath,
  dockStreamPath,
  FIRST_LOAD_PAGES,
  firstLoadPaths,
  prListPath,
} from "@mc/core";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import { type CcConfig, loadConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

/**
 * Routes left out: the event stream and the live update log do not answer once and end, and the
 * Sessions page's list reads cmux live with the operator's token, not the database.
 */
const SKIP = new Set(["/api/stream", "/api/update/log", "/api/sessions", "/api/sessions/sidebar"]);
/** Routes that read config.yaml itself: timed only when --config names one. */
const CONFIG_FILE_ROUTES = new Set(["/api/config/settings"]);
/** A request still running after this long is reported, not waited for. */
const DEADLINE_MS = 30_000;
/** The budget each request is held to, right after a write. */
export const OPENING_BUDGET_MS = 300;

/** Real ids from the copied database, to fill the routes with path parameters. */
export interface OpeningIds {
  repo: string;
  /** The seat the Agent page shows, and another to pair it with. */
  seat: string;
  other: string;
  /** The repo's newest PR. */
  pr: { number: number; headSha: string } | null;
  /** The repo's newest ticket on the board. */
  ticket: number | null;
  /** The seat's newest run. */
  run: string | null;
  comms: number | null;
  qaReport: string | null;
  /** The newest order to every seat. */
  order: number | null;
  /** An open Needs-you item, read from the app itself. */
  attention: string | null;
}

/** A filled URL, or what the database lacks to fill it. */
type Fill = { url: string } | { lacks: string };
interface ParamRoute {
  fill?: (ids: OpeningIds) => Fill;
  /** Why it is left out, for a route that reads no database. */
  skip?: string;
  /** 404 is the route's answer for "none" (the web shows nothing): it counts as answered. */
  noneIs404?: boolean;
  /** It reads config.yaml itself: timed only when --config names one. */
  configFile?: boolean;
}

const e = encodeURIComponent;
const need = <T>(v: T | null, what: string, url: (v: T) => string): Fill =>
  v === null ? { lacks: what } : { url: url(v) };
const pr = (ids: OpeningIds, url: (p: { number: number; headSha: string }) => string): Fill =>
  need(ids.pr, "pull request", url);

/**
 * Every GET route with a path parameter: filled with real ids, with the query the web sends, or
 * left out with why. A test holds every registered route to an entry here, so none is left out
 * unseen.
 */
export const PARAM_ROUTES: Record<string, ParamRoute> = {
  "/api/agents/:id": { fill: (i) => ({ url: `/api/agents/${e(i.seat)}` }) },
  "/api/agents/:id/runs": { fill: (i) => ({ url: `/api/agents/${e(i.seat)}/runs?limit=50` }) },
  "/api/agents/:id/stream": { fill: (i) => ({ url: dockStreamPath(i.seat) }) },
  "/api/agents/:id/files": { skip: "runs git in the seat's worktree, not a database read" },
  "/api/agents/:id/files/diff": { skip: "runs git in the seat's worktree, not a database read" },
  "/api/runs/:id/handoff": {
    fill: (i) => need(i.run, "run", (r) => `/api/runs/${e(r)}/handoff`),
  },
  "/api/runs/:id/attempts": {
    fill: (i) => need(i.run, "run", (r) => `/api/runs/${e(r)}/attempts`),
  },
  "/api/runs/:id/loop": { fill: (i) => need(i.run, "run", (r) => `/api/runs/${e(r)}/loop`) },
  "/api/comms/:id": { fill: (i) => ({ url: `/api/comms/${e(i.seat)}` }) },
  "/api/comms/:id/reply-route": {
    fill: (i) => need(i.comms, "Comms message", (c) => `/api/comms/comms%3A${c}/reply-route`),
  },
  "/api/comms/:id/state": {
    fill: (i) => need(i.comms, "Comms message", (c) => `/api/comms/comms%3A${c}/state`),
  },
  "/api/comms/agents/:id": { fill: (i) => ({ url: commsAgentPath(i.seat) }) },
  "/api/comms/agents/:id/contacts/:contact": {
    fill: (i) => ({ url: `/api/comms/agents/${e(i.seat)}/contacts/${e(i.other)}` }),
  },
  "/api/comms/pairs/:a/:b": {
    fill: (i) => ({ url: `/api/comms/pairs/${e(i.other)}/${e(i.seat)}` }),
  },
  "/api/comms/tickets/:ref": {
    fill: (i) =>
      need(
        i.ticket,
        "ticket",
        (t) => `/api/comms/tickets/${e(`#${t}`)}?ticket=${e(`${i.repo}#${t}`)}`,
      ),
  },
  "/api/qa/history/native/:id": {
    skip: "opens on a past native review, by an identity hash the history list carries",
  },
  "/api/qa-reports/:id": {
    fill: (i) => need(i.qaReport, "QA report", (r) => `/api/qa-reports/${e(r)}`),
  },
  "/api/qa-reports/:id/markdown": {
    fill: (i) => need(i.qaReport, "QA report", (r) => `/api/qa-reports/${e(r)}/markdown`),
  },
  "/api/qa-report-assets/:id": { skip: "serves a stored image, after the page's data" },
  "/api/qa/review-shots/:id": { skip: "serves a stored image, after the page's data" },
  "/api/plan-assets/:id": { skip: "serves a stored image, after the page's data" },
  "/api/hud-screenshots/:id": { skip: "serves a stored image, after the page's data" },
  "/api/attention-material-assets/:id": { skip: "serves a stored image, after the page's data" },
  "/api/qa/uat/:repoId/:number": {
    fill: (i) => pr(i, (p) => `/api/qa/uat/${e(i.repo)}/${p.number}?head=${e(p.headSha)}`),
  },
  "/api/accounts/:id/models": {
    skip: "asks the account's CLI for its models once, then keeps them",
  },
  "/api/repos/:repoId/rules": {
    fill: (i) => ({ url: `/api/repos/${e(i.repo)}/rules` }),
    configFile: true,
  },
  "/api/repos/:repoId/prs": { fill: (i) => ({ url: prListPath(i.repo) }) },
  "/api/repos/:repoId/prs/titles": {
    fill: (i) => pr(i, (p) => `/api/repos/${e(i.repo)}/prs/titles?numbers=${p.number}`),
  },
  "/api/repos/:repoId/prs/:number": {
    // as the QA page asks for the selected PR (apps/web/src/pages/QaReadiness.tsx)
    fill: (i) => pr(i, (p) => `/api/repos/${e(i.repo)}/prs/${p.number}?head=${e(p.headSha)}`),
  },
  "/api/boards/:repoId": { fill: (i) => ({ url: `/api/boards/${e(i.repo)}` }) },
  "/api/boards/:repoId/items/:number": { skip: "reads GitHub live, once per visit" },
  "/api/boards/:repoId/setup": { skip: "reads GitHub live, once per check" },
  "/api/tickets/:repoId/:number": {
    fill: (i) => need(i.ticket, "ticket", (t) => `/api/tickets/${e(i.repo)}/${t}`),
  },
  "/api/tickets/:repoId/:number/set-aside": {
    fill: (i) => need(i.ticket, "ticket", (t) => `/api/tickets/${e(i.repo)}/${t}/set-aside`),
  },
  "/api/prs/:n/evidence": {
    fill: (i) =>
      pr(i, (p) => `/api/prs/${p.number}/evidence?repo=${e(i.repo)}&sha=${e(p.headSha)}`),
    noneIs404: true,
  },
  "/api/prs/:n/evidence/:sha/:name": { skip: "serves a stored image, after the page's data" },
  "/api/flight/orders/:id": {
    fill: (i) => need(i.order, "order to every seat", (o) => `/api/flight/orders/${o}`),
  },
  "/api/seats/:id/instructions": {
    fill: (i) => ({ url: `/api/seats/${e(i.seat)}/instructions?limit=1` }),
  },
  "/api/seats/:id/focus": { fill: (i) => ({ url: `/api/seats/${e(i.seat)}/focus` }) },
  "/api/seats/:id/context": { skip: "reads the seat's CLI live, not the database" },
  "/api/crew/:id": { fill: (i) => ({ url: crewDetailPath(i.seat) }) },
  "/api/attention/:key": {
    fill: (i) => need(i.attention, "open Needs-you item", (k) => `/api/attention/${e(k)}`),
  },
  "/api/attention/:key/materials": {
    fill: (i) =>
      need(i.attention, "open Needs-you item", (k) => `/api/attention/${e(k)}/materials`),
    noneIs404: true,
  },
  "/api/attention/:key/thread": {
    fill: (i) => need(i.attention, "open Needs-you item", (k) => `/api/attention/${e(k)}/thread`),
  },
  "/api/attention/:key/choice": {
    fill: (i) => need(i.attention, "open Needs-you item", (k) => `/api/attention/${e(k)}/choice`),
    noneIs404: true,
  },
};

/** The ids `PARAM_ROUTES` fills from, read from the copied database (the attention key aside). */
export function idsFromDb(db: DatabaseSync, config: CcConfig): Omit<OpeningIds, "attention"> {
  const seatIds = (config.crew?.sessions ?? []).flatMap((s) => s.seats.map((x) => x.id));
  const seat = seatIds.find((id) => id.startsWith("guido")) ?? seatIds[0] ?? "guido-1";
  const other = seatIds.find((id) => id.startsWith("flight")) ?? seatIds.find((id) => id !== seat);
  const repo = config.repos[0]?.id ?? "";
  const one = <T>(sql: string, ...args: (string | number)[]) =>
    (db.prepare(sql).get(...args) as T | undefined) ?? null;
  const prRow = one<{ number: number; head_sha: string | null }>(
    "SELECT number, head_sha FROM pull_requests WHERE repo_id = ? ORDER BY number DESC LIMIT 1",
    repo,
  );
  return {
    repo,
    seat,
    other: other ?? seat,
    pr: prRow === null ? null : { number: prRow.number, headSha: prRow.head_sha ?? "" },
    ticket:
      one<{ n: number }>(
        "SELECT issue_number AS n FROM board_items WHERE repo_id = ? ORDER BY updated_at DESC LIMIT 1",
        repo,
      )?.n ?? null,
    run:
      one<{ id: string }>(
        "SELECT id FROM runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT 1",
        seat,
      )?.id ?? null,
    comms: one<{ id: number }>("SELECT max(id) AS id FROM comms")?.id ?? null,
    qaReport:
      one<{ id: string }>("SELECT id FROM qa_reports ORDER BY registered_at DESC LIMIT 1")?.id ??
      null,
    order:
      one<{ id: number }>(
        "SELECT max(id) AS id FROM standing_instructions WHERE seat_id IS NULL AND revoked_at IS NULL",
      )?.id ?? null,
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

export function configFromDb(db: DatabaseSync): CcConfig {
  const repos = (
    db.prepare("SELECT DISTINCT repo_id AS id FROM pull_requests ORDER BY repo_id").all() as {
      id: string;
    }[]
  ).map((r) => r.id);
  const seats = (
    db
      .prepare(
        "SELECT agent_id AS id FROM runs GROUP BY agent_id ORDER BY max(started_at) DESC LIMIT 30",
      )
      .all() as { id: string }[]
  ).map((r) => r.id);
  const role = (id: string) =>
    id.startsWith("flight")
      ? "FLIGHT"
      : id.startsWith("guido")
        ? "GUIDO"
        : id.startsWith("inco")
          ? "INCO"
          : "RETRO";
  return {
    operator: { id: "operator", timezone: "UTC" },
    accounts: [],
    repos: repos.map((id) => ({
      id,
      github: `o/${id}`,
      project: 1,
      statusMap: { Todo: "planned" },
      autonomy: "draft" as const,
    })),
    poll: { usageMinutes: 30, githubSeconds: 60 },
    loops: [],
    crew: {
      worktrees: join(tmpdir(), "mc-timings-worktrees"),
      maxSeats: seats.length,
      sessions: [
        {
          id: "timings",
          repoId: repos[0] ?? "",
          checkout: join(tmpdir(), "mc-timings-checkout"),
          seats: seats.map((id) => ({
            id,
            role: role(id),
            accountId: "a",
            model: "opus",
            area: [],
          })),
        },
      ],
    },
  } as CcConfig;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

export interface Timing {
  url: string;
  /** Median ms right after a write, and repeated unchanged. */
  cold: number;
  warm: number;
  /** Every status a sample answered, in order; "timeout" for one that did not answer. */
  statuses: (number | "timeout")[];
  /** Why the request fails the run: an error status or a timeout; null when every sample was 2xx. */
  failure: string | null;
}

export interface TimingRun {
  rows: Timing[];
  /** The requests at or over the budget, right after a write. */
  slow: Timing[];
  failed: Timing[];
  /** Opening requests left out, each with why. */
  notTimed: string[];
}

/**
 * Builds the app on `store` and times `urls`, or every request the pages make on opening: each
 * page's first-load routes (`firstLoadPaths`, with the config's repos and seats) and every GET
 * route the app registers without a path parameter (the shell's and the pages' own reads).
 * `touch` is a write by another connection, made before each cold sample.
 */
export async function timeOpening(o: {
  store: Store;
  config: CcConfig;
  /** The config.yaml the routes that read the file answer from, read only; absent: they are not timed. */
  configReadPath?: string;
  touch: () => void;
  /** The database the ids of the routes with path parameters are read from; absent: none are timed. */
  db?: DatabaseSync;
  rounds: number;
  urls?: string[];
}): Promise<TimingRun> {
  const app = buildApp({
    config: o.config,
    store: o.store,
    bus: new ChangeBus(),
    noLoopWrites: true,
    ...(o.configReadPath === undefined ? {} : { configReadPath: o.configReadPath }),
  });
  const gets: string[] = [];
  const withParams: string[] = [];
  // the /api routes are registered in a plugin that runs on ready(), after this hook is added
  app.addHook("onRoute", (r) => {
    if (![r.method].flat().includes("GET") || !r.url.startsWith("/api/") || SKIP.has(r.url)) return;
    (r.url.includes(":") ? withParams : gets).push(r.url);
  });
  await app.ready();
  try {
    const notTimed: string[] = [];
    /** URLs whose 404 is the route's answer for "none". */
    const noneIs404 = new Set<string>();
    const filled: string[] = [];
    if (o.urls === undefined) {
      if (o.configReadPath === undefined)
        for (const g of gets.filter((g) => CONFIG_FILE_ROUTES.has(g)))
          notTimed.push(`${g}: reads config.yaml; pass --config`);
      const ids =
        o.db === undefined
          ? null
          : { ...idsFromDb(o.db, o.config), attention: await firstAttentionKey(app) };
      for (const route of withParams) {
        const entry = PARAM_ROUTES[route];
        const fill = entry?.fill === undefined || ids === null ? null : entry.fill(ids);
        if (entry === undefined) notTimed.push(`${route}: not in PARAM_ROUTES`);
        else if (entry.skip !== undefined) notTimed.push(`${route}: ${entry.skip}`);
        else if (entry.configFile && o.configReadPath === undefined)
          notTimed.push(`${route}: reads config.yaml; pass --config`);
        else if (fill === null) notTimed.push(`${route}: no database given`);
        else if ("lacks" in fill) notTimed.push(`${route}: no ${fill.lacks} in the database`);
        else {
          filled.push(fill.url);
          if (entry.noneIs404) noneIs404.add(fill.url);
        }
      }
    }
    const urls =
      o.urls ??
      openingUrls(
        o.config,
        o.configReadPath === undefined ? gets.filter((g) => !CONFIG_FILE_ROUTES.has(g)) : gets,
        filled,
      );
    const time = async (url: string): Promise<{ ms: number; status: number | "timeout" }> => {
      const started = performance.now();
      const res = await Promise.race([
        app.inject({ url }),
        new Promise<null>((r) => setTimeout(() => r(null), DEADLINE_MS).unref()),
      ]);
      return { ms: performance.now() - started, status: res === null ? "timeout" : res.statusCode };
    };
    const rows: Timing[] = [];
    for (const url of urls) {
      const ok = (s: number | "timeout") =>
        s !== "timeout" && ((s >= 200 && s < 300) || (s === 404 && noneIs404.has(url)));
      const cold: number[] = [];
      const warm: number[] = [];
      const statuses: (number | "timeout")[] = [];
      for (let i = 0; i < o.rounds; i++) {
        o.touch();
        const c = await time(url);
        statuses.push(c.status);
        cold.push(c.ms);
        if (!ok(c.status)) break;
        const w = await time(url);
        statuses.push(w.status);
        warm.push(w.ms);
        if (!ok(w.status)) break;
      }
      const bad = statuses.find((s) => !ok(s));
      rows.push({
        url,
        cold: median(cold),
        warm: median(warm),
        statuses,
        failure: bad === undefined ? null : bad === "timeout" ? "timed out" : `answered ${bad}`,
      });
    }
    rows.sort((a, b) => b.cold - a.cold);
    return {
      rows,
      slow: rows.filter((r) => r.failure === null && r.cold >= OPENING_BUDGET_MS),
      failed: rows.filter((r) => r.failure !== null),
      notTimed,
    };
  } finally {
    await app.close();
  }
}

/** The key of the first open Needs-you item, as the shell reads the list; null when there is none. */
async function firstAttentionKey(app: ReturnType<typeof buildApp>): Promise<string | null> {
  const res = await app.inject({ url: "/api/attention?compact=1" });
  if (res.statusCode !== 200) return null;
  const items = res.json() as { key: string }[];
  return items[0]?.key ?? null;
}

/**
 * Every page's first-load routes, then each registered GET route without a path parameter, with
 * the query the web always sends where a route needs one, then `filled`: the routes with path
 * parameters, filled from `PARAM_ROUTES`.
 */
export function openingUrls(
  config: CcConfig,
  gets: readonly string[],
  filled: readonly string[] = [],
): string[] {
  const seatIds = (config.crew?.sessions ?? []).flatMap((s) => s.seats.map((x) => x.id));
  const flightId = seatIds.find((id) => id.startsWith("flight")) ?? seatIds[0] ?? "flight-1";
  const agentId = seatIds.find((id) => id.startsWith("guido")) ?? flightId;
  const ctx = { repoIds: config.repos.map((r) => r.id), seatIds, flightId, agentId };
  const repo = encodeURIComponent(ctx.repoIds[0] ?? "");
  // as apps/web/src/data.ts (flightMemory) and apps/web/src/qa/TicketQaReports.tsx ask for them
  const query: Record<string, string> = {
    "/api/flight/memory": `?repo=${repo}`,
    "/api/qa-reports": `?repoId=${repo}&prNumber=1`,
    // apps/web/src/qa/QaHistory.tsx
    "/api/qa/history": "?limit=50",
  };
  return [
    ...new Set([
      ...FIRST_LOAD_PAGES.flatMap((page) => firstLoadPaths(page, ctx)),
      "/api/telemetry?range=24h",
      "/api/telemetry?range=7d",
      "/api/metrics?range=7d",
      // the Planner's, for one repo (RESOURCES.plans); every repo's is the bare route
      `/api/plans?repoId=${repo}`,
      ...gets.map((g) => g + (query[g] ?? "")),
      ...filled,
    ]),
  ];
}

async function main(): Promise<number> {
  const source = arg("db");
  if (source === undefined) throw new Error("--db <path> is required");
  const rounds = Number(arg("rounds") ?? 5);
  const dir = mkdtempSync(join(tmpdir(), "mc-timings-"));
  const copy = join(dir, "mc.sqlite");
  try {
    const src = new DatabaseSync(source, { readOnly: true });
    try {
      await backup(src, copy);
    } finally {
      src.close();
    }
  } catch {
    copyFileSync(source, copy);
  }
  try {
    const writer = new DatabaseSync(copy);
    const configPath = arg("config");
    const config = configPath === undefined ? configFromDb(writer) : loadConfig(configPath);
    const store = new Store(copy);
    // one run row rewritten by another connection: data_version moves, as the hub's writes to its
    // runs and digests move it every second or so (a write that changes nothing does not move it)
    const touchRun = writer.prepare(
      "UPDATE runs SET summary = ? WHERE rowid = (SELECT max(rowid) FROM runs)",
    );
    let touches = 0;
    const run = await timeOpening({
      store,
      config,
      db: writer,
      ...(configPath === undefined ? {} : { configReadPath: configPath }),
      rounds,
      touch: () => touchRun.run(`timings ${++touches}`),
      ...(arg("only") === undefined ? {} : { urls: arg("only")?.split(",") }),
    });
    console.log("cold ms  warm ms  status  request");
    for (const r of run.rows)
      console.log(
        `${r.cold.toFixed(0).padStart(7)}  ${r.warm.toFixed(0).padStart(7)}  ${String(r.statuses.at(-1)).padStart(6)}  ${r.url}`,
      );
    console.log(
      `\n${run.rows.length} requests, ${run.slow.length} at ${OPENING_BUDGET_MS} ms or over (cold, median of ${rounds}), ${run.failed.length} failed`,
    );
    for (const r of run.failed) console.log(`FAILED ${r.url}: ${r.failure}`);
    for (const line of run.notTimed) console.log(`NOT TIMED ${line}`);
    store.close();
    writer.close();
    return run.failed.length > 0 || run.slow.length > 0 ? 1 : 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main();
