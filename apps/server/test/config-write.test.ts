import "./temp-home.ts";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_SEAT_COMMANDS, type NewRepo, type SeatInput } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, seatInput } from "../src/config.ts";
import {
  addAccount,
  addRepo,
  CONFIG_BACKUPS_KEEP,
  ConfigWriteError,
  NewAccountBody,
  NewRepoBody,
  noSessionText,
  RepoLocation,
  SEATS_CHANGED,
  SeatsBody,
  setSessionSeats,
} from "../src/config-write.ts";

// Lets a test make the final rename fail (the disk or directory refusing the swap mid-write), or
// any chmod fail (a backup created 0600 never needs one).
const fault = vi.hoisted(() => ({
  rename: null as NodeJS.ErrnoException | null,
  chmod: null as NodeJS.ErrnoException | null,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    rename: async (from: string, to: string) => {
      if (fault.rename) throw fault.rename;
      return real.rename(from, to);
    },
    chmod: async (p: string, mode: number) => {
      if (fault.chmod) throw fault.chmod;
      return real.chmod(p, mode);
    },
  };
});

const EXAMPLE = resolve(import.meta.dirname, "../../../config.example.yaml");
const NOW = Date.parse("2026-10-19T12:00:00Z");

let dir: string;
let path: string;

const COMMENTED =
  "# Mission Control config — hand-written\n" +
  readFileSync(EXAMPLE, "utf8")
    .replace("repos:\n", "repos:\n  # shop-app first: the TA loop's repo\n")
    .replace("\ncrew:\n", `\ncrew:\n  node: ${process.execPath}\n`);

const repo = (over: Partial<NewRepo> = {}): NewRepo => ({
  id: "studio",
  github: "octo-org/studio",
  project: 4,
  statusMap: { Todo: "planned", "In Progress": "in progress", Done: "done" },
  ...over,
});

const files = () => readdirSync(dir).sort();
const backups = () => files().filter((f) => f.startsWith("config.yaml.bak-"));

async function writeError(p: Promise<unknown>): Promise<ConfigWriteError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigWriteError);
    return e as ConfigWriteError;
  }
  throw new Error("expected ConfigWriteError");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-config-write-"));
  path = join(dir, "config.yaml");
  writeFileSync(path, COMMENTED, { mode: 0o600 });
  fault.rename = null;
  fault.chmod = null;
});

