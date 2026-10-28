import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HARD_RULES, DEFAULT_REPO_RULES } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({ count: 0, failNext: false }));
vi.mock("../src/runtime/brief.ts", async (orig) => {
  const real = await orig<typeof import("../src/runtime/brief.ts")>();
  return {
    ...real,
    readRepoClaudeMd: (...a: Parameters<typeof real.readRepoClaudeMd>) => {
      reads.count++;
      if (reads.failNext) {
        reads.failNext = false;
        return Promise.reject(new Error("object read failed"));
      }
      return real.readRepoClaudeMd(...a);
    },
  };
});

import { parseConfig } from "../src/config.ts";
import { parseRepoRules, RepoRulesError, readRepoRules } from "../src/engine/rules.ts";

const block = (yaml: string) =>
  `# Repo\n\nIntro.\n\n## Mission Control\n\n\`\`\`yaml\n${yaml}\n\`\`\`\n`;

const EXAMPLE = `mc:
  pick_from: [Ready]
  promote_backlog: true
  needs: [done_when, size]
  templates:
    "type:feature": feature
    "bug": bugfix
  areas:
    "area:server": ["apps/server/**"]
    "area:web": ["apps/web/**"]
    "area:core": ["packages/core/**"]
  hard_rules: null
  ci: null
  always_ask: []
`;

/** Load the base through the same config parser as the hub. */
const userRules = (rules: Record<string, unknown>) =>
  parseConfig(
    JSON.stringify({
      operator: { timezone: "UTC" },
      accounts: [],
      repos: [{ id: "r", github: "o/r", project: 1, status_map: {}, rules }],
      loops: [],
      poll: { usage_minutes: 30, github_seconds: 60 },
    }),
    "test",
  ).repos[0]?.rules;

