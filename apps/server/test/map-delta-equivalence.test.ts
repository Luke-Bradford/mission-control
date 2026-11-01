import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CrewRow,
  type MapDelta,
  type MapSnapshot,
  mapSnapshotFixture,
  type Run,
} from "@mc/core";
import { expect, it } from "vitest";
import { applyDelta } from "../../web/src/map/deltas.ts";
import { CallRing } from "../src/map/ring.ts";
import { mapSeats } from "../src/map/seats.ts";
import { Store } from "../src/store.ts";

it("matches authoritative seats across successful reads, concurrent ends, an aside and pending/failed writes", () => {
  const cwd = mkdtempSync(join(tmpdir(), "map-equivalence-"));
  const store = new Store(":memory:");
  const path = join(cwd, "current.jsonl"),
    aside = join(cwd, "aside.jsonl");
  writeFileSync(path, "");
  writeFileSync(aside, "");
  writeFileSync(join(cwd, "file.ts"), "file\n");
  const at = Date.now() - 1000;
  const run: Run = {
    id: "run",
    agentId: "seat",
    repoId: "repo",
    seq: 1,
    startedAt: at - 1000,
    endedAt: null,
    status: "running",
    sessionId: null,
    model: null,
    branch: "feature/7",
    ticket: "repo#7",
    costUsd: null,
    tokens: null,
    transcriptPath: path,
    prs: [],
    summary: null,
  };
  store.upsertRun(run);
  store.setSeatSession({
    seatId: "seat",
    runId: run.id,
    cliSessionId: null,
    vendor: "claude",
    state: "running",
    reason: null,
    worktree: cwd,
    updatedAt: at,
  });
  const row = {
    id: "seat",
    kind: "crew",
    role: "GUIDO",
    area: [],
    repoId: "repo",
    hudState: "running",
    stateSince: at,
    ticket: run.ticket,
    ticketTitle: null,
    run: { id: run.id },
    loop: null,
  } as unknown as CrewRow;
  const ring = new CallRing(() => [
    {
      id: run.id,
      seat: "seat",
      repoId: "repo",
      cwd,
      transcriptPath: path,
      vendor: "claude",
      current: true,
    },
    {
      id: "aside",
      seat: "seat",
      repoId: "repo",
      cwd,
      transcriptPath: aside,
      vendor: "claude",
      current: false,
    },
  ]);
  const frames: MapDelta[] = [];
  ring.subscribe("repo", (d) => frames.push(d));
  const snapshot = (): MapSnapshot => ({
    ...structuredClone(mapSnapshotFixture),
    repoId: "repo",
    ...mapSeats([row], store, ring, { holder: null, waiting: [] }, Date.now()),
    seq: ring.sequence("repo"),
  });
  let current = snapshot();
  let refetches = 0;
  const poll = () => {
    ring.poll();
    for (const frame of frames) {
      if (frame.seq <= current.seq) continue;
      const next = applyDelta(current, frame, Date.now());
      if (next) current = next;
      else {
        refetches++;
        current = snapshot();
      }
    }
    expect(current.seats).toEqual(snapshot().seats);
  };
  const start = (id: string, name: string, input: unknown, time: number, file = path) =>
    appendFileSync(
      file,
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] }, timestamp: new Date(time).toISOString() })}\n`,
    );
  const end = (id: string, time: number, file = path, error = false) =>
    appendFileSync(
      file,
      `${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: error ? "failed" : "ok", is_error: error }] }, timestamp: new Date(time).toISOString() })}\n`,
    );
  try {
    start("read", "Read", { file_path: "file.ts" }, at);
    poll();
    expect(current.seats[0]?.scope.read).toEqual([]);
    end("read", at + 1);
    poll();
    expect(current.seats[0]?.scope.read).toEqual(["file.ts"]);
    expect(refetches).toBe(0);
    start("first", "Bash", { command: "pwd" }, at + 2);
    start("second", "Bash", { command: "ls" }, at + 3);
    poll();
    end("second", at + 4);
    poll();
    expect(current.seats[0]?.calls.map((c) => c.detail)).toEqual(["pwd"]);
    start("first", "Read", { file_path: "file.ts" }, at + 5, aside);
    poll();
    end("first", at + 6, aside);
    poll();
    expect(current.seats[0]?.calls.map((c) => c.detail)).toEqual(["pwd"]);
    end("first", at + 7);
    poll();
    start("write", "Write", { file_path: "new.ts", content: "new\n" }, at + 8);
    poll();
    expect(current.seats[0]?.scope.modified).toEqual([]);
    writeFileSync(join(cwd, "new.ts"), "new\n");
    end("write", at + 9);
    poll();
    expect(current.seats[0]?.scope.modified).toContainEqual({
      file: "new.ts",
      add: 1,
      rem: 0,
      source: "churn",
    });
    start("failed", "Write", { file_path: "failed.ts", content: "failed\n" }, at + 10);
    poll();
    end("failed", at + 11, path, true);
    poll();
    expect(current.seats[0]?.scope.modified.some((c) => c.file === "failed.ts")).toBe(false);
    start("stale", "Bash", { command: "old".repeat(500) }, at + 12);
    poll();
    writeFileSync(path, "");
    poll();
    expect(current.seats[0]?.calls).toEqual([]);
    start("long-stale", "Bash", { command: "old".repeat(500) }, at + 13);
    poll();
    writeFileSync(path, "");
    start("fresh", "Read", { file_path: "file.ts" }, at + 14);
    poll();
    expect(current.seats[0]?.calls.map((call) => call.id)).toEqual([
      JSON.stringify(["run", "fresh"]),
    ]);
    expect(refetches).toBeGreaterThan(0);
  } finally {
    store.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
