import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Run } from "@mc/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { TRANSCRIPT_RETENTION_DEFAULTS } from "../src/config.ts";
import { crewTranscriptPath, Store } from "../src/store.ts";
import { maintainTranscripts } from "../src/transcript-lifecycle.ts";

const HOUR = 60 * 60_000;
const NOW = Date.parse("2026-10-30T12:00:00Z");
let dir = "";
let store: Store;
const run = (id: string, endedAt: number): Run => ({
  id,
  agentId: "guido-1",
  repoId: "mc",
  seq: 1,
  startedAt: endedAt - HOUR,
  endedAt,
  status: "ok",
  sessionId: null,
  model: null,
  branch: null,
  ticket: null,
  costUsd: null,
  tokens: null,
  transcriptPath: crewTranscriptPath(store.path, id),
  prs: [],
  summary: null,
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-transcript-life-"));
  store = new Store(join(dir, "mc.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it("gzips an ended transcript after 24 hours and deletes it after 14 days", async () => {
  const recent = run("recent", NOW - 25 * HOUR);
  const old = run("old", NOW - 15 * 24 * HOUR);
  const recentEndedAt = NOW - 25 * HOUR;
  const oldEndedAt = NOW - 15 * 24 * HOUR;
  store.upsertRun(recent);
  store.upsertRun(old);
  writeFileSync(recent.transcriptPath, "hello\n");
  writeFileSync(old.transcriptPath, "old\n");
  utimesSync(recent.transcriptPath, new Date(recentEndedAt), new Date(recentEndedAt));
  utimesSync(old.transcriptPath, new Date(oldEndedAt), new Date(oldEndedAt));
  const result = await maintainTranscripts({
    store,
    now: NOW,
    retention: TRANSCRIPT_RETENTION_DEFAULTS,
  });
  expect(result).toMatchObject({ gzipped: 1, deleted: 1 });
  expect(existsSync(recent.transcriptPath)).toBe(false);
  expect(gunzipSync(readFileSync(`${recent.transcriptPath}.gz`)).toString()).toBe("hello\n");
  expect(existsSync(old.transcriptPath)).toBe(false);
});

it("never touches a live transcript", async () => {
  const live = run("live", NOW - 20 * 24 * HOUR);
  live.endedAt = null;
  live.status = "running";
  store.upsertRun(live);
  mkdirSync(join(dir, "crew"), { recursive: true });
  writeFileSync(live.transcriptPath, "live\n");
  const result = await maintainTranscripts({
    store,
    now: NOW,
    retention: TRANSCRIPT_RETENTION_DEFAULTS,
  });
  expect(result.skippedLive).toBe(1);
  expect(readFileSync(live.transcriptPath, "utf8")).toBe("live\n");
});

it("replaces an interrupted gzip temp file", async () => {
  const endedAt = NOW - 25 * HOUR;
  const ended = run("interrupted", endedAt);
  store.upsertRun(ended);
  writeFileSync(ended.transcriptPath, "done\n");
  utimesSync(ended.transcriptPath, new Date(endedAt), new Date(endedAt));
  writeFileSync(`${ended.transcriptPath}.gz.tmp`, "partial");
  const result = await maintainTranscripts({
    store,
    now: NOW,
    retention: TRANSCRIPT_RETENTION_DEFAULTS,
  });
  expect(result.gzipped).toBe(1);
  expect(existsSync(`${ended.transcriptPath}.gz.tmp`)).toBe(false);
  expect(gunzipSync(readFileSync(`${ended.transcriptPath}.gz`)).toString()).toBe("done\n");
});

it("honours configured ages and ignores unknown, outside, and symlinked files", async () => {
  const gzip = run("gzip", NOW - 2 * HOUR);
  const deleteRun = run("delete", NOW - 2 * 24 * HOUR);
  const gzipEndedAt = NOW - 2 * HOUR;
  const deleteEndedAt = NOW - 2 * 24 * HOUR;
  const outside = run("outside", NOW - 2 * 24 * HOUR);
  outside.transcriptPath = join(dir, "outside.jsonl");
  store.upsertRun(gzip);
  store.upsertRun(deleteRun);
  store.upsertRun(outside);
  writeFileSync(gzip.transcriptPath, "gzip\n");
  writeFileSync(deleteRun.transcriptPath, "delete\n");
  utimesSync(gzip.transcriptPath, new Date(gzipEndedAt), new Date(gzipEndedAt));
  utimesSync(deleteRun.transcriptPath, new Date(deleteEndedAt), new Date(deleteEndedAt));
  writeFileSync(outside.transcriptPath, "outside\n");
  writeFileSync(join(dir, "crew", "unknown.jsonl"), "unknown\n");
  symlinkSync(outside.transcriptPath, join(dir, "crew", "link.jsonl"));
  const result = await maintainTranscripts({
    store,
    now: NOW,
    retention: { gzipAfterHours: 1, deleteAfterDays: 1 },
  });
  expect(result).toMatchObject({ gzipped: 1, deleted: 1 });
  expect(existsSync(`${gzip.transcriptPath}.gz`)).toBe(true);
  expect(existsSync(deleteRun.transcriptPath)).toBe(false);
  expect(readFileSync(outside.transcriptPath, "utf8")).toBe("outside\n");
  expect(existsSync(join(dir, "crew", "unknown.jsonl"))).toBe(true);
  expect(existsSync(join(dir, "crew", "link.jsonl"))).toBe(true);
});