describe("parseRepoRules", () => {
  it("inherits user config and only tightens its safety rules", () => {
    const base = userRules({
      templates: { bug: "bugfix", chore: "small-change" },
      pick_from: ["Todo"],
      promote_backlog: true,
      needs: ["size"],
      areas: { "area:api": ["src/**"] },
      hard_rules: ["policy/**"],
      hard_rules_by: "controller",
      always_ask: ["deps"],
    });
    expect(parseRepoRules(null, base)).toEqual(base);
    expect(parseRepoRules("# Repo\n", base)).toEqual(base);
    expect(parseRepoRules(block("mc: {}\n"), base)).toEqual(base);
    const merged = parseRepoRules(
      block(
        "mc:\n  promote_backlog: false\n  templates: {bug: custom}\n  areas: {}\n  needs: []\n  hard_rules: []\n",
      ),
      base,
    );
    expect(merged).toEqual({
      ...base,
      areas: {},
      hardRules: ["policy/**"],
      hardRulesSet: true,
    });
    expect(base?.hardRules).toEqual(["policy/**"]);
  });

  it("unions hard rules and always-ask labels and keeps operator authority", () => {
    const base = userRules({
      hard_rules: ["policy/**"],
      always_ask: ["deps"],
      hard_rules_by: "operator",
    });
    const rules = parseRepoRules(
      block(
        'mc: {hard_rules: ["repo/**", "policy/**"], always_ask: [security, deps], hard_rules_by: controller}',
      ),
      base,
    );
    expect(rules.hardRules).toEqual(["policy/**", "repo/**"]);
    expect(rules.alwaysAsk).toEqual(["deps", "security"]);
    expect(rules.hardRulesBy).toBe("operator");
    expect(
      parseRepoRules(
        block("mc: {hard_rules_by: operator}"),
        userRules({ hard_rules_by: "controller" }),
      ).hardRulesBy,
    ).toBe("operator");
    expect(
      parseRepoRules(
        block("mc: {hard_rules_by: controller}"),
        userRules({ hard_rules_by: "controller" }),
      ).hardRulesBy,
    ).toBe("controller");
  });

  it("preserves explicit empty user policy keys while allowing pick_from and areas", () => {
    const rules = parseRepoRules(
      block(
        'mc: {templates: {bug: custom}, promote_backlog: true, needs: [size], pick_from: [Backlog], areas: {api: ["src/**"]}}',
      ),
      userRules({ templates: {}, promote_backlog: false, needs: [] }),
    );
    expect(rules).toMatchObject({
      templates: {},
      promoteBacklog: false,
      needs: [],
      pickFrom: ["Backlog"],
      areas: { api: ["src/**"] },
    });
    expect(
      parseRepoRules(
        block("mc: {templates: {bug: custom}, promote_backlog: true, needs: []}"),
        userRules({}),
      ),
    ).toMatchObject({ templates: { bug: "custom" }, promoteBacklog: true, needs: [] });
  });

  it.each(["/policy/**", "./policy/**", "policy/", "a//b", "a/../b", "a/./b", "~policy", "a?b"])(
    "refuses malformed hard-rule globs in both sources: %s",
    (glob) => {
      expect(() => userRules({ hard_rules: [glob] })).toThrow(/hardRules/);
      expect(() => parseRepoRules(block(`mc: {hard_rules: ["${glob}"]}`))).toThrow(/hard_rules/);
    },
  );

  it("preserves explicit user choices through structuredClone", () => {
    const base = userRules({ promote_backlog: false });
    if (base === undefined) throw new Error("missing user rules");
    expect(Object.isFrozen(base.userSet)).toBe(true);
    expect(
      parseRepoRules(block("mc: {promote_backlog: true}"), structuredClone(base)).promoteBacklog,
    ).toBe(false);
  });

  it("inherits user templates for a malformed legacy block value and names the key", () => {
    const notes: string[] = [];
    expect(
      parseRepoRules(
        block("mc: {templates: [bad]}"),
        userRules({ templates: { bug: "bugfix" } }),
        notes,
      ).templates,
    ).toEqual({ bug: "bugfix" });
    expect(notes).toEqual([expect.stringContaining("mc.templates")]);
  });

  it.each([{}, { hard_rules: null }, { hard_rules: [] }, { hard_rules: ["policy/**"] }])(
    "keeps hardRulesSet when either source supplies a list: %j",
    (config) => {
      const base = userRules(config);
      for (const value of ["", "  hard_rules: null\n"]) {
        const rules = parseRepoRules(block(`mc:\n  always_ask: []\n${value}`), base);
        expect(rules.hardRulesSet).toBe(Array.isArray(config.hard_rules));
        expect(rules.hardRules).toEqual(base?.hardRules);
      }
      for (const value of ["[]", "[repo/**]"]) {
        expect(parseRepoRules(block(`mc:\n  hard_rules: ${value}\n`), base).hardRulesSet).toBe(
          true,
        );
      }
    },
  );

  it("refuses a malformed override even with valid user-config rules", () => {
    expect(() => parseRepoRules("## Mission Control\n", userRules({ hard_rules: [] }))).toThrow(
      RepoRulesError,
    );
  });

  it("parses the example block", () => {
    const r = parseRepoRules(block(EXAMPLE));
    expect(r.templates).toEqual({ "type:feature": "feature", bug: "bugfix" });
    expect(r.pickFrom).toEqual(["Ready"]);
    expect(r.promoteBacklog).toBe(true);
    expect(r.areas).toEqual({
      "area:server": ["apps/server/**"],
      "area:web": ["apps/web/**"],
      "area:core": ["packages/core/**"],
    });
    expect(r.hardRules).toEqual(DEFAULT_HARD_RULES);
    expect(r.alwaysAsk).toEqual([]);
  });

  it("reads non-default pick_from and always_ask", () => {
    const r = parseRepoRules(
      block("mc:\n  pick_from: [Ready, Backlog]\n  always_ask: [migrations, deps]\n"),
    );
    expect(r.pickFrom).toEqual(["Ready", "Backlog"]);
    expect(r.alwaysAsk).toEqual(["migrations", "deps"]);
  });

  it("reads hard_rules_by, defaults it to the operator, and refuses an unknown value", () => {
    const by = (v: string) =>
      parseRepoRules(block(`mc:\n  hard_rules: []\n  hard_rules_by: ${v}\n`));
    expect(by("controller").hardRulesBy).toBe("operator");
    expect(by("operator").hardRulesBy).toBe("operator");
    expect(parseRepoRules(block("mc:\n  hard_rules: []\n")).hardRulesBy).toBe("operator");
    expect(() => by("flight")).toThrow(RepoRulesError);
  });

  it("parses needs, defaults it, and refuses an unknown need", () => {
    expect(parseRepoRules(block("mc:\n  needs: [done_when]\n")).needs).toEqual(["done_when"]);
    expect(parseRepoRules(block("mc:\n  promote_backlog: true\n")).needs).toEqual([
      "done_when",
      "size",
    ]);
    expect(() => parseRepoRules(block("mc:\n  needs: [owner]\n"))).toThrow(/mc\.needs/);
  });

  it("refuses flight_powers in a repo's block, and hard_rules_by: flight", () => {
    expect(() => parseRepoRules(block("mc:\n  flight_powers: superuser\n"))).toThrow(
      /unknown key "flight_powers"/,
    );
    expect(() => parseRepoRules(block("mc:\n  hard_rules_by: flight\n"))).toThrow(
      /^RepoRulesError: mc\.hard_rules_by:|^mc\.hard_rules_by:/,
    );
  });

  it("names an unknown key", () => {
    expect(() => parseRepoRules(block("mc:\n  foo: 1\n"))).toThrow(RepoRulesError);
    expect(() => parseRepoRules(block("mc:\n  foo: 1\n"))).toThrow(/foo/);
  });

  it("is the defaults with no heading, or null", () => {
    expect(parseRepoRules("# Repo\n\n```yaml\nmc:\n  promote_backlog: true\n```\n")).toEqual(
      DEFAULT_REPO_RULES,
    );
    expect(parseRepoRules(null)).toEqual(DEFAULT_REPO_RULES);
  });

  it("takes the defaults for missing keys", () => {
    expect(parseRepoRules(block("mc:\n  promote_backlog: true\n"))).toEqual({
      ...DEFAULT_REPO_RULES,
      promoteBacklog: true,
    });
    expect(parseRepoRules(block("mc: {}\n"))).toEqual(DEFAULT_REPO_RULES);
  });

  it("defaults hard_rules when absent and honours []", () => {
    expect(parseRepoRules(block("mc:\n  always_ask: [x]\n")).hardRules).toEqual(DEFAULT_HARD_RULES);
    expect(parseRepoRules(block("mc:\n  hard_rules: []\n")).hardRules).toEqual([]);
    expect(parseRepoRules(block("mc:\n  hard_rules: [a/**]\n")).hardRules).toEqual(["a/**"]);
  });

  it("says whether hard_rules was set: null, absent and no block are not", () => {
    expect(parseRepoRules(block("mc:\n  hard_rules: null\n")).hardRulesSet).toBe(false);
    expect(parseRepoRules(block("mc:\n  always_ask: [x]\n")).hardRulesSet).toBe(false);
    expect(parseRepoRules("# Repo\n").hardRulesSet).toBe(false);
    expect(parseRepoRules(null).hardRulesSet).toBe(false);
    expect(parseRepoRules(block("mc:\n  hard_rules: []\n")).hardRulesSet).toBe(true);
    expect(parseRepoRules(block("mc:\n  hard_rules: [a/**]\n")).hardRulesSet).toBe(true);
  });

  it("reads the first yaml block only, skipping other fences", () => {
    const md =
      "## Mission Control\n\n```sh\nfoo\n```\n\n```yaml\nmc:\n  promote_backlog: true\n```\n\n```yaml\nmc:\n  foo: 1\n```\n";
    expect(parseRepoRules(md).promoteBacklog).toBe(true);
  });

  it("reads CRLF text", () => {
    const md = block("mc:\n  promote_backlog: true\n  always_ask: [x]\n").replaceAll("\n", "\r\n");
    const r = parseRepoRules(md);
    expect(r.promoteBacklog).toBe(true);
    expect(r.alwaysAsk).toEqual(["x"]);
  });

  it("refuses a wrong type, naming the key", () => {
    expect(() => parseRepoRules(block("mc:\n  promote_backlog: yes please\n"))).toThrow(
      /promote_backlog/,
    );
    expect(() => parseRepoRules(block("mc:\n  pick_from: Ready\n"))).toThrow(/pick_from/);
    expect(() => parseRepoRules(block("mc:\n  pick_from: []\n"))).toThrow(/pick_from/);
    expect(() => parseRepoRules(block("mc:\n  areas:\n    a: x\n"))).toThrow(RepoRulesError);
  });

  it("refuses bad yaml", () => {
    expect(() => parseRepoRules(block("mc: [\n"))).toThrow(RepoRulesError);
  });

  describe("fences", () => {
    it("ignores a Mission Control heading inside an earlier fence", () => {
      const md = "# Repo\n\n```md\n## Mission Control\n\n```yaml\n```\n\n";
      expect(parseRepoRules(md)).toEqual(DEFAULT_REPO_RULES);
      const tilde =
        "# Repo\n\n~~~md\n## Mission Control\n~~~\n\n## Mission Control\n\n```yaml\nmc:\n  promote_backlog: true\n```\n";
      expect(parseRepoRules(tilde).promoteBacklog).toBe(true);
    });

    it("does not end the section at a ## line inside a non-yaml fence", () => {
      const md =
        "## Mission Control\n\n```sh\n## a shell comment\n```\n\n```yaml\nmc:\n  promote_backlog: true\n```\n";
      expect(parseRepoRules(md).promoteBacklog).toBe(true);
    });

    it("does not take a ## line inside the yaml fence as the end either", () => {
      const md = "## Mission Control\n\n```yaml\n## comment\nmc:\n  promote_backlog: true\n```\n";
      expect(parseRepoRules(md).promoteBacklog).toBe(true);
    });

    it("needs a closing fence at least as long, of the same kind", () => {
      const md = "## Mission Control\n\n````yaml\nmc:\n  promote_backlog: true\n```\n````\n";
      expect(() => parseRepoRules(md)).toThrow(RepoRulesError);
      const tilde = "## Mission Control\n\n~~~yaml\nmc:\n  promote_backlog: true\n~~~\n";
      expect(parseRepoRules(tilde).promoteBacklog).toBe(true);
    });

    it("closes a fence only with the same kind of fence", () => {
      const md = "## Mission Control\n\n~~~yaml\nmc:\n  promote_backlog: true\n```\n";
      expect(() => parseRepoRules(md)).toThrow(/no yaml block/);
    });

    it("closes a fence only with a line that carries no info string", () => {
      const md = "## Mission Control\n\n```yaml\nmc:\n  promote_backlog: true\n```yaml\n";
      expect(() => parseRepoRules(md)).toThrow(/no yaml block/);
    });

    it("takes yaml or yml as the info string, not a longer word", () => {
      const md = "## Mission Control\n\n```yaml-foo\nmc:\n  promote_backlog: true\n```\n";
      expect(() => parseRepoRules(md)).toThrow(/no yaml block/);
      const attrs = "## Mission Control\n\n```yaml title=x\nmc:\n  promote_backlog: true\n```\n";
      expect(parseRepoRules(attrs).promoteBacklog).toBe(true);
    });
  });

  describe("the heading", () => {
    const body = "\n```yaml\nmc:\n  promote_backlog: true\n```\n";

    it("may carry closing hashes", () => {
      expect(parseRepoRules(`## Mission Control ##\n${body}`).promoteBacklog).toBe(true);
      expect(parseRepoRules(`## Mission Control\t###  \n${body}`).promoteBacklog).toBe(true);
    });

    it("may be indented by up to three spaces", () => {
      expect(parseRepoRules(` ## Mission Control\n${body}`).promoteBacklog).toBe(true);
      expect(parseRepoRules(`   ## Mission Control\n${body}`).promoteBacklog).toBe(true);
    });

    it("may follow a UTF-8 BOM", () => {
      expect(parseRepoRules(`﻿## Mission Control\n${body}`).promoteBacklog).toBe(true);
    });

    it("ends the section at an indented or bare ## heading", () => {
      expect(() => parseRepoRules(`## Mission Control\n\n  ## Other\n${body}`)).toThrow(
        /no yaml block/,
      );
      expect(() => parseRepoRules(`## Mission Control\n\n##\n${body}`)).toThrow(/no yaml block/);
    });

    it("is not a heading when indented four spaces or followed by other text", () => {
      expect(parseRepoRules(`    ## Mission Control\n${body}`)).toEqual(DEFAULT_REPO_RULES);
      expect(parseRepoRules(`## Mission Control Room\n${body}`)).toEqual(DEFAULT_REPO_RULES);
    });
  });

  describe("a heading whose block is not usable", () => {
    const noBlock = /no yaml block/;

    it("refuses a section with no yaml fence before the next ## heading", () => {
      const md =
        "## Mission Control\n\nNo block here.\n\n## Other\n\n```yaml\nmc:\n  foo: 1\n```\n";
      expect(() => parseRepoRules(md)).toThrow(noBlock);
      expect(() => parseRepoRules("## Mission Control\n\nnothing\n")).toThrow(noBlock);
    });

    it("refuses an unclosed fence", () => {
      expect(() =>
        parseRepoRules("## Mission Control\n\n```yaml\nmc:\n  pick_from: [Ready]\n"),
      ).toThrow(noBlock);
    });

    it("accepts the heading in any case and a yml or tilde fence", () => {
      const md = "## mission control\n\n~~~YML\nmc:\n  promote_backlog: true\n~~~\n";
      expect(parseRepoRules(md).promoteBacklog).toBe(true);
      expect(
        parseRepoRules("## MISSION CONTROL\n\n```yml\nmc:\n  promote_backlog: true\n```\n")
          .promoteBacklog,
      ).toBe(true);
    });

    it("refuses an empty block, no mc key, mc null, and non-mappings", () => {
      for (const yaml of ["", "# just a comment\n", "other: 1\n", "mc:\n", "mc: null\n"]) {
        expect(() => parseRepoRules(block(yaml)), JSON.stringify(yaml)).toThrow(RepoRulesError);
      }
      for (const yaml of ["- a\n- b\n", "just text\n", "mc: [a]\n", "mc: 3\n", "mc: text\n"]) {
        expect(() => parseRepoRules(block(yaml)), JSON.stringify(yaml)).toThrow(RepoRulesError);
      }
    });
  });

  describe("areas", () => {
    it("refuses a label with no globs, or an empty glob", () => {
      expect(() => parseRepoRules(block("mc:\n  areas:\n    a: []\n"))).toThrow(/areas/);
      expect(() => parseRepoRules(block('mc:\n  areas:\n    a: [""]\n'))).toThrow(/areas/);
    });

    it("refuses ** anywhere but a trailing /**", () => {
      for (const g of ["**", "a/**/b", "**/b", "a**", "a/**/**"]) {
        expect(() => parseRepoRules(block(`mc:\n  areas:\n    a: ["${g}"]\n`)), g).toThrow(/areas/);
      }
      const ok = parseRepoRules(block('mc:\n  areas:\n    a: ["a/*/b", "c/**", "d.ts"]\n'));
      expect(ok.areas).toEqual({ a: ["a/*/b", "c/**", "d.ts"] });
    });

    it("refuses a glob that starts with /", () => {
      expect(() => parseRepoRules(block('mc:\n  areas:\n    a: ["/apps/**"]\n'))).toThrow(/areas/);
    });

    it("refuses a __proto__ label rather than dropping it", () => {
      expect(() => parseRepoRules(block('mc:\n  areas:\n    __proto__: ["a/**"]\n'))).toThrow(
        /__proto__/,
      );
    });
  });

  it("returns frozen rules", () => {
    const r = parseRepoRules(block(EXAMPLE));
    expect(() => r.pickFrom.push("x")).toThrow(TypeError);
    expect(() => r.hardRules.push("x")).toThrow(TypeError);
    expect(() => r.areas["area:server"]?.push("x")).toThrow(TypeError);
    expect(() => {
      r.promoteBacklog = false;
    }).toThrow(TypeError);
    const d = parseRepoRules(null);
    expect(() => d.hardRules.push("x")).toThrow(TypeError);
  });
});