afterEach(() => {
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

describe("addRepo", () => {
  it("appends the repo, keeps comments and key order, and the file loads with it", async () => {
    const before = loadConfig(path);
    const { config, backup } = await addRepo(path, repo({ needsYouLabels: ["needs-design"] }), NOW);
    const text = readFileSync(path, "utf8");
    expect(text.startsWith("# Mission Control config — hand-written\n")).toBe(true);
    expect(text).toContain("  # shop-app first: the TA loop's repo\n");
    expect(text).toContain('  # The operator\'s id (default "operator").\n');
    // the old text is untouched up to the end of the repos list, the new entry follows it
    const head = COMMENTED.slice(0, COMMENTED.indexOf("\nloops:"));
    expect(text.startsWith(head)).toBe(true);
    expect(text.indexOf("id: studio")).toBeGreaterThan(text.indexOf("id: site-builder"));
    expect(text.indexOf("id: studio")).toBeLessThan(text.indexOf("\nloops:"));
    expect(text).toContain("needs_you_labels:");
    const loaded = loadConfig(path);
    expect(loaded).toEqual(config);
    expect(loaded).toEqual({
      ...before,
      repos: [
        ...before.repos,
        {
          id: "studio",
          github: "octo-org/studio",
          project: 4,
          statusMap: { Todo: "planned", "In Progress": "in progress", Done: "done" },
          needsYouLabels: ["needs-design"],
          fullSuite: [],
          requiredChecks: [],
          commands: DEFAULT_SEAT_COMMANDS,
          protectedFiles: [],
          autonomy: "draft",
        },
      ],
    });
    expect(config.repos.at(-1)?.commands).toEqual(DEFAULT_SEAT_COMMANDS);
    expect(config.repos.at(-1)?.protectedFiles).toEqual([]);
    expect(backup).toBe(join(dir, "config.yaml.bak-20261019T120000Z"));
    expect(readFileSync(backup, "utf8")).toBe(COMMENTED);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    expect(files()).toEqual(["config.yaml", "config.yaml.bak-20261019T120000Z"]);
  });

  it("writes 0600 even when the old file was group-readable", async () => {
    chmodSync(path, 0o644);
    const { backup } = await addRepo(path, repo(), NOW);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
  });

  it("creates the backup 0600 from a 0644 file, with no chmod after it", async () => {
    chmodSync(path, 0o644);
    fault.chmod = Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    const { backup } = await addRepo(path, repo(), NOW);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    expect(readFileSync(backup, "utf8")).toBe(COMMENTED);
  });

  it("refuses a config.yaml that is a symbolic link: nothing written, no backup", async () => {
    const target = join(dir, "real.yaml");
    writeFileSync(target, COMMENTED, { mode: 0o600 });
    rmSync(path);
    symlinkSync(target, path);
    const e = await writeError(addRepo(path, repo(), NOW));
    expect(e.kind).toBe("current");
    expect(e.message).toBe("config.yaml is a symbolic link");
    expect(readFileSync(target, "utf8")).toBe(COMMENTED);
    expect(files()).toEqual(["config.yaml", "real.yaml"]);
  });

  it("keeps an existing plain scalar longer than 80 columns on one line", async () => {
    const label =
      "waiting on a decision from the operator before the next fire can pick this ticket up again";
    expect(label.length).toBeGreaterThan(80);
    const long = COMMENTED.replace(
      "      Done: done\n  - id: site-builder",
      `      Done: done\n    needs_you_labels:\n      - ${label}\n  - id: site-builder`,
    );
    expect(long).not.toBe(COMMENTED);
    writeFileSync(path, long);
    await addRepo(path, repo(), NOW);
    const text = readFileSync(path, "utf8");
    expect(text).toContain(`      - ${label}\n`);
    expect(text.startsWith(long.slice(0, long.indexOf("\nloops:")))).toBe(true);
  });

  it("writes a status-map key YAML would otherwise misread exactly as given", async () => {
    const statusMap = {
      "a: b": "done",
      "#hash": "planned",
      yes: "review",
      "1": "blocked",
      " padded ": "in progress",
    } as const;
    const { config } = await addRepo(path, repo({ statusMap }), NOW);
    expect(config.repos.at(-1)?.statusMap).toEqual(statusMap);
    expect(loadConfig(path).repos.at(-1)?.statusMap).toEqual(statusMap);
  });

  it("creates the list when repos is empty", async () => {
    writeFileSync(
      path,
      readFileSync(EXAMPLE, "utf8")
        .replace(/\ncrew:[\s\S]*$/, "") // its sessions name repos
        .replace(
          /repos:\n[\s\S]*?\nloops:\n[\s\S]*?\npoll:/,
          "repos: [] # none yet\n\nloops: []\n\npoll:",
        ),
    );
    expect(loadConfig(path).repos).toEqual([]);
    const { config } = await addRepo(path, repo(), NOW);
    expect(config.repos.map((r) => r.id)).toEqual(["studio"]);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("repos:\n  - id: studio\n");
    expect(loadConfig(path)).toEqual(config);
  });

  it("refuses a duplicate id: nothing written, no backup", async () => {
    const e = await writeError(addRepo(path, repo({ id: "shop-app" }), NOW));
    expect(e.kind).toBe("duplicate");
    expect(readFileSync(path, "utf8")).toBe(COMMENTED);
    expect(files()).toEqual(["config.yaml"]);
  });

  it("refuses the same github (any case) with the same project, allows another project", async () => {
    const e = await writeError(
      addRepo(path, repo({ github: "OCTO-ORG/SHOP-APP", project: 2 }), NOW),
    );
    expect(e.kind).toBe("duplicate");
    expect(files()).toEqual(["config.yaml"]);
    await addRepo(path, repo({ id: "shop-app-2", github: "octo-org/shop-app", project: 9 }), NOW);
    expect(loadConfig(path).repos.map((r) => r.id)).toEqual([
      "shop-app",
      "site-builder",
      "mission-control",
      "shop-app-2",
    ]);
  });

  it("refuses when the current file does not load: untouched, no backup, no contents in the message", async () => {
    const broken = `${COMMENTED}\nsecret_token: [ghp_SHOULD_NOT_LEAK\n`;
    writeFileSync(path, broken);
    const e = await writeError(addRepo(path, repo(), NOW));
    expect(e.kind).toBe("current");
    expect(e.message).not.toContain("ghp_SHOULD_NOT_LEAK");
    expect(e.message).not.toContain("secret_token");
    expect(readFileSync(path, "utf8")).toBe(broken);
    expect(files()).toEqual(["config.yaml"]);
  });

  it("refuses a current file that parses but fails validation", async () => {
    const invalid = COMMENTED.replace("repo_id: shop-app", "repo_id: nope");
    writeFileSync(path, invalid);
    const e = await writeError(addRepo(path, repo(), NOW));
    expect(e.kind).toBe("current");
    expect(e.message).not.toContain("nope");
    expect(readFileSync(path, "utf8")).toBe(invalid);
    expect(files()).toEqual(["config.yaml"]);
  });

  it("refuses a missing file as current", async () => {
    rmSync(path);
    expect((await writeError(addRepo(path, repo(), NOW))).kind).toBe("current");
    expect(files()).toEqual([]);
  });

  it("re-reads the file: a repo hand-added since start is kept and counts as a duplicate", async () => {
    await addRepo(path, repo({ id: "first", github: "o/first", project: 1 }), NOW);
    const edited = readFileSync(path, "utf8").replace(
      "\nloops:",
      "  # added by hand\n  - id: hand\n    github: o/hand\n    project: 5\n    status_map:\n      Todo: planned\n\nloops:",
    );
    writeFileSync(path, edited);
    expect((await writeError(addRepo(path, repo({ id: "hand" }), NOW + 1000))).kind).toBe(
      "duplicate",
    );
    await addRepo(path, repo(), NOW + 2000);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("  # added by hand\n");
    expect(loadConfig(path).repos.map((r) => r.id)).toEqual([
      "shop-app",
      "site-builder",
      "mission-control",
      "first",
      "hand",
      "studio",
    ]);
  });

  it("a failed rename leaves the file unchanged, removes the temp file and keeps the backup", async () => {
    fault.rename = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    const e = await writeError(addRepo(path, repo(), NOW));
    expect(e.kind).toBe("write");
    expect(e.message).not.toContain(dir);
    expect(readFileSync(path, "utf8")).toBe(COMMENTED);
    expect(files()).toEqual(["config.yaml", "config.yaml.bak-20261019T120000Z"]);
  });

  it("a read-only directory writes nothing and leaves no temp file", async () => {
    chmodSync(dir, 0o500);
    const e = await writeError(addRepo(path, repo(), NOW));
    expect(e.kind).toBe("write");
    expect(readFileSync(path, "utf8")).toBe(COMMENTED);
    chmodSync(dir, 0o700);
    expect(files()).toEqual(["config.yaml"]);
  });

  it(`keeps the newest ${CONFIG_BACKUPS_KEEP} backups, and never a file it did not name`, async () => {
    expect(CONFIG_BACKUPS_KEEP).toBe(10);
    writeFileSync(join(dir, "config.yaml.bak-mine"), "kept");
    for (let i = 0; i < 12; i++) {
      await addRepo(path, repo({ id: `r${i}`, github: `o/r${i}`, project: i + 1 }), NOW + i * 1000);
    }
    expect(loadConfig(path).repos).toHaveLength(15);
    const kept = backups().filter((f) => f !== "config.yaml.bak-mine");
    expect(kept).toEqual(
      Array.from(
        { length: 10 },
        (_, i) => `config.yaml.bak-20261019T1200${String(i + 2).padStart(2, "0")}Z`,
      ),
    );
    expect(readFileSync(join(dir, "config.yaml.bak-mine"), "utf8")).toBe("kept");
    // the newest backup is the file as it was before the last add
    expect(readFileSync(join(dir, "config.yaml.bak-20261019T120011Z"), "utf8")).not.toContain(
      "id: r11",
    );
    expect(readFileSync(join(dir, "config.yaml.bak-20261019T120011Z"), "utf8")).toContain(
      "id: r10",
    );
  });

  it("never prunes this add's own backup, even when its stamp is the oldest", async () => {
    for (let i = 0; i < CONFIG_BACKUPS_KEEP; i++) {
      writeFileSync(
        join(dir, `config.yaml.bak-20261019T1300${String(i).padStart(2, "0")}Z`),
        "newer",
      );
    }
    const { backup } = await addRepo(path, repo(), NOW); // the clock is behind the backups
    expect(readFileSync(backup, "utf8")).toBe(COMMENTED);
    const kept = backups();
    expect(kept).toHaveLength(CONFIG_BACKUPS_KEEP);
    expect(kept).toContain("config.yaml.bak-20261019T120000Z");
    expect(kept).not.toContain("config.yaml.bak-20261019T130000Z");
  });

  it("serialises concurrent adds: both land, in order, each with its own backup", async () => {
    const [a, b] = await Promise.all([
      addRepo(path, repo({ id: "a", github: "o/a", project: 1 }), NOW),
      addRepo(path, repo({ id: "b", github: "o/b", project: 2 }), NOW),
    ]);
    expect(a.config.repos.map((r) => r.id).slice(3)).toEqual(["a"]);
    expect(b.config.repos.map((r) => r.id).slice(3)).toEqual(["a", "b"]);
    expect(loadConfig(path).repos.map((r) => r.id)).toEqual([
      "shop-app",
      "site-builder",
      "mission-control",
      "a",
      "b",
    ]);
    expect(a.backup).not.toBe(b.backup);
    expect(backups()).toHaveLength(2);
    expect(readFileSync(b.backup, "utf8")).toContain("id: a\n");
  });

  it("a failed add does not stall the next one", async () => {
    const dup = addRepo(path, repo({ id: "shop-app" }), NOW);
    const ok = addRepo(path, repo(), NOW);
    expect((await writeError(dup)).kind).toBe("duplicate");
    await ok;
    expect(loadConfig(path).repos.at(-1)?.id).toBe("studio");
  });
});

describe("NewRepoBody", () => {
  const body = {
    id: "studio",
    github: "octo-org/studio",
    project: 4,
    statusMap: { Todo: "planned" },
  };
  const ok = (over: object) => NewRepoBody.safeParse({ ...body, ...over }).success;

  it("accepts a minimal body and an optional needsYouLabels", () => {
    expect(ok({})).toBe(true);
    expect(ok({ needsYouLabels: ["needs-design"] })).toBe(true);
    expect(ok({ id: "a", project: 1_000_000 })).toBe(true);
    expect(ok({ id: `a${"b".repeat(39)}` })).toBe(true);
  });

  it.each([
    ["an extra key", { extra: 1 }],
    ["an id with a slash", { id: "a/b" }],
    ["an id starting with a dot", { id: ".a" }],
    ["a 41-character id", { id: "a".repeat(41) }],
    ["a github name with a space", { github: "a/b c" }],
    ["a github name without an owner", { github: "studio" }],
    ["a github owner starting with a dash", { github: "-a/b" }],
    ["a github owner of 40 characters", { github: `${"a".repeat(40)}/b` }],
    ["project 0", { project: 0 }],
    ["project 1 000 001", { project: 1_000_001 }],
    ["a fractional project", { project: 1.5 }],
    ["a string project", { project: "4" }],
    ["an empty status map", { statusMap: {} }],
    [
      "a 51-entry status map",
      { statusMap: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`s${i}`, "planned"])) },
    ],
    ["an empty status key", { statusMap: { "": "planned" } }],
    ["a 101-character status key", { statusMap: { ["s".repeat(101)]: "planned" } }],
    ["a status key with a newline", { statusMap: { "To\ndo": "planned" } }],
    ["a status key with a DEL", { statusMap: { "To\u007fdo": "planned" } }],
    ["a status value outside TicketState", { statusMap: { Todo: "someday" } }],
    ["11 labels", { needsYouLabels: Array.from({ length: 11 }, (_, i) => `l${i}`) }],
    ["an empty label", { needsYouLabels: [""] }],
    ["a 51-character label", { needsYouLabels: ["l".repeat(51)] }],
  ])("refuses %s", (_name, over) => {
    expect(ok(over)).toBe(false);
  });

  it("allows a 50-entry status map and 100-character keys", () => {
    expect(
      ok({
        statusMap: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`s${i}`, "done"])),
      }),
    ).toBe(true);
    expect(ok({ statusMap: { ["s".repeat(100)]: "planned" } })).toBe(true);
  });

  it("shares its github and project rules with RepoLocation", () => {
    expect(RepoLocation.safeParse({ github: "o/r", project: 1 }).success).toBe(true);
    expect(RepoLocation.safeParse({ github: "a/b c", project: 1 }).success).toBe(false);
    expect(RepoLocation.safeParse({ github: "o/r", project: 0 }).success).toBe(false);
    expect(NewRepoBody.shape.github).toBe(RepoLocation.shape.github);
    expect(NewRepoBody.shape.project).toBe(RepoLocation.shape.project);
  });
});

