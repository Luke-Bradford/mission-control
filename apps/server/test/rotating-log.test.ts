import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { rotatingLog } from "../src/rotating-log.ts";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-log-rotation-"));
  path = join(dir, "logs/server.log");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
it("rotates by bytes, keeps seven archives, and preserves complete UTF-8 records", () => {
  const log = rotatingLog(path, { bytes: 5 });
  for (let n = 0; n < 10; n++) log.write(`é${n}\n`);
  expect(readFileSync(path, "utf8")).toBe("é9\n");
  for (let n = 1; n <= 7; n++) expect(readFileSync(`${path}.${n}`, "utf8")).toBe(`é${9 - n}\n`);
  expect(readdirSync(join(dir, "logs"))).toHaveLength(8);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(`${path}.1`).mode & 0o777).toBe(0o600);
});
it("rotates on a new UTC day, including after reopening an existing log", () => {
  let at = Date.now();
  const log = rotatingLog(path, { now: () => at });
  log.write("first\n");
  at += 24 * 60 * 60 * 1000;
  rotatingLog(path, { now: () => at }).write("next\n");
  expect(readFileSync(`${path}.1`, "utf8")).toBe("first\n");
  expect(readFileSync(path, "utf8")).toBe("next\n");
});
it("keeps an oversized record whole then starts a fresh file", () => {
  const log = rotatingLog(path, { bytes: 4 });
  log.write("oversized\n");
  log.write("ok\n");
  expect(readFileSync(`${path}.1`, "utf8")).toBe("oversized\n");
  expect(readFileSync(path, "utf8")).toBe("ok\n");
});
it("tightens existing permissions and rotates an oversized file on the first new write", () => {
  writeFileSync(join(dir, "old"), "untouched");
  const log = rotatingLog(path, { bytes: 4 });
  log.write("old\n");
  chmodSync(path, 0o644);
  log.write("new\n");
  expect(statSync(`${path}.1`).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(dir, "old"), "utf8")).toBe("untouched");
});
it("falls back on an unsafe destination without following its symlink and recovers", () => {
  const target = join(dir, "other");
  writeFileSync(target, "original");
  path = join(dir, "server.log");
  symlinkSync(target, path);
  const fallback: string[] = [];
  const log = rotatingLog(path, { fallback: (line) => fallback.push(line) });
  log.write("one\n");
  log.write("two\n");
  expect(readFileSync(target, "utf8")).toBe("original");
  expect(fallback).toEqual([expect.stringContaining("unavailable"), "one\n", "two\n"]);
  rmSync(path);
  log.write("recovered\n");
  expect(readFileSync(path, "utf8")).toBe("recovered\n");
});

it("preserves the current file and falls back if rotating an archive fails", () => {
  const fallback: string[] = [];
  const log = rotatingLog(path, { bytes: 4, fallback: (line) => fallback.push(line) });
  log.write("old\n");
  mkdirSync(`${path}.7`);
  log.write("new\n");
  expect(readFileSync(path, "utf8")).toBe("old\n");
  expect(fallback).toEqual([expect.stringContaining("unavailable"), "new\n"]);
  rmSync(`${path}.7`, { recursive: true });
  log.write("end\n");
  expect(readFileSync(`${path}.1`, "utf8")).toBe("old\n");
  expect(readFileSync(path, "utf8")).toBe("end\n");
});
