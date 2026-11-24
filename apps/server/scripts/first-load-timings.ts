// Times every request a HUD page makes on opening, on a COPY of the hub database (#2219).
// The app is built in-process, as the hub builds it, with no loops, crew or engine running, so
// nothing writes to GitHub or a loop. The database given is copied first; the copy is deleted after.
// Run from the repo root:
//   node --experimental-strip-types apps/server/scripts/first-load-timings.ts --db <db> [--config <config.yaml>] [--rounds 5] [--only <url>,<url>]
// Each GET is timed "cold", right after another connection writes one run row (as the live hub
// writes every second or so, which drops every cache keyed on the store's version), and "warm",
// repeated unchanged.
// Without --config, the repos and seats come from the database.
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { FIRST_LOAD_PAGES, firstLoadPaths } from "@mc/core";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import { type CcConfig, loadConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

/** Routes that do not answer once and end: the event stream, and the live update log. */
const SKIP = new Set(["/api/stream", "/api/update/log"]);
/** A request still running after this long is reported, not waited for. */
const DEADLINE_MS = 30_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function configFromDb(db: DatabaseSync): CcConfig {
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

async function main(): Promise<void> {
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
    const app = buildApp({ config, store, bus: new ChangeBus(), noLoopWrites: true });
    const gets: string[] = [];
    app.addHook("onRoute", (r) => {
      if ([r.method].flat().includes("GET") && r.url.startsWith("/api/") && !r.url.includes(":"))
        if (!SKIP.has(r.url)) gets.push(r.url);
    });
    await app.ready();

    const seatIds = (config.crew?.sessions ?? []).flatMap((s) => s.seats.map((x) => x.id));
    const flightId = seatIds.find((id) => id.startsWith("flight")) ?? seatIds[0] ?? "flight-1";
    const agentId = seatIds.find((id) => id.startsWith("guido")) ?? flightId;
    const ctx = { repoIds: config.repos.map((r) => r.id), seatIds, flightId, agentId };
    const only = arg("only")?.split(",");
    const urls = only ?? [
      ...new Set([
        ...FIRST_LOAD_PAGES.flatMap((page) => firstLoadPaths(page, ctx)),
        "/api/telemetry?range=24h",
        "/api/telemetry?range=7d",
        "/api/metrics?range=7d",
        ...gets,
      ]),
    ];

    // one run row rewritten by another connection: data_version moves, as the hub's writes to its
    // runs and digests move it every second or so
    // (a write that changes nothing does not move it)
    const touchRun = writer.prepare(
      "UPDATE runs SET summary = ? WHERE rowid = (SELECT max(rowid) FROM runs)",
    );
    let touches = 0;
    const touch = { run: () => touchRun.run(`timings ${++touches}`) };
    const time = async (url: string): Promise<{ ms: number; status: number | string }> => {
      const started = performance.now();
      const res = await Promise.race([
        app.inject({ url }),
        new Promise<null>((r) => setTimeout(() => r(null), DEADLINE_MS).unref()),
      ]);
      return { ms: performance.now() - started, status: res === null ? "timeout" : res.statusCode };
    };

    const rows: { url: string; status: number | string; cold: number; warm: number }[] = [];
    for (const url of urls) {
      const cold: number[] = [];
      const warm: number[] = [];
      let status: number | string = 0;
      for (let i = 0; i < rounds; i++) {
        touch.run();
        const c = await time(url);
        status = c.status;
        cold.push(c.ms);
        if (c.status === "timeout") break;
        warm.push((await time(url)).ms);
      }
      rows.push({ url, status, cold: median(cold), warm: median(warm) });
    }
    rows.sort((a, b) => b.cold - a.cold);
    console.log("cold ms  warm ms  status  request");
    for (const r of rows)
      console.log(
        `${r.cold.toFixed(0).padStart(7)}  ${r.warm.toFixed(0).padStart(7)}  ${String(r.status).padStart(6)}  ${r.url}`,
      );
    const over = rows.filter((r) => r.cold >= 300);
    console.log(
      `\n${rows.length} requests, ${over.length} at 300 ms or over (cold, median of ${rounds})`,
    );
    await app.close();
    store.close();
    writer.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
