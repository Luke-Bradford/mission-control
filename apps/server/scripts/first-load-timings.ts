// Times every request a HUD page makes on opening, on a COPY of the hub database (#2219).
// The app is built in-process, as the hub builds it, with no loops, crew or engine running, so
// nothing writes to GitHub or a loop. The database given is copied first; the copy is deleted after.
// Run from the repo root:
//   node --experimental-strip-types apps/server/scripts/first-load-timings.ts --db <db> [--config <config.yaml>] [--rounds 5] [--only <url>,<url>]
// Each GET is timed "cold", right after another connection writes one run row (as the live hub
// writes every second or so, which drops every cache keyed on the store's version), and "warm",
// repeated unchanged. Every sample must answer 2xx: a request that errs or times out is listed as
// failed and the run exits 1, so a missing route can never pass as a fast one.
// Without --config, the repos and seats come from the database.
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { FIRST_LOAD_PAGES, firstLoadPaths } from "@mc/core";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import { type CcConfig, loadConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

/** Routes that do not answer once and end: the event stream, and the live update log. */
const SKIP = new Set(["/api/stream", "/api/update/log"]);
/** Routes that read config.yaml itself: timed only when --config names one. */
const CONFIG_FILE_ROUTES = new Set(["/api/config/settings"]);
/** A request still running after this long is reported, not waited for. */
const DEADLINE_MS = 30_000;
/** The budget each request is held to, right after a write. */
export const OPENING_BUDGET_MS = 300;

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
  // the /api routes are registered in a plugin that runs on ready(), after this hook is added
  app.addHook("onRoute", (r) => {
    if ([r.method].flat().includes("GET") && r.url.startsWith("/api/") && !r.url.includes(":"))
      if (!SKIP.has(r.url)) gets.push(r.url);
  });
  await app.ready();
  try {
    const notTimed =
      o.urls !== undefined || o.configReadPath !== undefined
        ? []
        : gets
            .filter((g) => CONFIG_FILE_ROUTES.has(g))
            .map((g) => `${g}: reads config.yaml; pass --config`);
    const urls =
      o.urls ??
      openingUrls(
        o.config,
        o.configReadPath === undefined ? gets.filter((g) => !CONFIG_FILE_ROUTES.has(g)) : gets,
      );
    const time = async (url: string): Promise<{ ms: number; status: number | "timeout" }> => {
      const started = performance.now();
      const res = await Promise.race([
        app.inject({ url }),
        new Promise<null>((r) => setTimeout(() => r(null), DEADLINE_MS).unref()),
      ]);
      return { ms: performance.now() - started, status: res === null ? "timeout" : res.statusCode };
    };
    const ok = (s: number | "timeout") => s !== "timeout" && s >= 200 && s < 300;
    const rows: Timing[] = [];
    for (const url of urls) {
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

/**
 * Every page's first-load routes, then each registered GET route without a path parameter, with
 * the query the web always sends where a route needs one.
 */
export function openingUrls(config: CcConfig, gets: readonly string[]): string[] {
  const seatIds = (config.crew?.sessions ?? []).flatMap((s) => s.seats.map((x) => x.id));
  const flightId = seatIds.find((id) => id.startsWith("flight")) ?? seatIds[0] ?? "flight-1";
  const agentId = seatIds.find((id) => id.startsWith("guido")) ?? flightId;
  const ctx = { repoIds: config.repos.map((r) => r.id), seatIds, flightId, agentId };
  const repo = encodeURIComponent(ctx.repoIds[0] ?? "");
  // as apps/web/src/data.ts (flightMemory) and apps/web/src/qa/TicketQaReports.tsx ask for them
  const query: Record<string, string> = {
    "/api/flight/memory": `?repo=${repo}`,
    "/api/qa-reports": `?repoId=${repo}&prNumber=1`,
  };
  return [
    ...new Set([
      ...FIRST_LOAD_PAGES.flatMap((page) => firstLoadPaths(page, ctx)),
      "/api/telemetry?range=24h",
      "/api/telemetry?range=7d",
      "/api/metrics?range=7d",
      ...gets.map((g) => g + (query[g] ?? "")),
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