describe("readRepoRules", () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=n", ...args], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  /** Commit a CLAUDE.md; origin/main follows unless `local`. Returns the sha. */
  const commit = (claudeMd: string, local = false) => {
    writeFileSync(join(repo, "CLAUDE.md"), claudeMd);
    git("add", "-A");
    git("commit", "-qm", "c");
    const sha = git("rev-parse", "HEAD");
    if (!local) git("update-ref", "refs/remotes/origin/main", sha);
    return sha;
  };
  const promote = (on: boolean) => block(`mc:\n  promote_backlog: ${on}\n`);

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "mc-rules-")));
    git("init", "-q", "-b", "main");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    reads.count = 0;
    reads.failNext = false;
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("returns malformed-template notes to the caller once per cached read", async () => {
    commit(block("mc: {templates: [bad]}"));
    const notes: string[] = [];
    expect(await readRepoRules("test/repo", repo, DEFAULT_REPO_RULES, notes)).not.toBeInstanceOf(
      Error,
    );
    expect(notes).toEqual([expect.stringContaining("test/repo: mc.templates")]);
    const cachedNotes: string[] = [];
    await readRepoRules("test/repo", repo, DEFAULT_REPO_RULES, cachedNotes);
    expect(cachedNotes).toEqual([]);
  });

  it("carries parsed repo.rules through the engine read with a tightening block", async () => {
    const base = userRules({
      hard_rules: ["policy/**"],
      promote_backlog: false,
      needs: [],
      templates: { bug: "bugfix" },
    });
    commit(
      block(
        'mc: {hard_rules: ["repo/**"], promote_backlog: true, needs: [size], templates: {bug: custom}}',
      ),
    );
    expect(await readRepoRules("o/r", repo, base)).toMatchObject({
      hardRules: ["policy/**", "repo/**"],
      promoteBacklog: false,
      needs: [],
      templates: { bug: "bugfix" },
    });
  });

  it("reads origin/HEAD's CLAUDE.md once per sha", async () => {
    commit(promote(true));
    const first = await readRepoRules("o/r", repo);
    expect(first).toMatchObject({ promoteBacklog: true });
    expect(reads.count).toBe(1);
    expect(await readRepoRules("o/r", repo)).toEqual(first);
    expect(reads.count).toBe(1);

    commit(promote(false));
    expect(await readRepoRules("o/r", repo)).toMatchObject({ promoteBacklog: false });
    expect(reads.count).toBe(2);
  });

  it("reads and caches the gate's main sha even when origin/HEAD differs", async () => {
    const mainSha = commit(promote(false));
    commit(promote(true));
    expect(await readRepoRules("o/r", repo)).toMatchObject({ promoteBacklog: true });
    expect(await readRepoRules("o/r", repo, DEFAULT_REPO_RULES, [], mainSha)).toMatchObject({
      promoteBacklog: false,
    });
    expect(await readRepoRules("o/r", repo, DEFAULT_REPO_RULES, [], mainSha)).toMatchObject({
      promoteBacklog: false,
    });
    expect(reads.count).toBe(2);
  });

  it("reads origin's version, not a local commit's", async () => {
    commit(promote(true));
    commit(promote(false), true);
    expect(await readRepoRules("o/r", repo)).toMatchObject({ promoteBacklog: true });
  });

  it("is not fooled by a local branch named origin/HEAD", async () => {
    commit(promote(true));
    const local = commit(promote(false), true);
    git("update-ref", "refs/heads/origin/HEAD", local);
    expect(await readRepoRules("o/r", repo)).toMatchObject({ promoteBacklog: true });
  });

  it("keeps only the latest sha per checkout: an older sha is read again", async () => {
    const a = commit(promote(true));
    await readRepoRules("o/r", repo);
    commit(promote(false));
    await readRepoRules("o/r", repo);
    expect(reads.count).toBe(2);
    git("update-ref", "refs/remotes/origin/main", a);
    expect(await readRepoRules("o/r", repo)).toMatchObject({ promoteBacklog: true });
    expect(reads.count).toBe(3);
  });

  it("does not cache a failed read: the next call with the same sha reads again", async () => {
    commit(promote(true));
    reads.failNext = true;
    const e = await readRepoRules("o/r", repo);
    expect(e).toBeInstanceOf(RepoRulesError);
    expect((e as RepoRulesError).message).toMatch(/object read failed/);
    expect(reads.count).toBe(1);
    expect(await readRepoRules("o/r", repo)).toMatchObject({ promoteBacklog: true });
    expect(reads.count).toBe(2);
  });

  it("returns the error rather than throwing, and caches it by sha", async () => {
    commit(block("mc:\n  foo: 1\n"));
    const e = await readRepoRules("o/r", repo);
    expect(e).toBeInstanceOf(RepoRulesError);
    expect((e as RepoRulesError).message).toMatch(/foo/);
    await readRepoRules("o/r", repo);
    expect(reads.count).toBe(1);
  });

  it("is the defaults when the repo has no CLAUDE.md", async () => {
    writeFileSync(join(repo, "README.md"), "hi\n");
    git("add", "-A");
    git("commit", "-qm", "c");
    git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
    expect(await readRepoRules("o/r", repo)).toEqual(DEFAULT_REPO_RULES);
  });

  it("uses user-config rules when the repo has no CLAUDE.md", async () => {
    writeFileSync(join(repo, "README.md"), "hi\n");
    git("add", "-A");
    git("commit", "-qm", "c");
    git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
    const base = userRules({ hard_rules: ["policy/**"], templates: { bug: "bugfix" } });
    expect(await readRepoRules("o/r", repo, base)).toEqual(base);
  });

  it("does not reuse a cached result with different user-config rules", async () => {
    commit(promote(true));
    expect(await readRepoRules("o/r", repo, userRules({ hard_rules: [] }))).toMatchObject({
      promoteBacklog: true,
      hardRulesSet: true,
    });
    expect(
      await readRepoRules("o/r", repo, userRules({ hard_rules: ["policy/**"] })),
    ).toMatchObject({
      promoteBacklog: true,
      hardRules: ["policy/**"],
    });
    expect(await readRepoRules("o/r", repo)).toMatchObject({ hardRulesSet: false });
  });

  it("returns an error when origin/HEAD does not resolve", async () => {
    expect(await readRepoRules("o/r", repo)).toBeInstanceOf(RepoRulesError);
  });
});

describe("this repo's own rules", () => {
  it("name every default hard-rule path, so an addition to the defaults is not lost here", () => {
    const md = readFileSync(fileURLToPath(new URL("../../../CLAUDE.md", import.meta.url)), "utf8");
    const own = parseRepoRules(md).hardRules;
    expect(DEFAULT_HARD_RULES.filter((p) => !own.includes(p))).toEqual([]);
  });
});

it.each(["[]", "null", "old-format", "{ bug: { profile: bugfix } }"])(
  "tolerates legacy templates: %s",
  (templates) => {
    expect(parseRepoRules(block(`mc:\n  templates: ${templates}\n`)).templates).toEqual({});
  },
);
