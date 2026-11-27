import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  cleanupCrewLeftovers,
  crewLeftoverFootprint,
  crewProjectName,
} from "../src/repo/crew-leftovers.ts";
import { closeFinishedPreviews } from "../src/repo/leftovers.ts";

const HOUR = 60 * 60_000;
const NOW = Date.parse("2026-11-26T12:00:00Z");
let root = "";

const old = (path: string, hours: number) => {
  const at = new Date(NOW - hours * HOUR);
  utimesSync(path, at, at);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mc-crew-leftovers-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("retains live crew transcripts but compresses and deletes ended crew and browser leftovers", async () => {
  const worktrees = join(root, "worktrees");
  const projects = join(root, "claude", "projects");
  const codex = join(root, "codex", "sessions");
  const tmp = join(root, "tmp");
  const ended = join(projects, crewProjectName(join(worktrees, "mc", "old")));
  const live = join(projects, crewProjectName(join(worktrees, "mc", "live")));
  const operator = join(projects, crewProjectName(join(root, "operator-project")));
  const profile = join(tmp, "playwright_chromiumdev_profile-old");
  const chrome = join(tmp, "com.google.Chrome.old");
  const busy = join(tmp, "playwright_chromiumdev_profile-busy");
  for (const dir of [ended, live, operator, profile, chrome, busy])
    mkdirSync(dir, { recursive: true });
  writeFileSync(join(ended, "recent.jsonl"), JSON.stringify({ cwd: join(worktrees, "mc", "old") }));
  writeFileSync(
    join(ended, "expired.jsonl"),
    JSON.stringify({ cwd: join(worktrees, "mc", "old") }),
  );
  writeFileSync(join(live, "live.jsonl"), JSON.stringify({ cwd: join(worktrees, "mc", "live") }));
  writeFileSync(
    join(operator, "operator.jsonl"),
    JSON.stringify({ cwd: join(root, "operator-project") }),
  );
  const codexOld = join(codex, "old.jsonl");
  const codexLive = join(codex, "live.jsonl");
  mkdirSync(codex, { recursive: true });
  writeFileSync(codexOld, JSON.stringify({ cwd: join(worktrees, "mc", "old") }));
  writeFileSync(codexLive, JSON.stringify({ cwd: join(worktrees, "mc", "live") }));
  writeFileSync(join(profile, "cache"), "profile");
  writeFileSync(join(chrome, "cache"), "chrome");
  writeFileSync(join(busy, "cache"), "busy");
  old(join(ended, "recent.jsonl"), 25);
  old(join(ended, "expired.jsonl"), 15 * 24);
  old(codexOld, 15 * 24);
  old(codexLive, 15 * 24);
  old(profile, 7);
  old(chrome, 7);
  old(busy, 7);

  const result = await cleanupCrewLeftovers({
    now: NOW,
    worktrees,
    claudeProjects: projects,
    codexSessions: codex,
    tmp,
    liveWorktrees: new Set([join(worktrees, "mc", "live")]),
    processLines: [`123 chromium --user-data-dir=${busy}`],
  });

  expect(result).toEqual({ gzipped: 1, deleted: 2, browserRemoved: 2, skippedLive: 3 });
  expect(existsSync(join(ended, "recent.jsonl"))).toBe(false);
  expect(existsSync(join(ended, "recent.jsonl.gz"))).toBe(true);
  expect(existsSync(join(ended, "expired.jsonl"))).toBe(false);
  expect(existsSync(codexOld)).toBe(false);
  expect(existsSync(codexLive)).toBe(true);
  expect(existsSync(join(live, "live.jsonl"))).toBe(true);
  expect(existsSync(join(operator, "operator.jsonl"))).toBe(true);
  expect(existsSync(profile)).toBe(false);
  expect(existsSync(chrome)).toBe(false);
  expect(existsSync(busy)).toBe(true);
});

it("leaves Claude folders whose hyphenated name collides with the crew root", async () => {
  const worktrees = join(root, "worktrees");
  const projects = join(root, "claude", "projects");
  const operatorWorktree = join(root, "worktrees-operator", "notes");
  const collision = join(projects, crewProjectName(operatorWorktree));
  mkdirSync(collision, { recursive: true });
  const transcript = join(collision, "operator.jsonl");
  writeFileSync(transcript, JSON.stringify({ cwd: operatorWorktree }));
  old(transcript, 15 * 24);

  await cleanupCrewLeftovers({
    now: NOW,
    worktrees,
    claudeProjects: projects,
    tmp: join(root, "tmp"),
    liveWorktrees: new Set(),
    processLines: [],
  });

  expect(existsSync(transcript)).toBe(true);
});

it("leaves browser leftovers with an open file, even when its process argv has no path", async () => {
  const tmp = join(root, "tmp");
  const profile = join(tmp, "playwright_chromiumdev_profile-open");
  const chrome = join(tmp, "com.google.Chrome.open");
  const profileFile = join(profile, "cache");
  const chromeFile = join(chrome, "cache");
  for (const dir of [profile, chrome]) mkdirSync(dir, { recursive: true });
  writeFileSync(profileFile, "profile");
  writeFileSync(chromeFile, "chrome");
  old(profile, 7);
  old(chrome, 7);
  const child = spawn(
    process.execPath,
    [
      "-e",
      "const fs=require('node:fs');for(const path of JSON.parse(process.env.HELD_FILES))fs.openSync(path,'r');process.stdout.write('ready');setInterval(()=>{},1e3)",
    ],
    { env: { ...process.env, HELD_FILES: JSON.stringify([profileFile, chromeFile]) } },
  );
  try {
    if (child.stdout === null) throw new Error("The file-holder did not expose stdout.");
    await once(child.stdout, "data");
    const result = await cleanupCrewLeftovers({
      now: NOW,
      worktrees: join(root, "worktrees"),
      claudeProjects: join(root, "claude", "projects"),
      tmp,
      liveWorktrees: new Set(),
      processLines: [],
    });

    expect(result).toEqual({ gzipped: 0, deleted: 0, browserRemoved: 0, skippedLive: 2 });
    expect(existsSync(profile)).toBe(true);
    expect(existsSync(chrome)).toBe(true);
  } finally {
    child.kill();
  }
});

it("retries compression after an interrupted pass leaves its temporary gzip", async () => {
  const worktrees = join(root, "worktrees");
  const projects = join(root, "claude", "projects");
  const crew = join(projects, crewProjectName(join(worktrees, "mc", "seat")));
  const transcript = join(crew, "session.jsonl");
  mkdirSync(crew, { recursive: true });
  writeFileSync(transcript, JSON.stringify({ cwd: join(worktrees, "mc", "seat") }));
  writeFileSync(`${transcript}.gz.tmp`, "partial gzip");
  old(transcript, 25);

  const result = await cleanupCrewLeftovers({
    now: NOW,
    worktrees,
    claudeProjects: projects,
    tmp: join(root, "tmp"),
    liveWorktrees: new Set(),
    processLines: [],
  });

  expect(result).toEqual({ gzipped: 1, deleted: 0, browserRemoved: 0, skippedLive: 0 });
  expect(existsSync(transcript)).toBe(false);
  expect(existsSync(`${transcript}.gz`)).toBe(true);
  expect(existsSync(`${transcript}.gz.tmp`)).toBe(false);
});

it("finds a crew gzip transcript from its bounded prefix", async () => {
  const worktrees = join(root, "worktrees");
  const projects = join(root, "claude", "projects");
  const crew = join(projects, crewProjectName(join(worktrees, "mc", "seat")));
  mkdirSync(crew, { recursive: true });
  const transcript = join(crew, "large.jsonl.gz");
  writeFileSync(
    transcript,
    gzipSync(
      Buffer.concat([
        Buffer.from(JSON.stringify({ cwd: join(worktrees, "mc", "seat") })),
        Buffer.alloc(2 ** 20),
      ]),
    ),
  );

  await cleanupCrewLeftovers({
    now: NOW,
    worktrees,
    claudeProjects: projects,
    tmp: join(root, "tmp"),
    liveWorktrees: new Set([join(worktrees, "mc", "seat")]),
    processLines: [],
  });

  expect(existsSync(transcript)).toBe(true);
});

it("closes every gzip transcript it reads the prefix of (#2292)", async () => {
  const worktrees = join(root, "worktrees");
  const projects = join(root, "claude", "projects");
  const crew = join(projects, crewProjectName(join(worktrees, "mc", "seat")));
  mkdirSync(crew, { recursive: true });
  // compressed bigger than one read and longer than the prefix the pass reads, so it stops before
  // the file's end: the path that leaked a descriptor
  const body = gzipSync(
    Buffer.concat([
      Buffer.from(JSON.stringify({ cwd: join(worktrees, "mc", "seat") })),
      randomBytes(2 ** 20),
    ]),
  );
  for (let i = 0; i < 40; i++) writeFileSync(join(crew, `s${i}.jsonl.gz`), body);
  const openFds = () => readdirSync("/dev/fd").length;
  const input = {
    now: NOW,
    worktrees,
    claudeProjects: projects,
    tmp: join(root, "tmp"),
    // not live: a live seat's folder is skipped before any transcript is read
    liveWorktrees: new Set<string>(),
    processLines: [],
  };
  await cleanupCrewLeftovers(input);
  await new Promise((r) => setTimeout(r, 50));
  const before = openFds();
  for (let pass = 0; pass < 2; pass++) await cleanupCrewLeftovers(input);
  await new Promise((r) => setTimeout(r, 50));

  // a leak keeps one descriptor per transcript per pass: 80 here
  expect(openFds() - before).toBeLessThan(5);
}, 120_000);

it("closes finished previews but leaves an open preview running", async () => {
  const closed: number[] = [];
  const previews = {
    list: () => [{ pr: 1 }, { pr: 2 }, { pr: 3 }, { pr: 4 }],
    close: async (pr: number) => {
      closed.push(pr);
      return true;
    },
  };
  const state = new Map([
    [1, "merged"],
    [2, "closed"],
    [3, "open"],
    [4, "open"],
  ]);
  const count = await closeFinishedPreviews({
    previews,
    config: { hubRepo: "mission-control" },
    store: {
      pullRequest: (_repo: string, pr: number) => {
        const value = state.get(pr);
        return value === undefined
          ? null
          : ({ state: value, ...(pr === 4 ? { ticket: "mission-control#44" } : {}) } as never);
      },
      board: () => [{ issueNumber: 44, closed: true }] as never,
    },
  });

  expect(count).toBe(3);
  expect(closed).toEqual([1, 2, 4]);
});

it("reports only the configured crew stores", async () => {
  const worktrees = join(root, "worktrees");
  const projects = join(root, "claude", "projects");
  const codex = join(root, "codex", "sessions");
  const tmp = join(root, "tmp");
  const previews = join(root, "previews");
  const crew = join(projects, crewProjectName(join(worktrees, "mc", "seat")));
  const operator = join(projects, crewProjectName(join(root, "operator")));
  mkdirSync(crew, { recursive: true });
  mkdirSync(operator, { recursive: true });
  mkdirSync(join(tmp, "playwright_chromiumdev_profile-seat"), { recursive: true });
  mkdirSync(join(tmp, "com.google.Chrome.seat"), { recursive: true });
  mkdirSync(join(worktrees, "mc", "seat"), { recursive: true });
  mkdirSync(join(previews, "42"), { recursive: true });
  writeFileSync(
    join(crew, "transcript.jsonl"),
    JSON.stringify({ cwd: join(worktrees, "mc", "seat") }),
  );
  writeFileSync(
    join(operator, "transcript.jsonl"),
    JSON.stringify({ cwd: join(root, "operator") }),
  );
  writeFileSync(join(tmp, "playwright_chromiumdev_profile-seat", "cache"), Buffer.alloc(17));
  writeFileSync(join(tmp, "com.google.Chrome.seat", "cache"), Buffer.alloc(19));
  writeFileSync(join(worktrees, "mc", "seat", "work"), Buffer.alloc(29));
  writeFileSync(join(previews, "42", "preview"), Buffer.alloc(31));
  mkdirSync(codex, { recursive: true });
  writeFileSync(
    join(codex, "crew.jsonl"),
    `${JSON.stringify({ cwd: join(worktrees, "mc", "seat") })}\n${"x".repeat(23)}`,
  );

  expect(
    await crewLeftoverFootprint({
      worktrees,
      claudeProjects: projects,
      codexSessions: codex,
      tmp,
      previews,
    }),
  ).toEqual({
    claudeProjectsBytes: JSON.stringify({ cwd: join(worktrees, "mc", "seat") }).length,
    codexSessionsBytes: 23 + JSON.stringify({ cwd: join(worktrees, "mc", "seat") }).length + 1,
    browserProfilesBytes: 17,
    chromeTempBytes: 19,
    worktreesBytes: 29,
    previewsBytes: 31,
  });
});
