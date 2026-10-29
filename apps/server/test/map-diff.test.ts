import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { mapChanges } from "../src/files.ts";
import { CallRing } from "../src/map/ring.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "map-diff-"));
  dirs.push(cwd);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture");
  writeFileSync(join(cwd, "file.ts"), "one\ntwo\nthree\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  return { cwd, git };
}
it("matches base-relative git numstat across committed, staged and unstaged edits", async () => {
  const { cwd, git } = fixture();
  writeFileSync(join(cwd, "file.ts"), "changed\ntwo\nthree\n");
  git("commit", "-qam", "edit");
  writeFileSync(join(cwd, "file.ts"), "one\ntwo\nthree\nfour\n");
  git("add", "file.ts");
  writeFileSync(join(cwd, "file.ts"), "one\ntwo\nthree\nfour\nfive\n");
  const [add, rem] = git("diff", "--numstat", "origin/HEAD", "--").trim().split("\t");
  expect(await mapChanges(cwd)).toEqual([
    { file: "file.ts", add: Number(add), rem: Number(rem), source: "diff" },
  ]);
});
for (const vendor of ["claude", "codex"] as const) {
  it(`${vendor}: reflects an edit within five seconds of recording it, then detects a commit`, async () => {
    const { cwd, git } = fixture();
    const transcriptPath = join(cwd, "transcript.jsonl");
    writeFileSync(transcriptPath, "");
    const ring = new CallRing(() => [
      { id: "run", seat: "seat", repoId: "repo", cwd, transcriptPath, vendor },
    ]);
    ring.subscribe("repo", () => {}); // a connected map client keeps the one-second cadence
    const stop = ring.start();
    try {
      await expect.poll(() => ring.modified("seat"), { timeout: 4500 }).toEqual([]);
      writeFileSync(join(cwd, "file.ts"), "after\nextra\n");
      const frames = readFileSync(
        new URL(`./fixtures/map/${vendor}.jsonl`, import.meta.url),
        "utf8",
      )
        .trim()
        .split("\n");
      appendFileSync(transcriptPath, `${frames.slice(0, 2).join("\n")}\n`);
      ring.poll();
      await expect
        .poll(() => ring.modified("seat"), { timeout: 4500 })
        .toEqual([{ file: "file.ts", add: 2, rem: 3, source: "diff" }]);
      writeFileSync(join(cwd, "file.ts"), "committed\n");
      git("commit", "-qam", "next");
      await expect
        .poll(() => ring.modified("seat"), { timeout: 4500 })
        .toEqual([{ file: "file.ts", add: 1, rem: 3, source: "diff" }]);
    } finally {
      stop();
    }
  }, 15000);
}

it("keeps unavailable-base counts labelled as churn and never invents binary counts", async () => {
  const { cwd, git } = fixture();
  writeFileSync(join(cwd, "binary.bin"), Buffer.from([0, 1, 2]));
  git("add", "binary.bin");
  expect(await mapChanges(cwd)).toEqual([]);
  git("symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
  await expect(mapChanges(cwd)).rejects.toThrow();
  const transcriptPath = join(cwd, "transcript.jsonl");
  const frames = readFileSync(new URL("./fixtures/map/claude.jsonl", import.meta.url), "utf8")
    .trim()
    .split("\n");
  writeFileSync(
    transcriptPath,
    `${frames
      .slice(0, 2)
      .map((line) => JSON.stringify({ ...JSON.parse(line), timestamp: new Date().toISOString() }))
      .join("\n")}\n`,
  );
  const ring = new CallRing(() => [
    { id: "run", seat: "seat", repoId: "repo", cwd, transcriptPath },
  ]);
  ring.poll();
  expect(ring.modified("seat")).toEqual([{ file: "file.ts", add: 2, rem: 1, source: "churn" }]);
  expect(ring.modified("other")).toEqual([]);
});

it("refuses working-tree numstat when attributes name a filter", async () => {
  const { cwd } = fixture();
  writeFileSync(join(cwd, ".gitattributes"), "*.ts filter=fixture\n");
  await expect(mapChanges(cwd)).rejects.toThrow("repo uses git filters");
});

it("retains the current checkout collector with an aside run on the same seat", async () => {
  const current = fixture();
  const aside = fixture();
  const sources = [aside, current].map(({ cwd }, i) => {
    const transcriptPath = join(cwd, "transcript.jsonl");
    writeFileSync(transcriptPath, "");
    return {
      id: `run-${i}`,
      seat: "seat",
      repoId: "repo",
      cwd,
      transcriptPath,
      current: cwd === current.cwd,
    };
  });
  const ring = new CallRing(() => sources);
  ring.subscribe("repo", () => {}); // a connected map client keeps the one-second cadence
  const stop = ring.start();
  try {
    await expect.poll(() => ring.modified("seat"), { timeout: 4500 }).toEqual([]);
    writeFileSync(join(current.cwd, "file.ts"), "after\nextra\n");
    const frames = readFileSync(new URL("./fixtures/map/claude.jsonl", import.meta.url), "utf8")
      .trim()
      .split("\n");
    for (const source of sources)
      appendFileSync(
        source.transcriptPath,
        `${frames
          .slice(0, 2)
          .map((line) =>
            JSON.stringify({ ...JSON.parse(line), timestamp: new Date().toISOString() }),
          )
          .join("\n")}\n`,
      );
    ring.poll();
    await expect
      .poll(() => ring.modified("seat"), { timeout: 4500 })
      .toEqual([{ file: "file.ts", add: 2, rem: 3, source: "diff" }]);
    sources.reverse();
    ring.poll();
    expect(ring.modified("seat")).toEqual([{ file: "file.ts", add: 2, rem: 3, source: "diff" }]);
    sources.splice(0);
    ring.poll();
    expect(ring.scopes("repo")).toEqual([]);
  } finally {
    stop();
  }
}, 12000);

it("keeps reading a run's diff after it stops being current within the debounce", async () => {
  const { cwd } = fixture();
  const transcriptPath = join(cwd, "transcript.jsonl");
  writeFileSync(transcriptPath, "");
  const source = { id: "run", seat: "seat", repoId: "repo", cwd, transcriptPath, current: true };
  const ring = new CallRing(() => [source]);
  ring.poll();
  writeFileSync(join(cwd, "file.ts"), "after\nextra\n");
  const frames = readFileSync(new URL("./fixtures/map/claude.jsonl", import.meta.url), "utf8")
    .trim()
    .split("\n");
  appendFileSync(
    transcriptPath,
    `${frames
      .slice(0, 2)
      .map((line) => JSON.stringify({ ...JSON.parse(line), timestamp: new Date().toISOString() }))
      .join("\n")}\n`,
  );
  source.current = false;
  ring.poll(); // the last transcript read, inside the diff's debounce
  const stop = setInterval(() => ring.poll(), 1000);
  try {
    await expect
      .poll(() => ring.diff("run"), { timeout: 5000 })
      .toEqual([{ file: "file.ts", add: 2, rem: 3, source: "diff" }]);
  } finally {
    clearInterval(stop);
  }
}, 12000);