describe("setSessionSeats", () => {
  const SESSION = "mission-control";
  const read = () => loadConfig(path).crew?.sessions[0]?.seats.map(seatInput) ?? [];
  const lines = () => readFileSync(path, "utf8").split("\n");
  const line = (id: string) => lines().find((l) => l.includes(`id: ${id},`)) ?? "";
  const seat = (id: string): SeatInput => {
    const found = read().find((s) => s.id === id);
    if (!found) throw new Error(`no seat ${id}`);
    return found;
  };
  const inco2: SeatInput = {
    id: "inco-2",
    role: "INCO",
    accountId: "claude-main",
    model: "sonnet",
    area: ["apps/docs/**"],
  };
  const set = (seats: SeatInput[], base = read()) =>
    setSessionSeats(path, SESSION, base, seats, NOW);
  const change = (id: string, over: Partial<SeatInput>) =>
    set(read().map((s) => (s.id === id ? { ...s, ...over } : s)));

  it("persists and clears a display call sign with a stale rename check", async () => {
    const base = read();
    const renamed = base.map((s) =>
      s.id === "guido-1" ? { ...s, displayCallSign: "Orbit One" } : s,
    );
    const { backup } = await set(renamed, base);
    expect(read()).toEqual(renamed);
    expect(readFileSync(backup, "utf8")).toBe(COMMENTED);
    const saved = readFileSync(path, "utf8");
    expect((await writeError(set(base, base))).kind).toBe("conflict");
    expect(readFileSync(path, "utf8")).toBe(saved);
    expect(backups()).toHaveLength(1);
    await set(base);
    expect(read()).toEqual(base);
    expect(readFileSync(path, "utf8")).not.toContain("display_call_sign");
  });

  it.each(["", "   ", "x".repeat(65), "Orbit\nOne", "INCO-1", "inco-1"])(
    "refuses invalid or duplicate display call sign %j without writing",
    async (displayCallSign) => {
      const base = read();
      const renamed = base.map((s) => (s.id === "guido-1" ? { ...s, displayCallSign } : s));
      expect((await writeError(set(renamed))).kind).toBe("invalid");
      expect(readFileSync(path, "utf8")).toBe(COMMENTED);
      expect(backups()).toEqual([]);
    },
  );

  it("adds a seat", async () => {
    const before = readFileSync(path);
    const { config, backup } = await set([...read(), inco2]);
    expect(line("inco-2")).toBe(
      "        - { id: inco-2, role: INCO, account_id: claude-main, model: sonnet, area: [ apps/docs/** ] }",
    );
    const text = readFileSync(path, "utf8");
    for (const comment of COMMENTED.split("\n").filter((l) => l.trim().startsWith("#"))) {
      expect(text).toContain(comment);
    }
    expect(readFileSync(backup).equals(before)).toBe(true);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    expect(config.crew?.sessions[0]?.seats.map((s) => s.id)).toContain("inco-2");
  });

  it("edits a seat in place", async () => {
    const retroBlock =
      "        - id: retro-1 # reviewer\n          role: RETRO\n          # which account\n          account_id: claude-main\n          model: opus";
    writeFileSync(
      path,
      COMMENTED.replace(
        "        - { id: guido-1",
        "        # the server seat\n        - { id: guido-1",
      ).replace(
        "        - { id: retro-1, role: RETRO, account_id: claude-main, model: opus }",
        retroBlock,
      ),
    );
    await change("guido-1", { model: "opus" });
    expect(seat("guido-1").model).toBe("opus");
    const at = lines().findIndex((l) => l.includes("id: guido-1,"));
    expect(lines()[at - 1]).toBe("        # the server seat");
    // the untouched block seat keeps its own comments: its node is reused, not rebuilt
    expect(readFileSync(path, "utf8")).toContain(`${retroBlock}\n`);
  });

  it("removes a seat", async () => {
    const before = read();
    await set(before.filter((s) => s.id !== "retro-1"));
    expect(line("retro-1")).toBe("");
    expect(read()).toEqual(before.filter((s) => s.id !== "retro-1"));
  });

  it("sets and clears optional keys", async () => {
    await change("guido-1", { effort: "high" });
    expect(line("guido-1")).toContain("effort: high");
    expect(seat("guido-1").effort).toBe("high");
    const { effort: _e, ...noEffort } = seat("guido-1");
    await set(read().map((s) => (s.id === "guido-1" ? noEffort : s)));
    expect(line("guido-1")).not.toContain("effort");
    await change("retro-1", { mode: "scratch" });
    expect(line("retro-1")).toContain("mode: scratch");
    const { mode: _m, ...noMode } = seat("retro-1");
    await set(read().map((s) => (s.id === "retro-1" ? noMode : s)));
    expect(line("retro-1")).not.toContain("mode:");
    await set(
      read()
        .filter((s) => s.id === "inco-1")
        .map((s) => ({ ...s, area: [] })),
    );
    expect(line("inco-1")).not.toContain("area");
  });

  it("removes every seat as an empty list", async () => {
    await set([]);
    expect(lines()).toContain("      seats: []");
    expect(read()).toEqual([]);
  });

  it("a stale base is a conflict", async () => {
    const stale = read().filter((s) => s.id !== "retro-1");
    const e = await writeError(set([], stale));
    expect(e.kind).toBe("conflict");
    expect(e.message).toBe(SEATS_CHANGED);
    expect(readFileSync(path, "utf8")).toBe(COMMENTED);
    expect(backups()).toEqual([]);
  });

  it("an unknown session is missing", async () => {
    const e = await writeError(setSessionSeats(path, "nope", [], [], NOW));
    expect(e.kind).toBe("missing");
    expect(e.message).toBe(noSessionText("nope"));
  });

  it("is refused by the loader with its message", async () => {
    const e = await writeError(
      set([...read(), { ...inco2, id: "inco-3", area: ["apps/web/src/**"] }]),
    );
    expect(e.kind).toBe("invalid");
    expect(e.message).toContain("overlap");
    expect(readFileSync(path, "utf8")).toBe(COMMENTED);
    expect(backups()).toEqual([]);
  });

  it("refuses a symlinked config", async () => {
    const target = join(dir, "real.yaml");
    writeFileSync(target, COMMENTED);
    rmSync(path);
    symlinkSync(target, path);
    const e = await writeError(setSessionSeats(path, SESSION, [], [], NOW));
    expect(e.kind).toBe("current");
  });

  it("is serialised with addRepo", async () => {
    const base = read();
    await Promise.all([addRepo(path, repo(), NOW), set([...base, inco2])]);
    const loaded = loadConfig(path);
    expect(loaded.repos.map((r) => r.id)).toContain("studio");
    expect(loaded.crew?.sessions[0]?.seats.map((s) => s.id)).toContain("inco-2");
  });
});

