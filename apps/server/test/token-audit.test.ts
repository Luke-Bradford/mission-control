import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";
import {
  type AuditFiles,
  auditEndedRuns,
  auditTranscript,
  claudeProjectSlug,
  commandClass,
  realAuditFiles,
} from "../src/token-audit.ts";

interface Usage {
  input?: number;
  cr?: number;
  cw?: number;
  out?: number;
}
const assistant = (id: string, u: Usage, content: unknown[] = []) =>
  JSON.stringify({
    type: "assistant",
    message: {
      id,
      content,
      usage: {
        input_tokens: u.input ?? 0,
        cache_read_input_tokens: u.cr ?? 0,
        cache_creation_input_tokens: u.cw ?? 0,
        output_tokens: u.out ?? 0,
      },
    },
  });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: "tool_use",
  id,
  name,
  input,
});
const toolResult = (id: string, text: string) =>
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] },
  });
const hubLine = (text: string) => JSON.stringify({ type: "user", message: { content: text } });
const result = (out: number) =>
  JSON.stringify({ type: "result", usage: { output_tokens: out }, total_cost_usd: 1 });

const BASH_INPUT = { command: "cd /repo && pnpm -s test:related" };
const READ_INPUT = { file_path: "/repo/a.ts" };

// Three calls: the start, a Bash result, then a Read result plus a hub line.
const FIXTURE = [
  assistant("m1", { input: 10, cw: 990, out: 3 }, [toolUse("t1", "Bash", BASH_INPUT)]),
  toolResult("t1", "x".repeat(400)),
  assistant("m1", { input: 10, cw: 990, out: 40 }),
  assistant("m2", { input: 5, cr: 1000, cw: 195, out: 9 }, [toolUse("t2", "Read", READ_INPUT)]),
  toolResult("t2", "y".repeat(300)),
  hubLine("z".repeat(100)),
  assistant("m3", { input: 5, cr: 1195, cw: 300, out: 20 }),
  result(5000),
];

describe("auditTranscript", () => {
  it("takes the output total from the result events, not the streamed figure", () => {
    const { audit, calls } = auditTranscript(FIXTURE);
    expect(audit.output).toBe(5000);
    expect(calls.map((c) => c.output)).toEqual([40, 9, 20]);
    expect(auditTranscript([...FIXTURE, result(700)]).audit.output).toBe(5700);
  });

  it("gives per-call context and per-source re-read for a Bash call, a Read call and a hub line", () => {
    const { audit, calls } = auditTranscript(FIXTURE);
    expect(calls.map((c) => [c.context, c.cacheRead, c.cacheWrite])).toEqual([
      [1000, 0, 990],
      [1200, 1000, 195],
      [1500, 1195, 300],
    ]);
    expect(audit.calls).toBe(3);
    expect(audit.peakContext).toBe(1500);
    expect(audit.medianContext).toBe(1200);
    // Call 2 grew by 200: the agent's own Bash input, then the Bash result.
    const own2 = Math.floor(JSON.stringify(BASH_INPUT).length / 4);
    expect(calls[1]?.added).toEqual([
      { source: "own earlier output", command: null, tokens: own2 },
      { source: "Bash", command: "pnpm test:related", tokens: 200 - own2 },
    ]);
    // Call 3 grew by 300: the Read input, then Read (300 chars) and the hub line (100) by share.
    const own3 = Math.floor(JSON.stringify(READ_INPUT).length / 4);
    const rest = 300 - own3;
    const read = Math.floor((rest * 300) / 400);
    expect(calls[2]?.added).toEqual([
      { source: "own earlier output", command: null, tokens: own3 },
      { source: "Read", command: null, tokens: read },
      { source: "hub line", command: null, tokens: rest - read },
    ]);
    // Re-read: tokens added times the calls left in the run (this call included).
    expect(audit.bySource["start of run"]).toEqual({ added: 1000, reread: 3000, events: 1 });
    expect(audit.bySource.Bash).toEqual({ added: 200 - own2, reread: (200 - own2) * 2, events: 1 });
    expect(audit.bySource.Read).toEqual({ added: read, reread: read, events: 1 });
    expect(audit.bySource["hub line"]).toEqual({
      added: rest - read,
      reread: rest - read,
      events: 1,
    });
    expect(audit.byCommand["pnpm test:related"]?.reread).toBe((200 - own2) * 2);
  });

  it("counts a cache rewrite only when a call writes over 20,000 while reading under half the previous context", () => {
    const { audit } = auditTranscript([
      assistant("a", { cw: 100_000 }), // the first call writes everything: not a rewrite
      assistant("b", { cr: 90_000, cw: 5_000 }),
      assistant("c", { cr: 20_000, cw: 25_000 }), // reads 20k of 95k, writes 25k: a rewrite
      assistant("d", { cr: 80_000, cw: 25_000 }), // reads over half the previous 45k: no
      assistant("e", { cr: 0, cw: 15_000 }), // writes under 20k: no
    ]);
    expect(audit.rewrites).toBe(1);
    expect(audit.rewriteTokens).toBe(25_000);
  });

  it("measures the share of reading after the first report_evidence", () => {
    const { audit } = auditTranscript([
      assistant("a", { cw: 100 }),
      assistant("b", { cr: 100 }, [toolUse("r", "mcp__mc__report_evidence", {})]),
      assistant("c", { cr: 300 }),
      assistant("d", { cr: 400 }),
    ]);
    expect(audit.cacheRead).toBe(800);
    expect(audit.readAfterReport).toBe(700);
    expect(auditTranscript([assistant("a", { cw: 100 })]).audit.readAfterReport).toBeNull();
  });
});