describe("SeatsBody", () => {
  const s = { id: "a-1", role: "GUIDO", accountId: "x", model: "sonnet", area: [] };
  it("needs unique ids, safe areas and no unknown keys", () => {
    expect(SeatsBody.safeParse({ base: [], seats: [s] }).success).toBe(true);
    expect(SeatsBody.safeParse({ base: [], seats: [s, s] }).success).toBe(false);
    expect(SeatsBody.safeParse({ base: [], seats: [{ ...s, area: ["../x"] }] }).success).toBe(
      false,
    );
    expect(SeatsBody.safeParse({ base: [], seats: [{ ...s, x: 1 }] }).success).toBe(false);
  });
});

describe("addAccount", () => {
  it("adds configuration only, with a byte-for-byte backup and no other changes", async () => {
    const text = COMMENTED;
    const doc = (await import("yaml")).parseDocument(text);
    const accounts = doc.get("accounts", true);
    if (!(await import("yaml")).isSeq(accounts)) throw new Error("no accounts");
    accounts.items = accounts.items.filter(
      (item) => (item as { get(k: string): unknown }).get("vendor") !== "codex",
    );
    writeFileSync(path, doc.toString());
    const before = readFileSync(path);
    const current = loadConfig(path);
    const result = await addAccount(path, { name: "secondary", provider: "codex" }, NOW);
    expect(readFileSync(result.backup)).toEqual(before);
    expect(result.config).toEqual({
      ...current,
      accounts: [
        ...current.accounts,
        { id: "secondary", vendor: "codex", alertAt: 80, stopAt: 100 },
      ],
    });
    await expect(addAccount(path, { name: "secondary", provider: "claude" }, NOW)).rejects.toThrow(
      /name/,
    );
    await expect(addAccount(path, { name: "another", provider: "codex" }, NOW)).rejects.toThrow(
      /one account per provider/,
    );
  });
  it("validates provider and a short safe name", () => {
    expect(NewAccountBody.safeParse({ name: "primary", provider: "claude" }).success).toBe(true);
    for (const body of [
      { name: "../bad", provider: "claude" },
      { name: "primary", provider: "other" },
      { name: "primary", provider: "codex", token: "secret" },
    ]) {
      expect(NewAccountBody.safeParse(body).success).toBe(false);
    }
  });
});