describe("commandClass", () => {
  it("is the first word, or pnpm and its script", () => {
    expect(commandClass("cd /x && git status")).toBe("git");
    expect(commandClass("pnpm -s lint")).toBe("pnpm lint");
    expect(commandClass("pnpm run build")).toBe("pnpm build");
    expect(commandClass("")).toBe("(empty)");
  });
});

describe("auditEndedRuns", () => {
  let dir: string;
  let home: string;
  let store: Store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mc-token-audit-"));
    home = mkdtempSync(join(tmpdir(), "mc-token-home-"));
    store = new Store(join(dir, "mc.sqlite"));
    mkdirSync(join(dir, "crew"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  const NOW = Date.parse("2026-11-06T12:00:00Z");
  const run = (over: Partial<Run>): Run => ({
    id: "r1",
    agentId: "dev",
    repoId: "repo",
    seq: 1,
    startedAt: NOW - 3_600_000,
    endedAt: NOW - 1_800_000,
    status: "ok",
    sessionId: null,
    model: null,
    branch: null,
    ticket: null,
    costUsd: null,
    tokens: null,
    transcriptPath: "",
    prs: [],
    summary: null,
    ...over,
  });
  const config = (on: boolean) =>
    ({
      operator: { id: "operator", timezone: "UTC" },
      accounts: [],
      repos: [],
      loops: [],
      poll: { usageMinutes: 30, githubSeconds: 60 },
      audit: { controllerSessions: on },
      crew: {
        worktrees: dir,
        maxSeats: 1,
        sessions: [{ id: "s", repoId: "repo", checkout: "/Users/op/repo", seats: [] }],
      },
    }) as unknown as CcConfig;

  /** Real files, with every path the pass touches recorded. */
  const recording = (): { files: AuditFiles; paths: string[] } => {
    const paths: string[] = [];
    return {
      paths,
      files: {
        read: (p) => {
          paths.push(p);
          return realAuditFiles.read(p);
        },
        list: (p) => {
          paths.push(p);
          return realAuditFiles.list(p);
        },
        mtimeMs: (p) => {
          paths.push(p);
          return realAuditFiles.mtimeMs(p);
        },
      },
    };
  };

  const seedControllerSession = () => {
    const folder = join(home, ".claude", "projects", claudeProjectSlug("/Users/op/repo"));
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "sess-1.jsonl"),
      `${assistant("c1", { input: 3, cr: 10, cw: 20, out: 7 }, [{ type: "text", text: "SECRET WORDS" }])}\n`,
    );
  };

  it("stores each run's audit once, reading only the hub's own transcript folder", async () => {
    writeFileSync(join(dir, "crew", "r1.jsonl"), `${FIXTURE.join("\n")}\n`);
    store.upsertRun(run({ id: "r1", transcriptPath: join(dir, "crew", "r1.jsonl") }));
    const outside = join(home, "loop.jsonl");
    writeFileSync(outside, `${FIXTURE.join("\n")}\n`);
    store.upsertRun(run({ id: "r2", seq: 2, transcriptPath: outside }));
    seedControllerSession();
    const { files, paths } = recording();
    const r = await auditEndedRuns({ store, config: config(false), now: NOW, files, home });
    expect(r).toEqual({ audited: 1, empty: 1, controllerSessions: 0 });
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(p.startsWith(`${dir}/`)).toBe(true);
    expect(store.controllerUsageSince(0).sessions).toBe(0);
    expect(store.runTokenAudits(0).map((a) => a.run.id)).toEqual(["r1"]);
    expect(store.runTokenCalls("r1")).toHaveLength(3);
    // Parsed once: a second pass reads nothing.
    const again = recording();
    await auditEndedRuns({ store, config: config(false), now: NOW, files: again.files, home });
    expect(again.paths).toEqual([]);
  });

  it("with the controller switch on, stores usage numbers and no text", async () => {
    seedControllerSession();
    const { files, paths } = recording();
    // The session file was just written: run the pass two hours on, when the session is finished.
    const later = Date.now() + 2 * 3_600_000;
    const r = await auditEndedRuns({ store, config: config(true), now: later, files, home });
    expect(r.controllerSessions).toBe(1);
    expect(paths.some((p) => p.startsWith(home))).toBe(true);
    expect(store.controllerUsageSince(0)).toEqual({
      sessions: 1,
      calls: 1,
      input: 3,
      cacheRead: 10,
      cacheWrite: 20,
      output: 7,
    });
    expect(JSON.stringify(store.controllerUsageSince(0))).not.toContain("SECRET");
  });
});
