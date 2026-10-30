import { describe, expect, it } from "vitest";
import {
  BACKGROUND_SUITE_TEXT,
  closesIssue,
  codexCommand,
  decodeCharRefs,
  engineHitText,
  FREE_SUITE_HINT,
  firstCommitNotifier,
  firstNamedRef,
  firstPrNotifier,
  GUARD_RULES,
  GUARD_TOO_LONG_TEXT,
  GUARD_UNREADABLE_TEXT,
  type GuardContext,
  type GuardEvent,
  guardDecision,
  isFullSuite,
  MC_WRITER_TOOLS,
  REREAD_MIN_BYTES,
  type ReadRecord,
  rereadVerdict,
  scanSecrets,
  scanText,
  splitCommands,
  unclosedMarkdown,
  wholeFileRead,
} from "../src/guard.ts";
import { MC_TOOLS } from "../src/mcp.ts";
import { CODEX_SHELL } from "../src/runtime.ts";

describe("codexCommand", () => {
  it("decodes the spike's bare, quoted, mixed-quote and heredoc commands", () => {
    expect(codexCommand("/bin/zsh -lc ls", ["ls"])).toBe("ls");
    expect(codexCommand("/bin/zsh -lc 'cat a.txt'", ["cat", "a.txt"])).toBe("cat a.txt");
    const mixed = String.raw`echo 'it'"'"'s' "$HOME" \$x`;
    const raw = String.raw`/bin/zsh -lc "echo 'it'\"'\"'s' \"\$HOME\" \\\$x"`;
    expect(codexCommand(raw, [CODEX_SHELL, "-lc", mixed])).toBe(mixed);
    const heredoc = "cat <<'E'\nline1\nE";
    expect(codexCommand(`/bin/zsh -lc "${heredoc}"`, [CODEX_SHELL, "-lc", heredoc])).toBe(heredoc);
    expect(codexCommand("/bin/zsh -lc c\"at \"'a.txt'", null)).toBe("cat a.txt");
  });

  it.each([
    "/usr/bin/env zsh -lc x",
    "/bin/bash -lc x",
    "/bin/zsh -c x",
    "/bin/zsh -lc x extra",
    "/bin/zsh -lc",
    "/bin/zsh -lc 'x",
    '/bin/zsh -lc "$HOME"',
    '/bin/zsh -lc "`id`"',
    '/bin/zsh -lc "bad\\q"',
    "/bin/zsh -lc $HOME",
    "/bin/zsh -lc ls;id",
    "/bin/zsh -lc ls\nid",
    "/bin/zsh -lc *",
    "/bin/zsh -lc ~",
    "/bin/zsh -lc ls\0",
  ])("declines ambiguous command %j", (raw) => {
    expect(codexCommand(raw, null)).toBeNull();
  });

  it("checks both forms of amendment word for word", () => {
    expect(codexCommand("/bin/zsh -lc 'cat a.txt'", ["cat", "b.txt"])).toBeNull();
    expect(codexCommand("/bin/zsh -lc ls", [CODEX_SHELL, "-lc", "pwd"])).toBeNull();
    expect(codexCommand("/bin/zsh -lc ls", [])).toBeNull();
    expect(codexCommand("/bin/zsh -lc 'cat a.txt'", [CODEX_SHELL, "-lc", "cat a.txt"])).toBe(
      "cat a.txt",
    );
  });

  it("matches a segment amendment while retaining the whole chain for the guard", () => {
    const script = 'rg -n "a|b" docs && sed -n 1,5p a; sed -n 1,5p b';
    const raw = `/bin/zsh -lc '${script}'`;
    for (const amendment of [
      ["rg", "-n", "a|b", "docs"],
      ["sed", "-n", "1,5p", "a"],
      ["sed", "-n", "1,5p", "b"],
      [CODEX_SHELL, "-lc", script],
    ])
      expect(codexCommand(raw, amendment)).toBe(script);
    expect(codexCommand(raw, ["sed", "-n", "1,5p", "c"])).toBeNull();
    expect(codexCommand(raw, ["rg", "-n"])).toBeNull();
    expect(codexCommand(raw, [CODEX_SHELL, "-lc", "sed -n 1,5p a"])).toBeNull();
    expect(codexCommand("/bin/zsh -lc 'sed -n 1p a && curl x'", ["sed", "-n", "1p", "a"])).toBe(
      "sed -n 1p a && curl x",
    );
  });
});

const FULL = ["pnpm -s test", "pnpm -s vitest run", "pnpm -s vitest"];
const writer: GuardContext = {
  mode: "writer",
  repo: "dev",
  flightPowers: "standard",
  fullSuite: FULL,
};
const readOnly: GuardContext = {
  mode: "read-only",
  repo: "dev",
  flightPowers: "standard",
  fullSuite: FULL,
};
const flightFull: GuardContext = { ...readOnly, fullAccess: true };
const bash = (command: string, extra: Partial<GuardEvent["input"]> = {}): GuardEvent => ({
  tool: "Bash",
  input: { command, ...extra },
});
const ruleOf = (e: GuardEvent, ctx = writer) => {
  const v = guardDecision(e, ctx);
  return v.kind === "deny" ? v.rule : v.kind;
};

describe("FLIGHT's full profile", () => {
  it("permits ordinary shell authority but retains repository floors", () => {
    expect(guardDecision(bash("gh pr close 12"), flightFull)).toEqual({ kind: "allow" });
    expect(ruleOf(bash("git push origin main"), flightFull)).toBe("merge-push");
    expect(ruleOf(bash("git push --force origin feature/x"), flightFull)).toBe("merge-push");
    expect(ruleOf(bash("gh pr merge 12"), flightFull)).toBe("merge-push");
    expect(
      ruleOf({ tool: "Write", input: { file_path: "/work/.github/workflows/ci.yml" } }, flightFull),
    ).toBe("repo-rules");
    expect(ruleOf({ tool: "Edit", input: { file_path: "/work/CLAUDE.md" } }, flightFull)).toBe(
      "repo-rules",
    );
  });
});

describe("scratch mode", () => {
  const scratch: GuardContext = {
    mode: "scratch",
    repo: "dev",
    flightPowers: "standard",
    fullSuite: ["pnpm -s test"],
  };

  it("scratch: edits and locked suites allowed, commit denied", () => {
    expect(guardDecision({ tool: "Edit", input: { file_path: "/w/a.ts" } }, scratch)).toEqual({
      kind: "allow",
    });
    expect(guardDecision({ tool: "Write", input: { file_path: "/w/a.ts" } }, scratch)).toEqual({
      kind: "allow",
    });
    expect(guardDecision({ tool: MC_WRITER_TOOLS[0], input: {} }, scratch)).toEqual({
      kind: "deny",
      rule: "read-only",
      text: "Read-only roles cannot write: mcp__mc__commit (a scratch copy is never committed)",
    });
    expect(guardDecision(bash("pnpm -s test"), scratch)).toEqual({
      kind: "lock",
      command: "pnpm -s test",
    });
    expect(ruleOf(bash("git commit -m x"), scratch)).toBe("git-write");
    expect(ruleOf(bash("pnpm -s vitest run a.test.ts"), scratch)).toBe("allow");
  });

  it("scratch: ask_flight, report_evidence and report_plan denied, report_findings allowed", () => {
    for (const tool of [MC_TOOLS.askFlight, MC_TOOLS.reportEvidence, MC_TOOLS.reportPlan]) {
      expect(guardDecision({ tool, input: {} }, scratch)).toEqual({
        kind: "deny",
        rule: "read-only",
        text: `Read-only roles cannot write: ${tool} (a scratch review answers with report_findings)`,
      });
    }
    expect(guardDecision({ tool: MC_TOOLS.reportFindings, input: {} }, scratch)).toEqual({
      kind: "allow",
    });
    expect(guardDecision({ tool: MC_TOOLS.askFlight, input: {} }, writer)).toEqual({
      kind: "allow",
    });
  });

  it.each([
    "merge_pr",
    "settle_park",
    "hold_pr",
    "rerun_ci",
    "edit_card",
    "dismiss_item",
    "gh_read",
    "close_ticket",
    "add_controller_check",
    "screenshot_hud",
  ])("guards %s with the live repo powers", (name) => {
    const event = { tool: `mcp__mc__${name}`, input: {} };
    expect(guardDecision(event, writer)).toMatchObject({ kind: "deny", rule: "flight-powers" });
    expect(guardDecision(event, { ...writer, flightPowers: "superuser" })).toEqual({
      kind: "allow",
    });
  });

  it("a superuser-only tool is denied on a standard repo and allowed on a superuser one", () => {
    const e = { tool: "mcp__mc__promote", input: {} };
    expect(guardDecision(e, writer, ["promote"])).toEqual({
      kind: "deny",
      rule: "flight-powers",
      text: `${GUARD_RULES["flight-powers"]}: mcp__mc__promote (needs flight_powers: superuser)`,
    });
    expect(guardDecision(e, { ...writer, flightPowers: "superuser" }, ["promote"])).toEqual({
      kind: "allow",
    });
    expect(guardDecision(e, writer)).toEqual({ kind: "allow" });
  });
});

describe("GUARD_RULES", () => {
  it("carries the catalogue texts", () => {
    expect(GUARD_RULES["git-write"]).toBe(
      "git writes only through the mc commit tool; report with mc report_evidence and Mission Control pushes and opens the PR",
    );
    // the seat has no push or draft-PR tool to be sent to
    expect(GUARD_RULES["git-write"]).not.toMatch(/draft-PR|mc push/);
    expect(GUARD_RULES["merge-push"]).toBe(
      "No merging, force-push or pushes to protected branches; a PR leaves draft only for a safe PR in away mode",
    );
    expect(GUARD_RULES.network).toBe("No network from a crew's commands");
    expect(GUARD_RULES.secret).toBe("No secrets in a push");
    expect(GUARD_RULES["flight-powers"]).toBe(
      "Only repos with flight_powers: superuser may use these tools",
    );
    // Codex commands are no longer an allowlist: only the area, protected files and the sandbox
    expect(GUARD_RULES["codex-allowlist"]).toBe(
      "The Codex request is outside the seat’s area, protected files or sandbox",
    );
    expect(GUARD_RULES["gh-cli"]).toMatch(/^The GitHub CLI is not available to seats/);
    expect(GUARD_RULES["gh-cli"]).not.toMatch(/comments|labels/);
    expect(GUARD_RULES.unreadable).toBe("Commands the guard cannot read to the end are refused");
    expect(GUARD_RULES.background).toBe(
      "Commands must stay attached to the seat's current tool call",
    );
    // github-write is retired: no guard path produced it once gh got its own rule
    expect(Object.keys(GUARD_RULES)).not.toContain("github-write");
    expect(Object.keys(GUARD_RULES)).toHaveLength(13);
    expect(FREE_SUITE_HINT).toBe("the same command with a test file path");
  });
});

describe("engineHitText", () => {
  it("names Mission Control's own action, not an mc tool", () => {
    expect(engineHitText("secret", "push")).toBe("No secrets in a push: Mission Control's push");
  });
});

describe("splitCommands", () => {
  it("splits on separators, drops assignments and wrappers, basenames the program", () => {
    expect(splitCommands("cd apps && git push; ls | wc\nfoo || bar")).toEqual([
      ["cd", "apps"],
      ["git", "push"],
      ["ls"],
      ["wc"],
      ["foo"],
      ["bar"],
    ]);
    expect(splitCommands("FOO=1 BAR=2 env sudo -E /usr/bin/git push")).toEqual([["git", "push"]]);
    expect(splitCommands("time nohup command exec git status")).toEqual([["git", "status"]]);
  });
  it("respects quotes and does not split inside them", () => {
    expect(splitCommands(`echo "a; git push" 'b && c'`)).toEqual([
      ["echo", "a; git push", "b && c"],
    ]);
    expect(splitCommands(`"git" 'push'`)).toEqual([["git", "push"]]);
  });
  it("surfaces sh -c scripts and subshells", () => {
    expect(splitCommands(`bash -c "git push"`)).toContainEqual(["git", "push"]);
    expect(splitCommands("echo $(git push)")).toContainEqual(["git", "push"]);
  });
});

describe("isFullSuite", () => {
  it("needs the entry's words, then only flags", () => {
    expect(isFullSuite(["pnpm", "-s", "vitest", "run"], FULL)).toBe(true);
    expect(isFullSuite(["pnpm", "-s", "vitest", "run", "--reporter=dot"], FULL)).toBe(true);
    expect(isFullSuite(["pnpm", "-s", "vitest", "run", "a.test.ts"], FULL)).toBe(false);
    expect(isFullSuite(["pnpm", "-s", "lint"], FULL)).toBe(false);
  });
});

describe("guardDecision: git", () => {
  it.each([
    "git -C . push",
    "/usr/bin/git commit -m x",
    "FOO=1 git push",
    "env git push",
    "cd apps && git push",
    "ls\ngit push",
    "git -c user.name=x commit",
    "git commit",
    "git add",
    "git merge",
    "git rebase",
    "git reset --hard",
    "git tag x",
    "git update-ref",
    "git branch -D x",
    "git branch x",
    "git checkout -b x",
    "git switch -c x",
    "git cherry-pick",
    "git stash",
    "git worktree add",
    "git config x y",
    "git remote add o u",
    "git fetch",
    "git pull",
  ])("denies %s as git-write", (c) => {
    expect(ruleOf(bash(c))).toBe("git-write");
  });
  it.each([
    "git status",
    "git diff",
    "git log --oneline",
    "git show HEAD",
    "git branch",
    "git branch --list",
    "git -C x status",
  ])("allows %s", (c) => {
    expect(ruleOf(bash(c))).toBe("allow");
  });
  it("names only the program and subcommand in the text", () => {
    const v = guardDecision(bash("git push --force https://tok@host/x"), writer);
    expect(v).toEqual({
      kind: "deny",
      rule: "git-write",
      text: `${GUARD_RULES["git-write"]}: git push`,
    });
  });
});

describe("guardDecision: gh, network", () => {
  it.each([
    "gh pr comment 1 -b x",
    "gh issue edit 1 --add-label x",
    "gh pr merge 1",
    "gh pr ready 1",
    "gh api -X POST repos/x/y/issues",
    "gh api repos/x/y -f a=b",
    "gh api graphql",
    "gh auth token",
  ])("denies %s as gh-cli", (c) => {
    expect(ruleOf(bash(c))).toBe("gh-cli");
  });
  it.each(["gh pr view 1", "gh api repos/x/y", "gh pr list", "gh api -X GET repos/x/y"])(
    "denies the read %s as gh-cli, whose text says gh is unavailable",
    (c) => {
      expect(ruleOf(bash(c))).toBe("gh-cli");
      expect((guardDecision(bash(c), writer) as { text: string }).text).toMatch(
        /^The GitHub CLI is not available to seats/,
      );
    },
  );
  it("denies curl and wget as network", () => {
    expect(ruleOf(bash("curl https://x"))).toBe("network");
    expect(ruleOf(bash("a && wget x"))).toBe("network");
  });
});

describe("guardDecision: the full suite", () => {
  it("locks a suite with no path and allows one with a path", () => {
    expect(guardDecision(bash("pnpm -s vitest run"), writer)).toEqual({
      kind: "lock",
      command: "pnpm -s vitest run",
    });
    expect(ruleOf(bash("pnpm -s vitest run apps/x.test.ts"))).toBe("allow");
    expect(ruleOf(bash("pnpm -s lint"))).toBe("allow");
  });
  it("denies a background suite with the foreground text", () => {
    expect(guardDecision(bash("pnpm -s test", { run_in_background: true }), writer)).toEqual({
      kind: "deny",
      rule: "full-suite",
      text: "Run the full suite in the foreground: it holds the test lock.",
    });
  });
  it.each([
    "pnpm -s test &",
    "pnpm -s test 2>&1 &",
    "pnpm -s test & wait",
    "nohup pnpm -s vitest run >out.log &",
    `bash -c "pnpm -s test &"`,
  ])("denies %s (a background suite returns at once) with the foreground text", (c) => {
    expect(guardDecision(bash(c), writer)).toEqual({
      kind: "deny",
      rule: "full-suite",
      text: "Run the full suite in the foreground: it holds the test lock.",
    });
  });
  it.each([
    "pnpm -s test && echo ok",
    "pnpm -s test &>out.log",
    "pnpm -s test |& tee out.log",
    `pnpm -s test -t "a & b"`,
  ])("still locks %s (no background &)", (c) => {
    expect(ruleOf(bash(c))).toBe("lock");
  });
  it("denies a background command that is not a full suite", () => {
    expect(ruleOf(bash("sleep 1 &"))).toBe("background");
    expect(ruleOf(bash("sleep 1", { run_in_background: true }))).toBe("background");
  });
  it("locks a suite in read-only mode", () => {
    expect(guardDecision(bash("pnpm -s vitest run"), readOnly)).toEqual({
      kind: "lock",
      command: "pnpm -s vitest run",
    });
  });
  it("a deny beats a lock in one command line", () => {
    expect(ruleOf(bash("pnpm -s test && git push"))).toBe("git-write");
  });
});

describe("guardDecision: read-only seats", () => {
  it("keeps FLIGHT's granted sync_main while refusing scratch and other read-only seats", () => {
    const event = { tool: MC_TOOLS.syncMain, input: {} };
    expect(ruleOf(event, { ...readOnly, mcTools: ["sync_main"] })).toBe("allow");
    expect(ruleOf(event, readOnly)).toBe("read-only");
    expect(ruleOf(event, { ...readOnly, mode: "scratch", mcTools: ["sync_main"] })).toBe(
      "read-only",
    );
  });

  it("lists the writer tools that write through the hub", () => {
    expect(MC_WRITER_TOOLS).toEqual([MC_TOOLS.commit, MC_TOOLS.syncMain]);
  });
  it.each(["Edit", "Write", "NotebookEdit", ...MC_WRITER_TOOLS])("denies %s", (tool) => {
    expect(ruleOf({ tool, input: {} }, readOnly)).toBe("read-only");
    expect(ruleOf({ tool, input: {} }, writer)).toBe("allow");
  });
  it.each(["mcp__mc__ask_flight", "mcp__mc__report_evidence"])(
    "allows %s in both modes",
    (tool) => {
      expect(ruleOf({ tool, input: {} }, readOnly)).toBe("allow");
      expect(ruleOf({ tool, input: {} }, writer)).toBe("allow");
    },
  );
});

describe("merge-push", () => {
  it("has the hub-side refusal text (recorded by the push tool, no Bash command of its own)", () => {
    expect(GUARD_RULES["merge-push"]).toBe(
      "No merging, force-push or pushes to protected branches; a PR leaves draft only for a safe PR in away mode",
    );
  });
});

const TOKEN = `ghp_${"a1B2".repeat(9)}`;
const log = (...chunks: string[]) => chunks.map((c) => `\0commit ${c}`).join("");
const sha = "1234567890abcdef1234567890abcdef12345678";

describe("scanSecrets", () => {
  const diff = (path: string, added: string[], removed: string[] = []) =>
    `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,${1 + removed.length} +1,${1 + added.length} @@\n ctx\n${removed.map((r) => `-${r}`).join("\n")}${removed.length ? "\n" : ""}${added.map((a) => `+${a}`).join("\n")}\n`;

  it("finds a token on an added line with the file and line", () => {
    const out = scanSecrets(
      log(`${sha}\nmsg\n\n${diff("src/a.ts", ["ok", `x = "${TOKEN}"`])}`),
      [],
    );
    expect(out).toEqual([{ where: "src/a.ts", line: 3, kind: "GitHub token" }]);
  });
  it("finds a token hidden behind a fake commit header inside a file", () => {
    const body = diff("a.ts", [`x\0commit ${TOKEN}`]);
    const found = [{ where: "a.ts", line: 2, kind: "GitHub token" }];
    expect(scanSecrets(log(`${sha}\nmsg\n\n${body}`), [])).toEqual(found);
    expect(scanSecrets(log(`staged\n${body}`), [])).toEqual(found);
    for (const fake of [`x\0commit staged${TOKEN}`, `x\0commit ${sha}${TOKEN}`]) {
      expect(scanSecrets(log(`${sha}\nmsg\n\n${diff("a.ts", [fake])}`), [])).toEqual(found);
    }
  });
  it("finds a known credential faked as a commit id inside a file", () => {
    const hex = "0123456789abcdef0123456789abcdef01234567";
    const body = diff("a.ts", [`x\0commit ${hex}`, "y"]);
    expect(scanSecrets(log(`${sha}\nmsg\n\n${body}`), [hex])).toEqual([
      { where: "(name withheld)", line: 0, kind: "local credential" },
    ]);
  });
  it("finds a token in a header-only file whose name holds ' b/'", () => {
    const name = `${TOKEN} b/x.empty`;
    const empty = `diff --git a/${name} b/${name}\nnew file mode 100644\nindex 0000000..e69de29\n`;
    expect(scanSecrets(log(`${sha}\nmsg\n\n${empty}`), [])).toEqual([
      { where: "(name withheld)", line: 0, kind: "GitHub token" },
    ]);
  });
  it("finds a token used as an added file's name", () => {
    const out = scanSecrets(log(`${sha}\nmsg\n\n${diff(`d/${TOKEN}`, ["hi"])}`), []);
    expect(out).toEqual([{ where: "(name withheld)", line: 0, kind: "GitHub token" }]);
  });
  it("finds a token in the name of an empty added file (no hunk)", () => {
    const name = `${TOKEN}.empty`;
    const empty = `diff --git a/${name} b/${name}\nnew file mode 100644\nindex 0000000..e69de29\n`;
    expect(scanSecrets(log(`${sha}\nmsg\n\n${empty}`), [])).toEqual([
      { where: "(name withheld)", line: 0, kind: "GitHub token" },
    ]);
  });
  it("finds a token in a header-only file whose name git quotes", () => {
    const q = `"a/${TOKEN}\\303\\251.empty" "b/${TOKEN}\\303\\251.empty"`;
    const empty = `diff --git ${q}\nnew file mode 100644\nindex 0000000..e69de29\n`;
    expect(scanSecrets(log(`${sha}\nmsg\n\n${empty}`), [])).toEqual([
      { where: "(name withheld)", line: 0, kind: "GitHub token" },
    ]);
    const plain = `diff --git "a/x\\303\\251" "b/x\\303\\251"\nnew file mode 100644\nindex 0000000..e69de29\n`;
    expect(scanSecrets(log(`${sha}\nmsg\n\n${plain}`), [])).toEqual([]);
  });
  it("ignores a deleted file named like a token", () => {
    const name = `${TOKEN}.txt`;
    const gone = `diff --git a/${name} b/${name}\ndeleted file mode 100644\nindex e69de29..0000000\n`;
    expect(scanSecrets(log(`${sha}\nmsg\n\n${gone}`), [])).toEqual([]);
    const gone2 = `diff --git a/${name} b/${name}\ndeleted file mode 100644\nindex 1..0000000\n--- a/${name}\n+++ /dev/null\n@@ -1 +0,0 @@\n-hi\n`;
    expect(scanSecrets(log(`${sha}\nmsg\n\n${gone2}`), [])).toEqual([]);
  });
  it("ignores a removed line", () => {
    expect(scanSecrets(log(`${sha}\nmsg\n\n${diff("a.ts", ["ok"], [TOKEN])}`), [])).toEqual([]);
  });
  it("finds a token a merge resolution added (--remerge-diff), with the file and line", () => {
    const remerge = `diff --git a/a.ts b/a.ts\nremerge CONFLICT (content): Merge conflict in a.ts\nindex 1..2 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1 @@\n-<<<<<<< x\n-a\n-=======\n+x = "${TOKEN}"\n`;
    expect(scanSecrets(log(`${sha}\nmerge\n\n${remerge}`), [])).toEqual([
      { where: "a.ts", line: 1, kind: "GitHub token" },
    ]);
  });
  it("finds a token in a commit message", () => {
    const out = scanSecrets(log(`${sha}\nsubject\n\nbody ${TOKEN}\n`), []);
    expect(out).toEqual([{ where: "commit 1234567", line: 3, kind: "GitHub token" }]);
  });
  it("finds each pattern kind", () => {
    const lines = [
      `github_pat_${"a".repeat(60)}`,
      `sk-ant-${"a".repeat(24)}`,
      "AKIAABCDEFGHIJKLMNOP",
      "-----BEGIN RSA PRIVATE KEY-----",
      "xoxb-1234567890-abc",
    ];
    const kinds = scanSecrets(log(`${sha}\nm\n\n${diff("k", lines)}`), []).map((f) => f.kind);
    expect(kinds).toEqual([
      "GitHub token",
      "Anthropic key",
      "AWS access key",
      "private key",
      "Slack token",
    ]);
  });
  it("matches a known 40-character secret but not an 8-character one", () => {
    const known = "Zq9".repeat(13).slice(0, 40);
    const text = log(`${sha}\nm\n\n${diff("c", [`v=${known}`, "v=12345678"])}`);
    expect(scanSecrets(text, [known, "12345678"])).toEqual([
      { where: "c", line: 2, kind: "local credential" },
    ]);
  });
  it("reads quoted and /dev/null paths", () => {
    const quoted = `diff --git "a/sp ace.txt" "b/sp ace.txt"\n--- "a/sp ace.txt"\n+++ "b/sp ace.txt"\n@@ -0,0 +1 @@\n+${TOKEN}\n`;
    expect(scanSecrets(log(`${sha}\nm\n\n${quoted}`), [])).toEqual([
      { where: "sp ace.txt", line: 1, kind: "GitHub token" },
    ]);
    const octal = `diff --git "a/\\303\\251.txt" "b/\\303\\251.txt"\n--- /dev/null\n+++ "b/\\303\\251.txt"\n@@ -0,0 +1 @@\n+${TOKEN}\n`;
    expect(scanSecrets(log(`${sha}\nm\n\n${octal}`), [])[0]?.where).toBe("é.txt");
    const gone = `diff --git a/x b/x\ndeleted file mode 100644\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-${TOKEN}\n`;
    expect(scanSecrets(log(`${sha}\nm\n\n${gone}`), [])).toEqual([]);
  });
  it("counts hunks so an added line starting with ++ is still scanned", () => {
    const d = `diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -0,0 +1,2 @@\n+++ ${TOKEN}\n+ok\n@@ -9 +9 @@\n-a\n+b\n`;
    expect(scanSecrets(log(`${sha}\nm\n\n${d}`), [])).toEqual([
      { where: "f", line: 1, kind: "GitHub token" },
    ]);
  });
  it("never puts the match in a finding, even when the path is the secret", () => {
    const text = log(`${sha}\nm ${TOKEN}\n\n${diff(`${TOKEN}.txt`, [TOKEN])}`, `${sha}\nsubject\n`);
    const out = scanSecrets(text, [TOKEN]);
    expect(out.length).toBeGreaterThan(1);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });
  it("scans two commits independently", () => {
    const out = scanSecrets(log(`${sha}\nclean\n`, `${"f".repeat(40)}\nbad ${TOKEN}\n`), []);
    expect(out).toEqual([{ where: "commit fffffff", line: 1, kind: "GitHub token" }]);
  });
});

describe("scanText", () => {
  it("scans a PR title or body by line", () => {
    const out = scanText("PR body", `fine\nthen ${TOKEN}`, []);
    expect(out).toEqual([{ where: "PR body", line: 2, kind: "GitHub token" }]);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });
});

describe("guard fix round 1", () => {
  it("models redirections: they are neither separators nor arguments", () => {
    for (const c of [
      "pnpm -s vitest run 2>&1 | tail -20",
      "pnpm -s test 2>&1",
      "pnpm -s test > /tmp/o.txt",
      "pnpm -s test &> /tmp/o.txt",
      "pnpm -s test >> /tmp/o.txt 2>&1",
    ]) {
      expect(guardDecision(bash(c), writer).kind, c).toBe("lock");
    }
    expect(guardDecision(bash("pnpm -s vitest run 2>&1 | tail -20"), readOnly).kind).toBe("lock");
    expect(ruleOf(bash("git push>/dev/null"))).toBe("git-write");
    expect(ruleOf(bash("git push 2>&1"))).toBe("git-write");
    expect(splitCommands("git status 2>&1 >out.txt")).toEqual([["git", "status"]]);
  });

  it("names gh only in fixed vocabulary, never argv", () => {
    const v = guardDecision(
      bash('gh api -H "Authorization: token SECRETSECRET" -X POST repos/x'),
      writer,
    );
    expect(v).toEqual({
      kind: "deny",
      rule: "gh-cli",
      text: `${GUARD_RULES["gh-cli"]}: gh api`,
    });
    const t = (c: string) => (guardDecision(bash(c), writer) as { text: string }).text;
    expect(t("gh pr comment 1 -b SECRETSECRET")).toBe(`${GUARD_RULES["gh-cli"]}: gh pr comment`);
    expect(t("gh pr -R SECRETSECRET/x merge 1")).toBe(`${GUARD_RULES["gh-cli"]}: gh pr merge`);
    expect(t("gh SECRETSECRET thing")).not.toContain("SECRET");
    expect(t("gh pr SECRETSECRET")).not.toContain("SECRET");
  });

  it.each([
    "git stage .",
    "git send-pack origin x",
    "git credential fill",
    "git read-tree x",
    "git sparse-checkout set x",
    "git lfs push",
    "git --attr-source HEAD push",
    "git frobnicate",
  ])("git is an allow-list: denies %s", (c) => {
    expect(ruleOf(bash(c))).toBe("git-write");
  });
  it.each([
    "git rev-parse HEAD",
    "git ls-files",
    "git ls-tree HEAD",
    "git cat-file -p HEAD",
    "git blame x",
    "git grep x",
    "git describe",
    "git merge-base a b",
    "git rev-list HEAD",
    "git shortlog",
    "git for-each-ref",
    "git show-ref",
    "git name-rev HEAD",
    "git stash list",
    "git worktree list",
    "git remote -v",
    "git tag --list",
  ])("git allows %s", (c) => {
    expect(ruleOf(bash(c))).toBe("allow");
  });

  it.each([
    'bash -lc "git push"',
    'sh -ec "git push"',
    'bash -c -- "git push"',
    'zsh -l -c "git push"',
  ])("recurses into %s", (c) => {
    expect(ruleOf(bash(c))).toBe("git-write");
  });

  it("a suite with flag values or filters is still a full suite; a test path is not", () => {
    for (const c of [
      "pnpm -s vitest run --reporter dot",
      "pnpm -s test -- --reporter dot",
      'pnpm -s vitest run -t "name"',
    ]) {
      expect(guardDecision(bash(c), writer).kind, c).toBe("lock");
    }
    for (const c of [
      "pnpm -s vitest run apps/web/test/x.test.ts",
      "pnpm -s vitest run x.test.ts",
      "pnpm -s test foo.mjs",
    ]) {
      expect(guardDecision(bash(c), writer).kind, c).toBe("allow");
    }
    expect(isFullSuite(["pnpm", "-s", "vitest", "run", "--reporter", "dot"], FULL)).toBe(true);
  });
});

describe("guard fix round 2", () => {
  it.each([
    "git diff HEAD --output=/tmp/x",
    "git log --oneline --output /tmp/x",
    "git show HEAD --output=/tmp/x",
  ])("denies %s: --output writes a file", (c) => {
    expect(ruleOf(bash(c))).toBe("git-write");
  });

  it("a directory is not a test path; .mts and .cts files are", () => {
    for (const c of ["pnpm -s vitest run ./", "pnpm -s vitest run apps/", "pnpm -s vitest run ."]) {
      expect(guardDecision(bash(c), writer).kind, c).toBe("lock");
    }
    for (const c of ["pnpm -s vitest run x.test.mts", "pnpm -s vitest run x.cts"]) {
      expect(guardDecision(bash(c), writer).kind, c).toBe("allow");
    }
  });

  it.each(['sh -c -e "git push"', 'bash -lc -e -x "git push"'])(
    "takes the script after option words that follow -c: %s",
    (c) => {
      expect(ruleOf(bash(c))).toBe("git-write");
    },
  );
});

describe("guard fix round 3", () => {
  it.each(['bash -c -- "-x; git push"', 'sh -c -e "git push"'])("judges the script of %s", (c) => {
    expect(ruleOf(bash(c))).toBe("git-write");
  });
  it.each(["bash -c", "sh -c -e"])("fails closed on %s, which has no script to read", (c) => {
    expect(ruleOf(bash(c))).toBe("unreadable");
  });
  it("still allows a harmless -c script", () => {
    expect(ruleOf(bash('bash -c "echo ok"'))).toBe("allow");
    expect(ruleOf(bash('bash -c -- "echo ok"'))).toBe("allow");
  });
});

describe("guard fix round 4", () => {
  it.each([
    'bash -c -o pipefail "git push"',
    'bash -c +e "git push"',
    'bash -co pipefail "git push"',
  ])("denies a shell option that takes a value as unreadable: %s", (c) => {
    expect(ruleOf(bash(c))).toBe("unreadable");
  });
  it("judges the script after an option value before -c", () => {
    expect(ruleOf(bash('bash -O extglob -c "git push"'))).toBe("git-write");
  });
  it.each(['bash -c -o pipefail "echo ok"', 'bash -c +e "echo ok"', 'bash -co pipefail "echo ok"'])(
    "fails closed even on a harmless script: %s",
    (c) => {
      expect(ruleOf(bash(c))).toBe("unreadable");
    },
  );
  it("still allows a plain -c script", () => {
    expect(ruleOf(bash('bash -c "echo ok"'))).toBe("allow");
    expect(ruleOf(bash('bash -ec "echo ok"'))).toBe("allow");
  });
});

describe("guard fix round 5 (Task 5 review)", () => {
  it.each(["{ git push; }", "{ git push; } && ls", "ls && { git commit -m x; }"])(
    "unwraps a { } group: %s",
    (c) => {
      expect(ruleOf(bash(c))).toBe("git-write");
    },
  );
  it("locks a full suite inside a { } group", () => {
    expect(guardDecision(bash("{ pnpm -s test; }"), writer)).toEqual({
      kind: "lock",
      command: "pnpm -s test",
    });
  });
  it.each([
    "coproc pnpm -s test",
    "setsid pnpm -s test",
    "setsid -f pnpm -s vitest run",
    "coproc { pnpm -s test; }",
    "coproc SUITE { pnpm -s test; }",
  ])("denies %s (a background run) with the foreground text", (c) => {
    expect(guardDecision(bash(c), writer)).toEqual({
      kind: "deny",
      rule: "full-suite",
      text: BACKGROUND_SUITE_TEXT,
    });
  });
  it.each(["coproc git push", "setsid git push", "coproc NAME { git push; }"])(
    "denies %s as git-write",
    (c) => {
      expect(ruleOf(bash(c))).toBe("git-write");
    },
  );
  it("denies a background run that is not a suite", () => {
    expect(ruleOf(bash("setsid sleep 1"))).toBe("background");
  });
  it("names a git subcommand in the text only when it is a known one", () => {
    expect(guardDecision(bash("git SECRETX origin"), writer)).toEqual({
      kind: "deny",
      rule: "git-write",
      text: `${GUARD_RULES["git-write"]}: git`,
    });
    expect(guardDecision(bash("git -C /x send-pack origin"), writer)).toMatchObject({
      text: `${GUARD_RULES["git-write"]}: git send-pack`,
    });
    expect(guardDecision(bash("git diff --output=/tmp/x"), writer)).toMatchObject({
      text: `${GUARD_RULES["git-write"]}: git diff`,
    });
  });
});

describe("guard fix round 6 (Task 5 re-review): zsh groups, wrappers, brace expansion", () => {
  // Claude Code runs Bash commands as `/bin/zsh -c …`: zsh runs `{git push}` as `git push`
  it.each(["{git push; }", "{git push}", "{ git push }", "{git commit -m x;}"])(
    "denies the zsh group %s as git-write",
    (c) => {
      expect(ruleOf(bash(c))).toBe("git-write");
    },
  );
  it.each(["{pnpm -s test; }", "{pnpm -s test}"])("locks the zsh group %s", (c) => {
    expect(guardDecision(bash(c), writer)).toEqual({ kind: "lock", command: "pnpm -s test" });
  });
  it("strips a closing } that heads a segment", () => {
    expect(splitCommands("{ git status; }")).toEqual([["git", "status"]]);
  });

  it.each([
    "timeout 900 git push",
    "timeout -s KILL -k 5 900 git push",
    "timeout --signal=KILL 10m git push",
    "timeout --foreground 60 git push",
    "nice git push",
    "nice -n 10 git push",
    "nice -5 git push",
    "nohup git push",
    "stdbuf -o L git push",
    "stdbuf -oL -eL git push",
    "time -p git push",
    "env -i -u HOME A=1 git push",
    "env -C /tmp git push",
    "env -S 'git push'",
    "env --split-string='git push'",
    "command -p git push",
    "builtin command git push",
    "exec -a name git push",
    "noglob git push",
    "nocorrect git push",
    "repeat 3 git push",
    "xargs git push",
    "xargs -I {} -n 1 -P 4 git push",
    "xargs -0 -r git push",
    "sudo -u root git push",
    "nice -n 5 timeout 60 env A=1 git push",
  ])("looks through the wrapper in %s", (c) => {
    expect(ruleOf(bash(c))).toBe("git-write");
  });
  it.each([
    "timeout 900 pnpm -s test",
    "timeout -k 5 900 pnpm -s test",
    "nice -n 5 pnpm -s test",
    "env CI=1 pnpm -s test",
    "stdbuf -oL pnpm -s test",
    "repeat 2 pnpm -s test",
    "noglob pnpm -s test",
    "xargs -n 1 pnpm -s test",
  ])("locks the full suite in %s", (c) => {
    expect(guardDecision(bash(c), writer)).toEqual({ kind: "lock", command: "pnpm -s test" });
  });
  it.each(["timeout 900 git status", "nice -n 5 ls", "xargs -0 grep x", "repeat 3 echo ok"])(
    "allows a harmless wrapped command: %s",
    (c) => {
      expect(ruleOf(bash(c))).toBe("allow");
    },
  );

  it.each([
    "screen -dmS suite pnpm -s test",
    "screen pnpm -s test",
    "tmux new -d 'pnpm -s test'",
    "tmux new-session -d -s x pnpm -s test",
    "tmux new-window 'pnpm -s vitest run'",
  ])("denies %s (a background run) with the foreground text", (c) => {
    expect(guardDecision(bash(c), writer)).toEqual({
      kind: "deny",
      rule: "full-suite",
      text: BACKGROUND_SUITE_TEXT,
    });
  });
  it.each(["tmux new -d 'git push'", "screen -dm git push"])("denies %s as git-write", (c) => {
    expect(ruleOf(bash(c))).toBe("git-write");
  });

  it.each(["{git,push} origin", "{pnpm,-s,test}", "env {git,push}", "{a..z}"])(
    "denies a head word with brace expansion (%s), naming no input",
    (c) => {
      const v = guardDecision(bash(c), writer);
      expect(v).toEqual({
        kind: "deny",
        rule: "unreadable",
        text: `${GUARD_RULES.unreadable}: brace expansion`,
      });
    },
  );
  it("allows brace expansion in an argument", () => {
    expect(ruleOf(bash("echo {a,b}"))).toBe("allow");
  });

  it.each([
    ["coproc NAME if git push; then :; fi", "git-write"],
    ["coproc S until git push; do :; done", "git-write"],
    ["coproc S while pnpm -s test; do :; done", "full-suite"],
    ["coproc S if pnpm -s test; then :; fi", "full-suite"],
  ])("skips coproc's NAME before a compound keyword: %s", (c, rule) => {
    expect(ruleOf(bash(c))).toBe(rule);
  });
});

describe("guard fix round 7 (Task 5 re-review 2)", () => {
  const tooLong = { kind: "deny", rule: "unreadable", text: GUARD_TOO_LONG_TEXT };
  const timed = (c: string) => {
    const t0 = performance.now();
    const v = guardDecision(bash(c), writer);
    return { v, ms: performance.now() - t0 };
  };

  it("decides a 64 KB `screen a a …` line quickly, without throwing", () => {
    const { v, ms } = timed(`screen ${"a ".repeat(32 * 1024)}`);
    expect(ms).toBeLessThan(200);
    expect(v).toEqual(tooLong);
  });
  it.each([
    ["20 tmux words and a suite", `${"tmux ".repeat(20)}pnpm -s test`, "full-suite"],
    ["18 `tmux a` pairs and a push", `${"tmux a ".repeat(18)}git push`, "git-write"],
    // `tmux tmux …`: an unknown tmux command may start a session
    ["20 tmux words", "tmux ".repeat(20), "background"],
    ["300 tmux words", "tmux ".repeat(300), "background"],
    ["2000 tmux words", "tmux ".repeat(2000), "unreadable"], // past the budget: too long
  ])("decides %s quickly, without throwing", (_n, c, rule) => {
    const { v, ms } = timed(c);
    expect(ms).toBeLessThan(200);
    expect(v.kind === "deny" ? v.rule : v.kind).toBe(rule);
  });
  it.each([
    ["an unclosed brace of commas", `{${",".repeat(60_000)} x`],
    ["a long -c cluster", `bash -${"c".repeat(60_000)}1 x`],
    ["a long -o cluster", `bash -${"o".repeat(60_000)}1 -c x`],
    ["a wall of opening braces", `${"{".repeat(60_000)}git push`],
  ])("decides %s quickly (no super-linear matching)", (_n, c) => {
    const { ms } = timed(c);
    expect(ms).toBeLessThan(200);
  });
  it("denies a line past the work budget with the too-long text", () => {
    expect(guardDecision(bash(`tmux new -d ${"x ".repeat(2000)}`), writer)).toEqual(tooLong);
  });
  it("keeps a long ordinary command within the budget", () => {
    const { v, ms } = timed(`echo ${"a ".repeat(30 * 1024)}`);
    expect(v).toEqual({ kind: "allow" });
    expect(ms).toBeLessThan(200);
  });
  it("decides deeply nested shell scripts without throwing", () => {
    let c = "git push";
    for (let i = 0; i < 40; i++) c = `eval ${c}`;
    expect(() => guardDecision(bash(c), writer)).not.toThrow();
    // past MAX_DEPTH (well inside the word budget): too long, not the git-write of `git push`
    expect(guardDecision(bash(c), writer)).toEqual(tooLong);
  });

  it.each(["{ git branch }", "{git remote -v}", "{ git remote -v }", "git log --format='%H}'"])(
    "allows the read %s",
    (c) => {
      expect(ruleOf(bash(c))).toBe("allow");
    },
  );
  it("drops every standalone unquoted }, and keeps a quoted one", () => {
    expect(splitCommands("{ git status } ; ls }")).toEqual([["git", "status"], ["ls"]]);
    expect(splitCommands("echo '}' \"}\"")).toEqual([["echo", "}", "}"]]);
  });

  it.each([
    "/usr/bin/env git push",
    "/usr/bin/env bash -c 'git push'",
    "/usr/bin/nice git push",
    "/usr/bin/xargs git push",
    "/usr/bin/screen -dm git push",
  ])("looks through the wrapper given by path: %s", (c) => {
    expect(ruleOf(bash(c))).toBe("git-write");
  });
  it("locks a suite under a wrapper given by path", () => {
    expect(guardDecision(bash("/usr/bin/time -p pnpm -s test"), writer)).toEqual({
      kind: "lock",
      command: "pnpm -s test",
    });
  });
  it.each(["/usr/bin/nohup pnpm -s test &", "/opt/homebrew/bin/tmux new -d 'pnpm -s test'"])(
    "denies the background run %s with the foreground text",
    (c) => {
      expect(guardDecision(bash(c), writer)).toEqual({
        kind: "deny",
        rule: "full-suite",
        text: BACKGROUND_SUITE_TEXT,
      });
    },
  );

  it.each([
    "find . -exec git push ;",
    "find . -name x -exec git add {} +",
    "find . -execdir git commit -m x ';'",
    "find . -ok git push ;",
  ])("judges the command find runs: %s", (c) => {
    expect(ruleOf(bash(c))).toBe("git-write");
  });
  it("allows a harmless find -exec", () => {
    expect(ruleOf(bash("find . -name '*.ts' -exec grep -l foo {} +"))).toBe("allow");
  });

  it("treats env's lone - as an option (-i), not the command", () => {
    expect(ruleOf(bash("env - git push"))).toBe("git-write");
    expect(ruleOf(bash("env - A=1 git push"))).toBe("git-write");
  });
  it("takes the word after -- as the command, even one that looks like an option", () => {
    // env runs a program named -S: no script is split from it
    expect(ruleOf(bash("env -- -S 'git push'"))).toBe("allow");
  });
  it("does not take Object.prototype names for wrappers", () => {
    expect(ruleOf(bash("toString git push"))).toBe("allow");
    expect(() => guardDecision(bash("hasOwnProperty -x git push"), writer)).not.toThrow();
  });

  it.each(["tmux ls && pnpm -s test", "tmux ls; pnpm -s vitest run"])(
    "marks only the multiplexer's command as background: %s",
    (c) => {
      expect(ruleOf(bash(c))).toBe("lock");
    },
  );
  it("still denies the suite a multiplexer runs", () => {
    expect(ruleOf(bash("tmux new -d 'pnpm -s test'"))).toBe("full-suite");
    expect(ruleOf(bash("coproc pnpm -s test; ls"))).toBe("full-suite");
  });
});

describe("guard fix round 8 (Task 5 re-review 3): quoting, heredocs, nested multiplexers", () => {
  const tooLong = { kind: "deny", rule: "unreadable", text: GUARD_TOO_LONG_TEXT };
  const background = { kind: "deny", rule: "full-suite", text: BACKGROUND_SUITE_TEXT };
  const timed = (c: string) => {
    const t0 = performance.now();
    const v = guardDecision(bash(c), writer);
    return { v, ms: performance.now() - t0 };
  };

  // Important 1: only an unquoted head word brace-expands
  it.each([
    "tmux ls -F '#{?session_attached,attached,detached}'",
    "tmux display -p '#{?pane_active,x,y}'",
    "tmux list-panes -F '#{pane_id} #{?pane_active,*,}'",
    "tmux display -p '#{e|+:1,2}'",
    "tmux send-keys -t x 'ls {a,b}' Enter",
    "'{git,push}' origin",
    '"{a..z}"',
    "\\{git,push} origin",
  ])("allows the quoted braces in %s", (c) => {
    expect(ruleOf(bash(c))).toBe("allow");
  });
  it("denies a detached tmux command even when its quoted argument contains braces", () => {
    expect(ruleOf(bash("tmux new -d 'ls {a,b}'"))).toBe("background");
  });
  it.each(["{git,'push'} origin", "tmux {git,push}", "tmux new -d '{git,push} origin'"])(
    "still denies the unquoted brace expansion in %s",
    (c) => {
      expect(guardDecision(bash(c), writer)).toEqual({
        kind: "deny",
        rule: "unreadable",
        text: `${GUARD_RULES.unreadable}: brace expansion`,
      });
    },
  );

  // Important 2: a heredoc body is data
  it.each([
    [
      "cat > /tmp/body.md <<'EOF'\nThis doesn't change the API.\nEOF\ngh pr create --title x --body-file /tmp/body.md",
      "gh-cli",
    ],
    [
      "cat > notes.md <<'EOF'\nIt's done\nEOF\ngit add notes.md && git commit -m notes",
      "git-write",
    ],
    ["cat > notes.md <<'EOF'\nIt's done\nEOF\npnpm -s test", "lock"],
    ['cat > notes.md <<"EOF"\nIt\'s done\nEOF\ngit push', "git-write"],
    ["cat > notes.md <<\\EOF\nIt's done\nEOF\ngit push", "git-write"],
    ["cat > notes.md <<EOF\nIt's done\nEOF\ngit push", "git-write"],
    ["cat > notes.md << 'EOF'\nIt's done\nEOF\ngit push", "git-write"],
    ["cat > notes.md <<$'EOF'\nIt's done\nEOF\ngit push", "git-write"],
    ["cat > notes.md <<-'EOF'\n\tIt's done\n\t\tEOF\ngit push", "git-write"],
    ["cat <<'A' <<'B'\nit's\nA\nit's\nB\ngit push", "git-write"],
    ["cat <<'A'; cat <<'B'\nit's\nA\nit's\nB\ngit push", "git-write"],
    ["cat <<'EOF' # it's a note\nit's\nEOF\ngit push", "git-write"],
    ["x=$(cat <<'EOF'\nIt's done\nEOF\n)\ngit push", "git-write"],
    ["bash -c \"cat <<'EOF'\nIt's done\nEOF\ngit push\"", "git-write"],
    ['cat <<< "it\'s" && git push', "git-write"],
    ["echo $((1<<2))\ngit push", "git-write"],
    ["(( x <<= 1 ))\ngit push", "git-write"],
  ])("judges what follows a heredoc: %j", (c, rule) => {
    expect(ruleOf(bash(c))).toBe(rule);
  });
  it.each([
    "cat > a.md <<'EOF'\ngit push origin main\nEOF",
    "cat > a.md <<EOF\ngit push origin main\nEOF",
    "cat > a.md <<-EOF\n\tgit push origin main\n\tEOF",
    "cat > a.md <<'EOF'\ngit push origin main\nEOF\nls",
    "cat > a.md <<'EOF'\nrun `git push` and $(git push)\nEOF",
    "cat > a.md <<EOF\nrun \\`git push\\` and \\$(git push)\nEOF",
    "cat > a.md <<'EOF'\nEOF not yet\n EOF\nEOFX\ngit push\nEOF",
    "bash -c 'cat > a.md <<EOF\ngit push\nEOF'",
  ])("never judges a heredoc body as commands: %j", (c) => {
    expect(ruleOf(bash(c))).toBe("allow");
  });
  it.each([
    "cat > a.md <<EOF\nrun `git push` now\nEOF",
    "cat > a.md <<EOF\nrun $(git push) now\nEOF",
    "cat > a.md <<EOF\n$(echo $(git push))\nEOF",
  ])("judges the command substitutions of an unquoted heredoc body: %j", (c) => {
    expect(ruleOf(bash(c))).toBe("git-write");
  });
  it("splits around a heredoc", () => {
    expect(splitCommands("cat <<'EOF' > a.md\nit's\nEOF\nls -la")).toEqual([
      ["cat"],
      ["ls", "-la"],
    ]);
    expect(splitCommands("cat <<< 'x y'")).toEqual([["cat"]]);
  });

  // M1: a multiplexer inside a multiplexer's command line
  it.each([
    'tmux new -d "screen -dm git push"',
    "tmux new -d \"tmux new -d 'git push'\"",
    "screen -dm sh -c \"tmux new -d 'pnpm -s test'\"",
    'tmux new -d "tmux ls"',
  ])("denies the nested multiplexer %s without looking into it", (c) => {
    expect(guardDecision(bash(c), writer)).toEqual(tooLong);
  });

  // M3, M4, M5
  it("denies a suite in an env -S script under coproc as background", () => {
    expect(guardDecision(bash("coproc env -S 'pnpm -s test'"), writer)).toEqual(background);
  });
  it("keeps a parameter expansion inside its word", () => {
    const v = "$" + "{WT}";
    expect(splitCommands(`git -C ${v} status`)).toEqual([["git", "-C", v, "status"]]);
    expect(splitCommands(`git -C ${v}} status`)).toEqual([["git", "-C", v, "status"]]);
  });
  it.each([
    ["echo $'it\\'s' && git push", "git-write"],
    ["echo $'a\\\\' && git push", "git-write"],
    ["$'git' push", "git-write"],
    ["echo $'it\\'s; git push'", "allow"],
    ['echo "$\'" && git push', "git-write"],
  ])("reads ANSI-C quoting: %s", (c, rule) => {
    expect(ruleOf(bash(c))).toBe(rule);
  });
  it("decodes ANSI-C escapes in a word", () => {
    expect(splitCommands("printf $'a\\tb\\n' $'it\\'s'")).toEqual([["printf", "a\tb\n", "it's"]]);
  });

  // timing: linear, inside the budget
  it("decides a 64 KB heredoc body quickly", () => {
    const body = "It's a line with `git push` and $(git push) and 'quotes\n".repeat(1200);
    expect(body.length).toBeGreaterThan(64 * 1024);
    const quoted = timed(`cat > a.md <<'EOF'\n${body}EOF\ngit push`);
    expect(quoted.ms).toBeLessThan(200);
    expect(quoted.v.kind === "deny" && quoted.v.rule).toBe("git-write");
    const open = timed(`cat > a.md <<'EOF'\n${body}`);
    expect(open.ms).toBeLessThan(200);
    // round 5: an unterminated heredoc cannot be read
    expect(open.v).toEqual({ kind: "deny", rule: "unreadable", text: GUARD_UNREADABLE_TEXT });
    const unquoted = timed(`cat > a.md <<EOF\n${body.replaceAll("git push", "ls")}EOF`);
    expect(unquoted.ms).toBeLessThan(200);
    expect(unquoted.v.kind).toBe("allow");
  });
  it.each([
    [
      "2000 heredocs, each with its body",
      `cat${" <<E".repeat(2000)}\n${"E\n".repeat(2000)}git push`,
    ],
    ["2000 heredocs with no body", `cat${" <<E".repeat(2000)}\ngit push`],
    ["2000 bare <<", `cat ${"<< ".repeat(2000)}x`],
    ["2000 <<- with no delimiter line", `cat${" <<-'E'".repeat(2000)}\n\tE`],
  ])("decides %s quickly, without throwing", (_n, c) => {
    const { ms } = timed(c);
    expect(ms).toBeLessThan(200);
  });
  it("judges what follows 2000 heredocs on one line", () => {
    expect(ruleOf(bash(`cat${" <<E".repeat(2000)}\n${"E\n".repeat(2000)}git push`))).toBe(
      "git-write",
    );
    // round 5: the last heredoc has no delimiter line, so the line cannot be read
    expect(
      guardDecision(bash(`cat${" <<E".repeat(2000)}\n${"E\n".repeat(1999)}git push`), writer),
    ).toEqual({ kind: "deny", rule: "unreadable", text: GUARD_UNREADABLE_TEXT });
  });
});

describe("guard fix round 9 (Task 5 re-review 4): stdin shells, substitutions, the backstop", () => {
  // shell text: `${` opens the shell's parameter expansion, not a template placeholder
  const P = "$" + "{";
  const unreadable = { kind: "deny", rule: "unreadable", text: GUARD_UNREADABLE_TEXT };
  const tooLong = { kind: "deny", rule: "unreadable", text: GUARD_TOO_LONG_TEXT };
  const timed = (c: string) => {
    const t0 = performance.now();
    const v = guardDecision(bash(c), writer);
    return { v, ms: performance.now() - t0 };
  };

  // A: a heredoc a shell reads is a command line; a bare shell after a pipe cannot be read
  it.each([
    ["bash <<'EOF'\ngit push\nEOF", "git-write"],
    ["sh <<'EOF'\nset -e\npnpm -s test\nEOF", "lock"],
    ["zsh <<EOF\ngit push origin main\nEOF", "git-write"],
    ["bash -s <<'EOF'\ngit push\nEOF", "git-write"],
    ["bash -s arg1 arg2 <<'EOF'\ngit push\nEOF", "git-write"],
    ["bash -es x <<'EOF'\ngit push\nEOF", "git-write"],
    ["bash -- /dev/stdin <<'EOF'\ngit push\nEOF", "git-write"],
    ["bash - arg1 <<'EOF'\ngit push\nEOF", "git-write"],
    ["cat <<'EOF' | sh\ngit push\nEOF", "unreadable"],
    ["dash <<'EOF'\ngit push\nEOF", "git-write"],
    ["/bin/bash -e <<'EOF'\ngit push\nEOF", "git-write"],
    ["env FOO=1 bash -o pipefail <<'EOF'\ngit push\nEOF", "git-write"],
    ["bash -- <<'EOF'\ngit push\nEOF", "git-write"],
    ["bash - <<'EOF'\ngit push\nEOF", "git-write"],
    ["bash /dev/stdin <<'EOF'\ngit push\nEOF", "git-write"],
    ["source /dev/stdin <<'EOF'\ngit push\nEOF", "git-write"],
    [". /dev/stdin <<'EOF'\ngit push\nEOF", "git-write"],
    ["bash <<< 'git push'", "git-write"],
    ["echo 'git push' | sh", "unreadable"],
    ["echo x | bash -s", "unreadable"],
    ["echo x | bash -s foo", "unreadable"],
    ["cat x | zsh -e", "unreadable"],
    ["cat x |& bash", "unreadable"],
    ["cat x | source /dev/stdin", "unreadable"],
  ])("judges what a shell reads on stdin: %j", (c, rule) => {
    expect(ruleOf(bash(c))).toBe(rule);
  });
  it("names the stdin shell in the deny, never the input", () => {
    expect(guardDecision(bash("echo SECRETSECRET | sh"), writer)).toEqual({
      kind: "deny",
      rule: "unreadable",
      text: `${GUARD_RULES.unreadable}: shell reading stdin`,
    });
  });
  it.each([
    "bash <<'EOF'\necho it is fine\nEOF",
    "bash scripts/check.sh <<'EOF'\ngit push\nEOF",
    "bash -c 'cat' <<'EOF'\ngit push\nEOF",
    "echo x | bash --version",
    "echo x | sh --help",
    "echo x | bash -c 'cat'",
    "echo x | bash scripts/check.sh",
    "ls | xargs sh",
    "bash",
    "cat <<'EOF' | jq .\n{\"a\": 1}\nEOF",
  ])("allows a shell that does not run its stdin as commands: %j", (c) => {
    expect(ruleOf(bash(c))).toBe("allow");
  });

  // B: one substitution scanner, unquoted, in "…" and in unquoted heredoc bodies
  it.each([
    ['out="$(pnpm -s test 2>&1)"; echo "$out"', "lock"],
    ['echo "$(git push)"', "git-write"],
    ['echo "result: $(pnpm -s test)"', "lock"],
    ['node -e "$(cat <<\'EOF\'\nconsole.log("it\'s")\nEOF\n)"; pnpm -s test', "lock"],
    ['python3 -c "$(cat <<\'EOF\'\nprint("it\'s done")\nEOF\n)" && git push', "git-write"],
    [
      'gh pr view 1 --json body -q "$(cat <<\'EOF\'\n.body + "it\'s"\nEOF\n)" && git push',
      "git-write",
    ],
    ['echo "$(cat <<\'EOF\'\nsay "hi\nEOF\n)" ; git push', "git-write"],
    ['cat <<EOF\nrun $(echo ")" ; git push)\nEOF', "git-write"],
    ['echo "`git push`"', "git-write"],
    ['echo "a $(echo "b $(git push)")"', "git-write"],
    ["echo `echo \\`git push\\``", "git-write"],
    [`x="${P}y:-$(git push)}"`, "git-write"],
    ["echo $(echo ')' ; git push)", "git-write"],
    ["echo $( (git push) )", "git-write"],
  ])("judges the substitution in %j", (c, rule) => {
    expect(ruleOf(bash(c))).toBe(rule);
  });
  it.each([
    "printf '%s\\n' \"$(git rev-parse HEAD)\"",
    'echo "n=$((1<<2))"',
    'echo "\\$(git push)"',
    "echo '$(git push)'",
    "echo \"it's $(date +%s) o'clock\"",
  ])("allows %j", (c) => {
    expect(ruleOf(bash(c))).toBe("allow");
  });

  // security bot: zsh arithmetic and parameter flags; a backslash-newline in a delimiter
  // the full verdict: the unreadable deny is git-write too, so the rule alone would not tell
  const pushDeny = {
    kind: "deny",
    rule: "git-write",
    text: `${GUARD_RULES["git-write"]}: git push`,
  };
  it.each([
    "echo $[1<<2]\ngit push",
    "echo $[ a[1] << 2 ]\ngit push",
    `x="a<<b"; echo ${P}(s:<<:)x}\ngit push`,
    "cat > a.md <<E\\\nOF\nIt's\nEOF\ngit push",
  ])("never reads a heredoc there, and judges what follows: %j", (c) => {
    expect(guardDecision(bash(c), writer)).toEqual(pushDeny);
  });
  it("continues a delimiter over a backslash-newline", () => {
    expect(ruleOf(bash("cat > a.md <<E\\\nOF\nIt's\nEOF"))).toBe("allow");
  });

  // the backstop: a state left open at the end of the input denies the whole call
  it.each([
    ["an open single quote", "echo 'it\ngit push"],
    ["an apostrophe in an unquoted word", "echo it's done && ls"],
    ["an open double quote", 'echo "abc\ngit push'],
    ["an open ANSI-C quote", "echo $'abc\ngit push"],
    ["an unclosed $(", "echo $(git status\nls"],
    ["an unclosed $( in a double quote", 'echo "$(git status"'],
    ["an unclosed backtick", "echo `ls\nls"],
    ["an unclosed ${", "echo ${x\nls"],
    ["an unterminated heredoc", "cat > a.md <<'EOF'\ngit push origin main"],
    ["a heredoc with no body", "cat <<EOF"],
    ["an unterminated heredoc in $( )", "x=$(cat <<'EOF'\nabc\n)"],
    ["an unclosed $((", "echo $((1+2)\nls"],
    ["an unclosed ((", "(( x = 1\nls"],
    ["an unclosed $[", "echo $[1+2\nls"],
    ["an unclosed (", "(cd x && ls"],
    ["a delimiter with a newline in it", "cat <<'E\nF'\nbody\nE\nF\nls"],
    ["an unclosed delimiter quote", "cat <<'EOF\nbody\nEOF"],
    ["an open quote in an unquoted heredoc's substitution", "cat <<EOF\n$(echo 'x)\nEOF"],
    ["an open quote in a sh -c script", 'bash -c "echo \'x"'],
    ["an open quote in a heredoc a shell reads", "bash <<'EOF'\necho 'x\nEOF"],
    ["an unclosed backtick in a double quote", 'echo "`ls"'],
    ["a mismatched closer", "echo $[1)\nls"],
    ["a mismatched closer in $( )", "echo $(echo $[1))"],
  ])("denies %s as unreadable", (_n, c) => {
    expect(guardDecision(bash(c), writer)).toEqual(unreadable);
  });
  it("has its own deny text", () => {
    expect(GUARD_UNREADABLE_TEXT).not.toBe(GUARD_TOO_LONG_TEXT);
    expect(GUARD_UNREADABLE_TEXT).toMatch(/could not read/);
  });

  // timing: linear, inside the budget and the depth
  it('decides 64 KB of nested "$( "$( … ) )" quickly', () => {
    const n = 64 * 1024;
    const deep = `echo ${'"$( echo '.repeat(n / 10)}x${' )"'.repeat(n / 10)}`;
    expect(deep.length).toBeGreaterThan(n);
    const { v, ms } = timed(deep);
    expect(ms).toBeLessThan(200);
    expect(v).toEqual(tooLong);
  });
  it("decides 64 KB of nested $( without throwing (no unbounded recursion)", () => {
    const { v, ms } = timed(`echo ${"$(".repeat(32 * 1024)}`);
    expect(ms).toBeLessThan(200);
    expect(v).toEqual(tooLong);
  });
  it("decides 40 nested shell heredocs without throwing", () => {
    let c = "git push";
    for (let i = 0; i < 40; i++) c = `bash <<'E${i}'\n${c}\nE${i}`;
    expect(timed(c).v).toEqual(tooLong);
  });
  it('decides 64 KB of side-by-side "$( … )" quickly', () => {
    const wide = `echo ${'"$(echo a) $(date)" '.repeat(3300)}`;
    expect(wide.length).toBeGreaterThan(64 * 1024);
    const { v, ms } = timed(wide);
    expect(ms).toBeLessThan(200);
    expect(v).toEqual({ kind: "allow" });
  });
  it.each([
    ["an unterminated double quote holding $(", `echo "${"$(echo a) x ".repeat(6000)}`],
    ["an unterminated double quote holding an unclosed $(", `echo "$(${"echo a; ".repeat(9000)}`],
    ["64 KB of $[", `echo ${"$[".repeat(32 * 1024)}`],
    ["64 KB of ${", `echo ${"${".repeat(32 * 1024)}`],
    ["64 KB of backticks", `echo ${"`".repeat(64 * 1024 + 1)}`],
  ])("decides %s quickly, as unreadable", (_n, c) => {
    expect(c.length).toBeGreaterThan(64 * 1024);
    const { v, ms } = timed(c);
    expect(ms).toBeLessThan(200);
    expect(v).toEqual(unreadable);
  });
  it("decides a 64 KB heredoc a shell reads quickly", () => {
    const body = "echo it is a line of text, harmless\n".repeat(1900);
    expect(body.length).toBeGreaterThan(64 * 1024);
    const { v, ms } = timed(`bash <<'EOF'\n${body}git push\nEOF`);
    expect(ms).toBeLessThan(200);
    expect(v.kind === "deny" && v.rule).toBe("git-write");
  });

  // the usual commit and PR spellings are read: their own deny, never the unreadable one
  it.each([
    [
      "git commit -m \"$(cat <<'EOF'\nfix: it's done\n\nCo-Authored-By: X <x@y>\nEOF\n)\"",
      `${GUARD_RULES["git-write"]}: git commit`,
    ],
    [
      'gh pr create --title "x" --body "$(cat <<\'EOF\'\n## Summary\n- it\'s "done"\nEOF\n)"',
      `${GUARD_RULES["gh-cli"]}: gh pr create`,
    ],
    [
      "git add -A && git commit -F - <<'EOF'\nfix: it's done\nEOF",
      `${GUARD_RULES["git-write"]}: git add`,
    ],
  ])("reads %j", (c, text) => {
    const v = guardDecision(bash(c), writer);
    expect(v.kind === "deny" && v.text).toBe(text);
  });

  // false-deny sweep: everyday reads stay allowed
  it.each([
    "cat > notes.md <<'EOF'\n# Notes\nIt's done; see `git log` and $(pwd).\nEOF",
    "cat <<'EOF' > /tmp/body.md\nThis doesn't change the API.\nEOF",
    "cat > a.md <<EOF\nHello $USER, it's $(date +%Y)\nEOF",
    "cat <<-EOF\n\tindented\n\tEOF",
    'cat <<\'EOF\' | jq -r .a\n{"a": "it\'s"}\nEOF',
    'echo "it\'s"',
    "printf '%s\\n' \"$(git rev-parse HEAD)\"",
    'test -n "$(git status --porcelain)" && echo dirty',
    "wc -l $(git ls-files '*.ts')",
    "x=$(date +%s); echo $x",
    "echo `date`",
    "jq '.a'",
    "jq -r '.items[] | select(.x == \"y\") | .name' f.json",
    "jq --arg v \"$V\" '.[] | select(.id == $v)' f.json",
    "awk '{print $1}' f.txt",
    "awk -F: '{ if ($3 > 100) print $1 }' /etc/passwd",
    "awk 'BEGIN { n = 1 << 2; print n }'",
    "sed -n '1,20p' f.txt",
    "sed -i '' 's/a/b/g' f.txt",
    "perl -ne 'print if /it\\x27s/' f.txt",
    'grep -rn "foo(" src',
    "rg -n 'a|b' src",
    "find . -name '*.ts' -not -path './node_modules/*'",
    "ls -la | head -20",
    "git log --oneline -5",
    "git diff --stat origin/main...HEAD",
    "git show HEAD:package.json | jq .version",
    "git status --porcelain | wc -l",
    "git log --format='%h %s' -3",
    "gh pr view 1 --json title,body",
    "gh pr checks 1",
    "gh api repos/x/y/pulls/1/comments",
    "tmux ls -F '#{session_name}'",
    "tmux ls -F '#{?session_attached,attached,detached}'",
    "tmux list-panes -F '#{pane_id} #{?pane_active,*,}'",
    "tmux display -p '#{e|+:1,2}'",
    "tmux capture-pane -p -t x | tail -5",
    'echo "n=$((1<<2))"',
    "echo $(( 1 + 2 ))",
    "echo $[1+2]",
    `echo "${P}x:-default}"`,
    `echo ${P}HOME}/x`,
    `arr=(a b c); echo "${P}arr[@]}" "${P}#arr[@]}"`,
    'for f in *.ts; do echo "$f"; done',
    "if [ -f x ]; then cat x; fi",
    'while read -r l; do echo "$l"; done < f.txt',
    'case "$x" in a) echo a;; b|c) echo bc;; esac',
    "case $x in (a) echo a;; esac",
    '[[ "$a" < "$b" ]] && echo lt',
    "diff <(sort a) <(sort b)",
    "echo $'a\\tb'",
    "echo '# not a comment'",
    "ls # a comment with it's apostrophe",
    "echo hi >&2; ls 2>/dev/null || true",
    "sleep 1; echo done",
    "node -e 'console.log(1)'",
    "python3 -c \"print('hi')\"",
    "sqlite3 x.db \"select count(*) from t where a = 'b'\"",
    "ps -p 123 -o pid,command",
    "lsof -i :7431",
    "pnpm -s vitest run packages/core/test/guard.test.ts",
    "pnpm -s lint",
    "node --version && bash --version",
    "sh -c 'echo ok'",
    "bash scripts/check.sh",
    "echo a | bash -c 'cat'",
    "cat x | grep -v '^#'",
    'echo "a)b" "(x"',
    "echo \\(x\\)",
    "git stash list",
    'echo "it\'s $(echo "nested \'q\'")"',
    "tmux send-keys -t x 'ls {a,b}' Enter",
  ])("allows the ordinary read %j, and refuses gh as gh-cli", (c) => {
    expect(ruleOf(bash(c))).toBe(c.startsWith("gh ") ? "gh-cli" : "allow");
  });
});

describe("guard targeted fix (Task 5 r5 I1): $(( that is a subshell, case in a substitution", () => {
  it.each([
    ['out="$((cd packages/core && pnpm -s test) 2>&1)"; echo "$out"', "lock"],
    ['out="$((cd packages/core && git push) 2>&1)"', "git-write"],
    ["cat > log.txt <<EOF\n$((cd packages/core && pnpm -s test) 2>&1)\nEOF", "lock"],
    ['echo "$((1<<2)) $((git push) )"', "git-write"],
    ['echo "n=$((1<<2))"', "allow"],
    ["cat <<EOF\nTotal: $((1 + 2)) items\nEOF", "allow"],
    ['x="$( (cd x && ls) 2>&1 )"', "allow"],
    ['echo "$(( $(git push) + 1 ))"', "git-write"],
    ['echo "$(( (1 + 2) * 3 ))"', "allow"],
    ['echo "$((git + push))"', "allow"],
    ["cat <<EOF\n$((git + push))\nEOF", "allow"],
    ['echo "$(( (1 + 2)))"', "allow"],
    ["cat <<EOF\n$((git push) )\nEOF", "git-write"],
    ['x="$(case $y in *) git push;; esac)"', "git-write"],
    ['x="$(case $y in a) echo "it\'s";; esac)"', "allow"],
    ['x="$(if true; then case $y in a) git push;; esac; fi)"', "git-write"],
    ["x=$(case $y in a) echo a;; esac); git push", "git-write"],
    ['x="$(echo case)"; ls', "allow"],
    ['x="$(git log --grep case --oneline)"', "allow"],
  ])("reads %j", (c, rule) => {
    expect(ruleOf(bash(c))).toBe(rule);
  });
  it.each(['echo "$((cd x && ls)"', "cat <<EOF\n$((1 + 2)\nEOF"])(
    "denies the unclosed %j as unreadable",
    (c) => {
      expect(guardDecision(bash(c), writer)).toEqual({
        kind: "deny",
        rule: "unreadable",
        text: GUARD_UNREADABLE_TEXT,
      });
    },
  );
  it('decides 64 KB of "$((" quickly', () => {
    const c = `echo "${"$((1+".repeat(16 * 1024)}"`;
    const t0 = performance.now();
    const v = guardDecision(bash(c), writer);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(v.kind).toBe("deny");
  });
  it('decides 64 KB of side-by-side "$(( ))" quickly', () => {
    const c = `echo "${"$((1+2)) ".repeat(8 * 1024)}"`;
    const t0 = performance.now();
    const v = guardDecision(bash(c), writer);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(v).toEqual({ kind: "allow" });
  });
});

describe("guard targeted fix 2 (security bot on faa3aa5): case at any position in a substitution", () => {
  const unreadable = { kind: "deny", rule: "unreadable", text: GUARD_UNREADABLE_TEXT };
  it.each([
    'x="$(time case $y in *) git push;; esac)"',
    'x="$(coproc case $y in *) git push;; esac)"',
    'x="$(nohup case $y in *) git push;; esac)"',
    'x="$(env case $y in *) git push;; esac)"',
    'x="$(case $y\nin *) git push;; esac)"',
    'x="$(time case $y in a) echo esac;; *) git push;; esac)"',
  ])("denies %j as git-write", (c) => {
    expect(ruleOf(bash(c))).toBe("git-write");
  });
  it.each([
    'x="$(case $y in a) echo "it\'s";; esac)"',
    'echo "$(git rev-parse HEAD)"',
    'x="$(echo case)"',
    'x="$(echo "case" a b)"',
    "x=\"$(echo 'case' in it)\"",
    'x="$(git log --grep case --oneline)"',
    'x="$(echo case in)" && ls',
  ])("allows %j", (c) => {
    expect(ruleOf(bash(c))).toBe("allow");
  });
  it.each([
    'x="$(echo case a b)"',
    'x="$(echo case a b c)" && ls',
    'x="$(case $y { *) git push;; })"',
  ])("denies the over-counted %j as unreadable (fail closed)", (c) => {
    expect(guardDecision(bash(c), writer)).toEqual(unreadable);
  });
  it("decides 64 KB of case words in a substitution quickly", () => {
    const c = `x="$(${"case ".repeat(13 * 1024)})"`;
    expect(c.length).toBeGreaterThan(64 * 1024);
    const t0 = performance.now();
    const v = guardDecision(bash(c), writer);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(v.kind).toBe("deny");
  });
});

describe("guard targeted fix 3 (Plan 7a review): vitest arguments after --", () => {
  // vitest's CLI parser puts everything after `--` in options["--"], never in the file filters:
  // the whole suite runs
  it.each([
    "pnpm -s vitest run -- x.test.ts",
    "pnpm -s vitest run -- ",
    "pnpm -s vitest run --",
    "pnpm -s vitest -- x.test.ts",
    "pnpm -s vitest run x.test.ts -- y.test.ts",
    "pnpm -s vitest run --project web",
    "pnpm -s vitest run",
  ])("locks %j as a full suite", (c) => {
    expect(guardDecision(bash(c), writer).kind).toBe("lock");
  });
  it.each([
    "pnpm -s vitest run x.test.ts",
    "pnpm -s vitest run a.test.ts b.test.ts",
    "pnpm -s vitest run --project web x.test.ts",
    "pnpm -s vitest packages/core/test/guard.test.ts",
  ])("allows the file run %j", (c) => {
    expect(ruleOf(bash(c))).toBe("allow");
  });
  describe("a repo's own suite command", () => {
    const py: GuardContext = {
      mode: "writer",
      repo: "dev",
      flightPowers: "standard",
      fullSuite: ["uv run pytest"],
    };
    it.each([
      "uv run pytest tests/unit",
      "uv run pytest ./tests",
      "pnpm -s vitest run apps/web",
      "uv run pytest tests/unit tests/x.py",
      "uv run pytest . x.py",
      "pnpm -s vitest run apps/web x.test.ts",
    ])("locks the folder run %j", (c) => {
      expect(guardDecision(bash(c), c.startsWith("uv") ? py : writer).kind).toBe("lock");
    });
    it.each([
      "uv run pytest test_x.py",
      "uv run pytest test_x.py::test_y",
      "uv run pytest tests/x.py::test_y",
    ])("allows the single-test run %j", (c) => {
      expect(guardDecision(bash(c), py).kind).toBe("allow");
    });
  });
  it("matches isFullSuite", () => {
    expect(isFullSuite(["pnpm", "-s", "vitest", "run", "--", "x.test.ts"], FULL)).toBe(true);
    expect(isFullSuite(["pnpm", "-s", "vitest", "run", "x.test.ts"], FULL)).toBe(false);
  });
});

describe("firstPrNotifier (Task 9)", () => {
  const pr = (text: string) => firstPrNotifier(text, { repo: "o/mc", issue: 42 });

  it.each([
    ["thanks @octocat", "@octocat"],
    ["(@octocat) said so", "@octocat"],
    ["@a-b-c", "@a-b-c"],
    ["see o/other#3", "o/other#3"],
    ["see o/mc#3 too", "o/mc#3"],
    ["x/o/r#1", "o/r#1"],
    ["see https://github.com/o/other/pull/3", "https://github.com/o/other/pull/3"],
    ["[it](https://github.com/x/y/issues/9)", "https://github.com/x/y/issues/9"],
    ["first o/x#1 then @a", "o/x#1"],
    ["first @a then o/x#1", "@a"],
    ["\\`@octocat\\`", "@octocat"],
    ["\\@octocat", "@octocat"],
    ["`unclosed @octocat", "@octocat"],
    ["`a\n@octocat`", "@octocat"],
    ["  ```\n@octocat\n  ```", "@octocat"],
    ["> ```\n> @octocat\n> ```", "@octocat"],
    ["```\ncode\n```\nafter @octocat", "@octocat"],
    ["``` `x`\n@octocat\n```", "@octocat"],
    ["a`x`@octocat", "@octocat"],
    // round 4: PR text is plain text, so code spans and code blocks hide nothing
    ["`@octocat`", "@octocat"],
    ["`` a ` @octocat ``", "@octocat"],
    ["```\n@octocat\n```", "@octocat"],
    ["~~~ts\n@octocat o/x#1\n~~~", "@octocat"],
    ["````\n```\n@octocat\n````", "@octocat"],
    ["```\n@octocat never closed", "@octocat"],
    // round 4: any reference but the run's own issue
    ["see https://github.com/o/mc/issues/3", "https://github.com/o/mc/issues/3"],
    ["see https://github.com/O/MC/pull/3", "https://github.com/O/MC/pull/3"],
    ["see #3 and #4", "#3"],
  ])("refuses %j (%s)", (text, first) => {
    expect(pr(text)).toBe(first);
  });

  it.each([
    "mail you@example.com",
    `@${"a".repeat(40)}`,
    "see https://github.com/o/mc/issues/42",
    "see #42, o/mc#42 and GH-42",
    "plain text",
  ])("passes %j", (text) => {
    expect(pr(text)).toBeNull();
  });
});

describe("firstCommitNotifier (Task 9)", () => {
  it.each([
    ["fix: x\n\nFixes #42", 42, "Fixes #42"],
    ["closes: #42", 42, "closes: #42"],
    ["RESOLVED #42", 42, "RESOLVED #42"],
    ["see #7", 42, "#7"],
    ["see #42", null, "#42"],
    ["fixes o/r#3", 42, "fixes o/r#3"],
    ["ping @octocat", 42, "@octocat"],
    ["feat: x (#42), see #8", 42, "#8"],
    ["feat: #420 is not #42", 420, "#42"],
  ])("refuses %j (issue %s)", (message, issue, what) => {
    expect(firstCommitNotifier(message, { repo: "o/mc", issue })).toBe(what);
  });

  it.each([
    ["feat: x (#42)", 42],
    ["by you@example.com", 42],
    ["prefix#7 is not a reference", 42],
    ["feat: #420 done", 420],
    ["plain", null],
  ])("passes %j (issue %s)", (message, issue) => {
    expect(firstCommitNotifier(message, { repo: "o/mc", issue })).toBeNull();
  });
});

describe("firstPrNotifier allowOwnRepoRefs", () => {
  const own = (text: string) =>
    firstPrNotifier(text, { repo: "o/mc", issue: null, allowOwnRepoRefs: true });

  it("lets a bare #n and GH-n through, which are this repo's own issues", () => {
    expect(own("Depends on #12 and GH-13")).toBeNull();
    expect(firstPrNotifier("Depends on #12", { repo: "o/mc", issue: null })).toBe("#12");
  });

  it("still finds mentions, other items by name or link, and closing keywords", () => {
    expect(own("ask @octocat")).toBe("@octocat");
    expect(own("see other/repo#5")).toBe("other/repo#5");
    expect(own("see o/mc#5")).toBe("o/mc#5");
    expect(own("see https://github.com/other/repo/issues/5")).not.toBeNull();
    expect(own("fixes #5")).not.toBeNull();
  });
});

describe("Task 9 fix round 1: notifiers", () => {
  const body = (text: string) => firstPrNotifier(text, { repo: "o/mc", issue: 42 });
  const title = (text: string) => firstPrNotifier(text, { repo: "o/mc", issue: 42 });
  const commit = (text: string, issue: number | null = 42) =>
    firstCommitNotifier(text, { repo: "o/mc", issue });

  it("reads a title as plain text: a fence or a code span hides nothing (finding 1, round 4)", () => {
    expect(title("```x @octocat")).toBe("@octocat");
    expect(title("```x other/repo#5")).toBe("other/repo#5");
    expect(title("feat: `@octocat` in a span")).toBe("@octocat");
  });

  it("never blanks a fence inside an HTML block (finding 2)", () => {
    expect(body("<details>\n```\n@octocat\n```\n</details>")).toBe("@octocat");
    expect(body("<details>\n`@octocat`\n</details>")).toBe("@octocat");
    // a comment, <pre> and the like run to their own end, across blank lines
    expect(body("<!--\n\n```\n@octocat\n```\n-->")).toBe("@octocat");
    expect(body("<pre>\n\n```\n@octocat\n```\n</pre>")).toBe("@octocat");
    // round 4: a fence after a blank line hides nothing either
    expect(body("<div>\n\n```\n@octocat\n```\n</div>")).toBe("@octocat");
  });

  it("refuses team mentions (ruling 7), inside code too (round 4)", () => {
    expect(body("ping @org/team")).toBe("@org/team");
    expect(body("uses @mc/core")).toBe("@mc/core");
    expect(body("@mc/core/src is a path")).toBe("@mc/core");
    expect(body("uses `@mc/core`")).toBe("@mc/core");
    expect(body("uses mc/core")).toBeNull();
    expect(commit("chore: bump @mc/core")).toBe("@mc/core");
  });

  it.each([
    ["Fixes #99", "Fixes #99"],
    ["closes GH-99", "closes GH-99"],
    ["Resolves https://github.com/o/mc/issues/99", "Resolves https://github.com/o/mc/issues/99"],
    ["Fixes O/MC#99", "Fixes O/MC#99"],
  ])("a PR body refuses a closing keyword for another issue: %j (ruling 9)", (text, first) => {
    expect(body(text)).toBe(first);
  });

  it.each([
    "Fixes #42",
    "Closes GH-42",
    "Fixes https://github.com/o/mc/issues/42",
    "Closes o/mc#42",
  ])("a PR body passes %j", (text) => {
    expect(body(text)).toBeNull();
  });

  it.each([
    ["see #99 and GH-99", "#99"],
    ["see https://github.com/o/mc/issues/99", "https://github.com/o/mc/issues/99"],
    ["`Fixes #99`", "Fixes #99"],
  ])("round 4: a PR body refuses %j", (text, first) => {
    expect(body(text)).toBe(first);
  });

  it.each([
    ["see https://github.com/other/repo/issues/5", "https://github.com/other/repo/issues/5"],
    ["see https://github.com/o/mc/issues/99", "https://github.com/o/mc/issues/99"],
    ["Fixes https://github.com/o/mc/issues/99", "Fixes https://github.com/o/mc/issues/99"],
    ["Fixes https://github.com/o/mc/issues/42", "Fixes https://github.com/o/mc/issues/42"],
    ["see GH-99", "GH-99"],
    ["Fixes GH-99", "Fixes GH-99"],
    ["Fixes GH-42", "Fixes GH-42"],
  ])("a commit message refuses %j (finding 3)", (text, what) => {
    expect(commit(text)).toBe(what);
  });

  it.each([
    "feat: x (GH-42)",
    "see https://github.com/o/mc/issues/42",
    "see https://github.com/o/mc/pull/42",
  ])("a commit message passes the run's own issue: %j", (text) => {
    expect(commit(text)).toBeNull();
  });
});

describe("Task 9 fix round 1: unclosedMarkdown and namesIssue (finding 8)", () => {
  it.each([
    ["text\n```\ncode", true],
    ["~~~\ncode", true],
    ["<!-- open", true],
    ["<pre>\nx", true],
    ["```\nx\n```", false],
    ["<details>\nx", false],
    ["<!-- x -->", false],
    ["plain", false],
  ])("unclosedMarkdown(%j) is %s", (md, open) => {
    expect(unclosedMarkdown(md)).toBe(open);
  });
});

describe("closesIssue", () => {
  it.each([
    ["a`x`Fixes #42", false],
    ["Fixes #42`x`3", false],
    ["Fixes`example`#42", false],
    ["`example\r\n\r\nFixes #42`", true],
  ] as const)("preserves code-span boundary and paragraph safety: %j", (md, expected) => {
    expect(closesIssue(md, { repo: "o/mc", issue: 42 })).toBe(expected);
  });

  it.each([
    "Fixes`example`#42",
    "Fixes `example` #42",
    "Fix`example`es #42",
    "fi`code`es #42",
    "Fixes o/`example`mc#42",
    "Fixes #4`example`2",
    "Fixes`example` GH-42",
    "Fixes`example` https://github.com/o/mc/issues/42",
  ])("does not assemble a closing reference across a code span: %j", (md) => {
    expect(closesIssue(md, { repo: "o/mc", issue: 42 })).toBe(false);
  });

  it("does not forge a repository name from the code-span placeholder", () => {
    expect(closesIssue("Fixes o/`example`mc#42", { repo: "o/xmc", issue: 42 })).toBe(false);
  });

  it.each(["Fixes #42 and `code`", "`code` and Fixes #42"])(
    "recognizes a closing reference separated from a code span: %j",
    (md) => {
      expect(closesIssue(md, { repo: "o/mc", issue: 42 })).toBe(true);
    },
  );

  it.each(["`example\nFixes #42`", "`example\r\nFixes #42`", "``example\nFixes #42 ` x``"])(
    "blanks a code span across one line break: %j",
    (md) => {
      expect(closesIssue(md, { repo: "o/mc", issue: 42 })).toBe(false);
    },
  );

  it.each(["\n\n", "\n \t\n", "\r\n\r\n", "\r\n \t\r\n"])(
    "ends a code span's paragraph at %j",
    (separator) => {
      expect(closesIssue(`\`example${separator}Fixes #42\``, { repo: "o/mc", issue: 42 })).toBe(
        true,
      );
    },
  );

  it.each(["distinct runs", "one long run"])(
    "scans a 100k-character line with 10k unmatched backticks in under 50 ms (%s)",
    (shape) => {
      const runs = Array.from({ length: 139 }, (_, i) => "`".repeat(i + 1));
      runs.push("`".repeat(270));
      const md = (shape === "distinct runs" ? runs.join("x") : "`".repeat(10_000)).padEnd(
        100_000,
        "x",
      );
      const start = performance.now();
      const closes = closesIssue(md, { repo: "o/mc", issue: 42 });
      const elapsed = performance.now() - start;
      expect(closes).toBe(false);
      expect(elapsed).toBeLessThan(50);
    },
  );

  it.each([
    ["Refs #42", false],
    ["#42", false],
    ["Refs o/mc#42", false],
    ["Fixes #42", true],
    ["closes: **#42**", false],
    ["closes **#42**", false],
    ["`Fixes #42`", false],
    ["```\nFixes #42\n```", false],
    ["```\nfoo\nFixes #42\n```", false],
    ["~~~\na\nFixes #42\n~~~", false],
    ["<!-- Fixes #42 -->", false],
    ["``Fixes #42 ` x``", false],
    ["```\na\n```~\nFixes #42", false],
    ["~~~\na\n~~~`\nFixes #42", false],
    ["Fixes github.com/o/mc/pull/42", false],
    ["Fixes: #42", true],
    ["Fixes https://github.com/o/mc/issues/42", true],
    ["Resolved o/mc#42", true],
    ["Fixes #43", false],
    ["Fixes other/repo#42", false],
    ["Fixes &#35;42", true],
    ["no mention", false],
  ])("closesIssue(%j, o/mc, 42) is %s", (md, closes) => {
    expect(closesIssue(md, { repo: "o/mc", issue: 42 })).toBe(closes);
  });
});

describe("Task 9 fix round 2: notifiers", () => {
  const body = (text: string) => firstPrNotifier(text, { repo: "o/mc", issue: 42 });
  const title = (text: string) => firstPrNotifier(text, { repo: "o/mc", issue: 42 });
  const commit = (text: string) => firstCommitNotifier(text, { repo: "o/mc", issue: 42 });

  it("refuses a mention after any non-word character (N2)", () => {
    expect(body("a.@octocat")).toBe("@octocat");
    expect(body("a/@octocat")).toBe("@octocat");
    expect(commit("see a.@octocat")).toBe("@octocat");
    expect(body("a_@octocat")).toBeNull();
    expect(body("you@example.com")).toBeNull();
  });

  it.each([
    ['x <span title="`">@octocat</span> `', "@octocat"],
    ["x <!-- ` -->@octocat `", "@octocat"],
    ["x <https://a.b/`>@octocat `", "@octocat"],
    ['x <span title="`">Fixes #99</span> `', "Fixes #99"],
  ])(
    "reads backticks on a line with inline HTML or an autolink as text (N3): %j",
    (text, first) => {
      expect(body(text)).toBe(first);
      expect(title(text)).toBe(first);
    },
  );

  it("normalises CRLF and CR before reading fences (N4); round 4: fences hide nothing", () => {
    expect(body("```\n```\r\n@octocat")).toBe("@octocat");
    expect(body("```\n@a\n```\r\n@octocat")).toBe("@a");
    // round 4: a closed fence hides nothing
    expect(body("```\r\n@octocat\r\n```\r\n")).toBe("@octocat");
    expect(body("```\r@octocat\r```\r")).toBe("@octocat");
    expect(unclosedMarkdown("```\r\nx\r\n")).toBe(true);
    expect(unclosedMarkdown("```\r\nx\r\n```\r\n")).toBe(false);
    expect(unclosedMarkdown("```\rx\r```\r")).toBe(false);
  });

  it("refuses GH-n after any non-word character (N5)", () => {
    expect(commit("see x-GH-99")).toBe("GH-99");
    expect(commit("xGH-99")).toBeNull();
  });

  it.each([
    ["Fixes:#99", "Fixes:#99"],
    ["fixes [#99](https://example.com)", "fixes [#99"],
    ["fixes **#99**", "fixes **#99"],
    ["closes _GH-99_", "closes _GH-99"],
    ["resolves (#99)", "resolves (#99"],
  ])("refuses a punctuated closing keyword for another issue (N6): %j", (text, first) => {
    expect(body(text)).toBe(first);
  });

  it.each(["Fixes **#42**", "Fixes:#42", "closes [#42](x)"])(
    "passes a punctuated closing keyword for the run's own issue: %j",
    (text) => {
      expect(body(text)).toBeNull();
    },
  );
});

describe("Task 9 fix round 3: notifiers", () => {
  const body = (text: string) => firstPrNotifier(text, { repo: "o/mc", issue: 42 });
  const title = (text: string) => firstPrNotifier(text, { repo: "o/mc", issue: 42 });

  it.each([
    ["[a](http://x/`) @octocat `", "@octocat"],
    ["![a](http://x/`) @octocat `", "@octocat"],
    ["x [a](<`>) @octocat `", "@octocat"],
    ['x [a](b "`") @octocat `', "@octocat"],
    ["[a](http://x/`) Fixes #99 `", "Fixes #99"],
  ])("reads backticks on a line with a link or image as text (N8): %j", (text, first) => {
    expect(body(text)).toBe(first);
    expect(title(text)).toBe(first);
  });

  it("reads backticks on a reference definition line as text (N8)", () => {
    expect(body("[a]: http://x/` @octocat `")).toBe("@octocat");
    expect(body("x ]: ` @octocat `")).toBe("@octocat");
  });

  it("round 4: a code span on a line with brackets but no link hides nothing either", () => {
    expect(body("see [this] and `@octocat`")).toBe("@octocat");
  });

  it.each([
    ["Fixes ~~#99~~", "Fixes ~~#99"],
    ["Fixes <#99>", "Fixes <#99"],
    ['Fixes "#99"', 'Fixes "#99'],
    ["Fixes '#99'", "Fixes '#99"],
    ["Fixes >#99", "Fixes >#99"],
  ])("refuses a closing keyword with more separators for another issue: %j", (text, first) => {
    expect(body(text)).toBe(first);
  });

  it.each(["Fixes ~~#42~~", "Fixes <#42>", 'Fixes "#42"'])(
    "passes the same shapes for the run's own issue: %j",
    (text) => {
      expect(body(text)).toBeNull();
    },
  );
});

describe("Task 9 fix round 4: PR text and commit messages are plain text", () => {
  const body = (text: string) => firstPrNotifier(text, { repo: "o/mc", issue: 42 });
  const commit = (text: string) => firstCommitNotifier(text, { repo: "o/mc", issue: 42 });
  const shapes = (x: string) => [
    `http://x/\` ${x} \``,
    `see http://x/\`a ${x} \``,
    `www.x.com/\` ${x} \``,
    `[a] (http://x/\`) ${x} \``,
    `[a](\nhttp://x/\`) ${x} \``,
    `[a]:\nhttp://x/\`) ${x} \``,
  ];

  it.each([...shapes("@octocat"), ...shapes("Fixes #99")])(
    "refuses the round-3 reviewer's probe %j",
    (text) => {
      const first = text.includes("@octocat") ? "@octocat" : "Fixes #99";
      expect(body(text)).toBe(first);
      expect(commit(text)).toBe(first);
    },
  );

  it.each([
    // round 5: a match from decoded text is named with its written form too
    ["&#64;octocat", "@octocat (written as &#64;octocat)"],
    ["&#x40;octocat", "@octocat (written as &#x40;octocat)"],
    ["&#X40;octocat", "@octocat (written as &#X40;octocat)"],
    ["&commat;octocat", "@octocat (written as &commat;octocat)"],
    ["&#64octocat", "@octocat (written as &#64octocat)"],
    ["Fixes &#35;99", "Fixes #99 (written as Fixes &#35;99)"],
    ["Fixes &num;99", "Fixes #99 (written as Fixes &num;99)"],
    ["see &#x23;99", "#99 (written as &#x23;99)"],
    ["`&#96; @octocat &grave;`", "@octocat"],
    ["x &#x1F600;@octo&#x63;at y", "@octocat (written as @octo&#x63;at)"],
  ])("decodes character references before matching: %j", (text, first) => {
    expect(body(text)).toBe(first);
    expect(commit(text)).toBe(first);
  });

  it("decodes once, left to right: &amp; never yields a second reference", () => {
    expect(decodeCharRefs("&amp;#64;octocat")).toBe("&#64;octocat");
    expect(decodeCharRefs("&amp;commat;octocat")).toBe("&commat;octocat");
    expect(body("&amp;commat;octocat")).toBeNull();
    expect(commit("&amp;commat;octocat")).toBeNull();
  });

  it("decodes any code point, and an impossible one as U+FFFD", () => {
    expect(decodeCharRefs("&#64;&#x40;&commat;&num;&grave;&amp;")).toBe("@@@#`&");
    expect(decodeCharRefs("&#x1F600;")).toBe("\u{1F600}");
    expect(decodeCharRefs("&#0;&#xD800;&#1114112;")).toBe("���");
    // round 5: the allow-listed names decode too; any other name is left as written
    expect(decodeCharRefs("&AMP; &lt;&gt;&quot;&apos;&nbsp; &sol;")).toBe(
      "&AMP; <>\"'\u00a0 &sol;",
    );
  });

  it.each(["Closes &#35;42", "see #42", "https://github.com/o/mc/issues/42", "Closes #42"])(
    "passes the run's own issue in a PR body: %j",
    (text) => {
      expect(body(text)).toBeNull();
    },
  );
});

describe("Task 9 fix round 5: named references, odd github.com URLs, written forms", () => {
  const body = (text: string) => firstPrNotifier(text, { repo: "o/mc", issue: 42 });
  const commit = (text: string) => firstCommitNotifier(text, { repo: "o/mc", issue: 42 });

  it.each([
    ["torvalds&sol;linux#9", "&sol;"],
    ["o&sol;r#42", "&sol;"],
    ["Closes o&sol;r#9", "&sol;"],
    ["a&period;b", "&period;"],
    ["snake&lowbar;case", "&lowbar;"],
    ["o&sol r#9", "&sol"],
    ["&AMP;commat;x", "&AMP;"],
    ["fine &amp; then &solidus;", "&solidus;"],
  ])("firstNamedRef refuses a name outside the allow-list: %j", (text, ref) => {
    expect(firstNamedRef(text)).toBe(ref);
  });

  it.each([
    "R and D &amp; more",
    "&amp;sol; is text once decoded",
    "&lt;tag&gt; &quot;q&quot; &apos;a&apos; a&nbsp;b",
    "&commat; &num; &grave; &amp",
    "&#47; &#x2F; numeric is decoded, not refused",
    "a && b; x & y",
  ])("firstNamedRef passes %j", (text) => {
    expect(firstNamedRef(text)).toBeNull();
  });

  it.each([
    "https://github.com/o/r/issues/%39",
    "https://github.com:443/o/r/issues/9",
    "HTTPS://GITHUB.COM/o/r/issues/%39",
    "github.com/o/r/pull/%39",
    "www.github.com:443/o/r/issues/9",
    "https://github.com:/o/r/issues/9",
    "https://github.com%2Fo%2Fr/issues/9",
  ])("refuses a github.com URL with a %% or a port: %j", (url) => {
    expect(body(`see ${url} now`)).toBe(url);
    expect(commit(`see ${url} now`)).toBe(url);
  });

  it.each([
    "https://github.com/o/mc/issues/42",
    "see github.com: it was down",
    "https://example.com/a%20b",
  ])("passes %j", (text) => {
    expect(body(text)).toBeNull();
    expect(commit(text)).toBeNull();
  });

  it("names a match from decoded text with both forms, and a plain one once", () => {
    expect(body("hi &#64;octo")).toBe("@octo (written as &#64;octo)");
    expect(commit("hi &#64;octo")).toBe("@octo (written as &#64;octo)");
    expect(body("see github.com/o/r/issues/&#37;39")).toBe(
      "github.com/o/r/issues/%39 (written as github.com/o/r/issues/&#37;39)",
    );
    expect(body("hi @octo")).toBe("@octo");
  });
});

describe("program names compare case-insensitively (PR #143 I1b)", () => {
  it("reads GIT and SH as git and sh", () => {
    expect(ruleOf(bash("GIT push"))).toBe("git-write");
    expect(ruleOf(bash("/usr/bin/Git commit -m x"))).toBe("git-write");
    expect(ruleOf(bash("SH -c 'git push'"))).toBe("git-write");
    expect(ruleOf(bash("GH pr merge 1"))).toBe("gh-cli");
    expect(ruleOf(bash("CURL x"))).toBe("network");
    expect(splitCommands("Env GIT push")).toEqual([["git", "push"]]);
  });
  it("matches a full-suite entry whatever the case of its program", () => {
    expect(ruleOf(bash("PNPM -s test", { run_in_background: true }))).toBe("full-suite");
  });
});

describe("runners, option clusters, zsh function and always, brace suites, git listing", () => {
  const pushDenied = {
    kind: "deny",
    rule: "git-write",
    text: `${GUARD_RULES["git-write"]}: git push`,
  };
  it.each([
    "env -iu HOME git push",
    "env -vS 'git push'",
    "env -uS git push",
    "sudo -iu root git push",
    "xargs -0n 1 git push",
    "watch git push",
    "watch 'git push'",
    "caffeinate -i git push",
    "script -q /dev/null git push",
    "flock /tmp/l git push",
    "flock /tmp/l -c 'git push'",
    "parallel git push ::: a",
    "pnpm exec git push",
    "pnpm dlx git push",
    "pnpm -s exec git push",
    "pnpm --filter web exec git push",
    "npx git push",
    "doas git push",
    "ionice -c 3 git push",
    "taskset 1 git push",
    "chronic git push",
    "unbuffer git push",
    "function f { git push; }; f",
    "{ echo a } always { git push }",
    "{ echo a; } always { git push; }",
  ])("denies %s as git-write naming git push", (c) => {
    expect(guardDecision(bash(c), writer)).toEqual(pushDenied);
  });

  it("splits a zsh always group", () => {
    expect(splitCommands("{ echo a } always { git push }")).toEqual([
      ["echo", "a"],
      ["git", "push"],
    ]);
  });

  it("refuses a pnpm word that brace-expands, since pnpm may run it as a binary", () => {
    const ctx: GuardContext = {
      mode: "writer",
      repo: "dev",
      flightPowers: "standard",
      fullSuite: ["pnpm -s test"],
    };
    // `pnpm -s {op,}en .` would run /usr/bin/open: the brace word is judged as a command
    const unreadable = {
      kind: "deny",
      rule: "unreadable",
      text: `${GUARD_RULES.unreadable}: brace expansion`,
    };
    for (const c of ["pnpm -s {test,}", "pnpm -s test{,}", "pnpm -s {op,}en ."])
      expect(guardDecision(bash(c), ctx), c).toEqual(unreadable);
    expect(guardDecision(bash("pnpm -s {test,}"), { ...ctx, mode: "read-only" })).toEqual(
      unreadable,
    );
  });

  it("a runner runs its command in the foreground", () => {
    expect(guardDecision(bash("watch pnpm -s test"), writer)).toEqual({
      kind: "lock",
      command: "pnpm -s test",
    });
    expect(guardDecision(bash("watch tmux new -d 'pnpm -s test'"), writer)).toEqual({
      kind: "deny",
      rule: "full-suite",
      text: BACKGROUND_SUITE_TEXT,
    });
  });

  it.each([
    "X={a,b} ls",
    "git tag -l 'v*'",
    "git tag --list",
    "git branch --contains abc",
    "git branch --merged main",
    "git branch --points-at=HEAD",
    "npx tsc --noEmit",
    "pnpm exec tsc --noEmit",
    "pnpm -s exec tsc --noEmit",
    "watch ls",
  ])("allows %s", (c) => {
    expect(ruleOf(bash(c))).toBe("allow");
  });

  it.each([
    "git tag v1",
    "git tag -d v1",
    "git tag -l -d v1",
    "git tag -l --message=x v1",
    "git branch -d x",
    "git branch newname",
    "git branch --contains abc -d x",
  ])("still denies %s as git-write", (c) => {
    expect(ruleOf(bash(c))).toBe("git-write");
  });

  it("still denies a brace-expanding head word", () => {
    expect(guardDecision(bash("./scripts/{a,b}.sh"), writer)).toEqual({
      kind: "deny",
      rule: "unreadable",
      text: `${GUARD_RULES.unreadable}: brace expansion`,
    });
  });
});

describe("seat git environment", () => {
  // Shell parameter expansion, not a template placeholder.
  const shellVar = "$" + "{WT}";
  it.each([
    `git -C ${shellVar} status`,
    `git -C "${shellVar}" log --oneline`,
    `git -C ${shellVar} diff`,
    'git -C "$WT" log -1 --format=%H',
    'cd "$(git rev-parse --show-toplevel)" && ls',
    "GIT_CONFIG_GLOBAL=x git diff",
    "env GIT_CONFIG_COUNT=1 git log",
    "env -i git diff",
    "env -iu HOME git diff",
    "env -S '-i git diff'",
    "env -S '-u GIT_CONFIG_GLOBAL git diff'",
    "GIT_CONFIG_GLOBAL+=x git diff",
    "env - git diff",
    "env -u GIT_CONFIG_GLOBAL git diff",
    "env -vu GIT_CONFIG_GLOBAL git diff",
    "opt=git-dir; git --$opt=/outside log",
    "printf -v GIT_CONFIG_GLOBAL /tmp/config; git diff",
    'name=GIT_CONFIG_GLOBAL; printf -v"$name" /tmp/config; git diff',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable expansion
    'name=GIT_CONFIG_GLOBAL; printf -v"${name}" /tmp/config; git diff',
    "printf -vGIT_CONFIG_GLOBAL /tmp/config; git diff",
    "read GIT_CONFIG_GLOBAL; git diff",
    "for GIT_CONFIG_GLOBAL in /tmp/config; do git diff; done",
    "env --unset=GIT_CONFIG_COUNT git status",
    "env -S 'GIT_CONFIG_GLOBAL=x git diff'",
    "builtin export GIT_CONFIG_COUNT=0; git diff",
    "export GIT_CONFIG_GLOBAL+=x; git diff",
    "command export GIT_CONFIG_GLOBAL=x; git diff",
    "exec env GIT_CONFIG_COUNT=0 git diff",
    "exec -c git diff",
    "builtin exec -cl git diff",
    "env -vi git diff",
    "declare -x GIT_CONFIG_COUNT=0; git diff",
    "typeset GIT_CONFIG_COUNT=0; git diff",
    "readonly GIT_CONFIG_GLOBAL=x; git diff",
    "unset GIT_CONFIG_GLOBAL; git diff",
    "unset -m 'GIT_*'; git diff",
    "unset -v GIT_CONFIG_COUNT; git diff",
    "unset -m '*'; git diff",
    "unset -m 'G#IT_CONFIG_COUNT'; git diff",
    "unset -m 'G\\IT_CONFIG_COUNT'; git diff",
    "typeset -m 'GIT_*'; git diff",
    "declare -m '*CONFIG*'; git diff",
    "export 'GIT_*'; git diff",
    "builtin unset -m 'G?T_*'; git diff",
    "set -a GIT_CONFIG_COUNT; git diff",
    "git -c diff.external=x diff",
    `git -c "core.hooksPath=${"$"}{X}" log`,
    "git --config-env=diff.external=X diff",
    "git --git-dir=/outside diff",
    "git --work-tree /outside status",
    "git --exec-path=/outside log",
    "git --namespace=x log",
    "git diff --no-index a b",
    "git difftool --no-index a b",
    "GIT_CONFIG_COUNT=0 true; env SAFE=1 git diff",
    "env -i true; env SAFE=1 git diff",
    `name=GIT_CONFIG_GLOBAL; env -u "${"$"}name" git diff`,
    `name=GIT_CONFIG_GLOBAL; env -u"${"$"}name" git diff`,
    `name=GIT_CONFIG_GLOBAL; env --unset="${"$"}name" git diff`,
    `opts=-i; env ${"$"}opts git diff`,
    `opts=-i; env SAFE=1 ${"$"}opts git diff`,
    "opts=-i; env `echo -i` git diff",
  ])("refuses %s", (command) => {
    for (const mode of ["writer", "read-only", "scratch"] as const) {
      expect(ruleOf(bash(command), { ...writer, mode })).toBe("git-env");
    }
  });
  it.each([
    "git log --oneline -5",
    "git log --format='%h %s' -3",
    "git show HEAD:package.json",
    "git diff",
    "git status",
    "git diff HEAD~1..HEAD",
    "git log main",
    "git log -- apps/server",
    "git -C apps/server log --oneline -3",
    "git diff | head",
    "git status --short | wc -l",
    "git log --oneline | grep fix",
  ])("keeps Claude reads: %s", (command) => {
    for (const mode of ["writer", "read-only", "scratch"] as const)
      expect(ruleOf(bash(command), { ...writer, mode })).toBe("allow");
  });
});

describe("detached work: multiplexers fail closed, schedulers and launchers, arithmetic", () => {
  it.each([
    "tmux -L sock new -d sleep 1",
    "tmux -S /tmp/s new -d",
    "tmux -f /dev/null new -d",
    "tmux -Lsock new -d",
    "tmux neww",
    "tmux new-s -d",
    "tmux splitw",
    "tmux split-window -d sleep 9",
    "tmux run -b sleep 9",
    "tmux respawnp",
    'tmux if-shell true "run -b x"',
    "tmux pipe-pane",
    "tmux popup",
    "tmux source-file x.conf",
    "tmux ls \\; new -d sleep 9",
    "tmux ls ';' new -d sleep 9",
    "tmux ls\\; new -d sleep 9",
    "tmux",
    "tmux -u",
    "tmux display",
    "tmux display -p '#(sleep 9 &)'",
    "tmux capture-pane",
    "/opt/homebrew/bin/tmux neww",
    "command tmux neww",
    "screen",
    "screen -S name",
    "screen -S name sleep 9",
    "screen -dmS s sleep 9",
    "screen -d -m sleep 9",
    "screen -DR",
    "screen -R x",
    "screen -S x -X screen sleep 9",
  ])("refuses %s as background", (c) => {
    expect(ruleOf(bash(c))).toBe("background");
  });

  it.each([
    "tmux ls",
    "tmux has -t x",
    "tmux has-session -t x",
    "tmux -L s ls",
    "tmux -S /tmp/s list-sessions",
    "tmux capture-pane -p",
    "tmux capturep -p -t x",
    "tmux display -p '#{pane_id}'",
    "tmux display-message -p x",
    "tmux list-windows -a",
    "tmux show-options -g",
    "tmux kill-session -t x",
    "tmux a -t x",
    "tmux attach-session -t x",
    "tmux -V",
    "tmux send-keys -t x 'ls' Enter",
    "screen -ls",
    "screen -list",
    "screen -r x",
    "screen -x x",
    "screen -dr x",
    "screen -d -r x",
    "screen -d x",
    "screen -S x -X stuff 'ls\n'",
    "screen -S x -X quit",
  ])("allows %s, which starts nothing", (c) => {
    expect(ruleOf(bash(c))).toBe("allow");
  });

  it.each([
    "at now",
    "batch",
    "crontab -l",
    "crontab x.cron",
    "launchctl load x.plist",
    "launchctl submit -l x -- sleep 9",
    "osascript -e 'do shell script \"sleep 9\"'",
    "open -a Terminal .",
    "command at now",
    "env launchctl list",
    "/usr/bin/osascript -e x",
    "/usr/bin/open .",
    "nice -n 5 crontab -l",
    "ls && open .",
    'sh -c "at now"',
    "find . -exec open {} +",
  ])("refuses the scheduler or launcher in %s as background", (c) => {
    expect(guardDecision(bash(c), writer)).toEqual({
      kind: "deny",
      rule: "background",
      text: expect.stringMatching(/^Commands must stay attached to the seat's current tool call: /),
    });
  });

  it.each([
    "echo $((5 & 3))",
    'echo "$((5 & 3))"',
    "(( x = 5 & 3 ))",
    "echo $[5 & 3]",
    "cat <<EOF\n$((5 & 3))\nEOF",
  ])("does not count the arithmetic & in %j as background", (c) => {
    expect(ruleOf(bash(c))).toBe("allow");
  });

  it.each(["((sleep 9 &) )", 'echo "$((sleep 9 &) )"', "sleep 9 & echo $((5 & 3))"])(
    "still counts a lone & in a subshell that only looked arithmetic: %j",
    (c) => {
      expect(ruleOf(bash(c))).toBe("background");
    },
  );
});

describe("zsh EQUALS and the - precommand modifier, launcher words as data, tmux expansions", () => {
  it.each([
    "corepack pnpm open .",
    "pnpm $(echo open) .",
    "pnpm $" + "{X:-open} .",
    "$(echo open) .",
    "sh -c '$(echo open) .'",
    "ssh -fN host",
    "ssh -Nf host",
    "ssh -f host sleep 9",
    "ssh -Mf host sleep 9",
    "ssh -B en0 -f host sleep 9",
    "ssh -P work -f host sleep 9",
    "autossh -f host",
    "autossh -Nf host",
    "autossh -B en0 -f host sleep 9",
    "start-stop-daemon --start -b",
    "start-stop-daemon -Sb",
    "disown",
    "gpg-connect-agent /bye",
    "gpg --sign x",
    "pnpm t open .",
    "pnpm server open .",
  ])("refuses an unmodelled form that can launch work later: %s", (c) => {
    expect(guardDecision(bash(c), writer).kind).toBe("deny");
  });

  it("documents program-specific argument execution as an accepted parser boundary", () => {
    // Generic runner handling still catches npx, but bun is not a modelled runner.
    expect(ruleOf(bash("npx cross-env A=1 open ."))).toBe("background");
    expect(ruleOf(bash("bun x open ."))).toBe("allow");
  });

  it("allows an ssh remote argument that only resembles a local background flag", () => {
    expect(ruleOf(bash("ssh host printf -- -foo"))).toBe("allow");
  });

  it.each([
    "start-stop-daemon -Snbob --exec /bin/sleep -- 9",
    "start-stop-daemon --start --exec /bin/sleep -- --background",
    "start-stop-daemon -S -n -bob",
  ])("allows start-stop-daemon option values that contain a background flag letter: %s", (c) => {
    expect(ruleOf(bash(c))).toBe("allow");
  });

  it.each([
    ["=git push", "git-write"],
    ["=gh pr merge 1", "gh-cli"],
    ["=curl https://x", "network"],
    ["=setsid sleep 9", "background"],
    ["=open .", "background"],
    ["=tmux new -d", "background"],
    ["=pnpm -s test", "lock"],
    ["- setsid sleep 9", "background"],
    ["- git push", "git-write"],
    ["env =git push", "git-write"],
    ["ls && =git push", "git-write"],
  ])("judges %s by the command it runs (%s)", (c, rule) => {
    expect(ruleOf(bash(c))).toBe(rule);
  });
  it("still allows an ordinary =word argument, and gpg tools that start nothing", () => {
    expect(ruleOf(bash("echo =x"))).toBe("allow");
    expect(ruleOf(bash("gpgconf --list-dirs"))).toBe("allow");
    expect(ruleOf(bash("gpg-agent --version"))).toBe("allow");
    expect(ruleOf(bash("gpg-agent --da"))).toBe("allow");
    expect(ruleOf(bash("gpgconf --l"))).toBe("allow");
    for (const c of [
      "pnpm install",
      "pnpm add -D x",
      "pnpm run build",
      "yarn install",
      "yarn test",
      // a package command's words are package names, even behind a valued option
      "pnpm add open",
      "pnpm --filter @mc/web add open",
      "pnpm -F web add -D open",
      "yarn workspace web add open",
      "pnpm -s lint --fix",
      "pnpm --filter @mc/server exec vitest run test/at.test.ts",
    ])
      expect(ruleOf(bash(c)), c).toBe("allow");
  });

  // An option known neither to take a value nor to take none may have swallowed the next word
  // (`--store-dir add` leaves `open .` as the command pnpm runs), so the words after it are judged.
  it.each([
    "pnpm --store-dir add open .",
    "pnpm --lockfile-dir add open .",
    "pnpm --config.foo add open .",
    "pnpm --virtual-store-dir install open .",
  ])("refuses a launcher behind an option whose value is unknown: %s", (c) => {
    expect(ruleOf(bash(c))).toBe("background");
  });
  it("still allows known options before a package command", () => {
    for (const c of [
      "pnpm -s add open",
      "pnpm --frozen-lockfile install",
      "pnpm install --frozen-lockfile",
      "pnpm -r build",
      "pnpm --filter=@mc/server test",
      "yarn --frozen-lockfile install",
    ])
      expect(ruleOf(bash(c)), c).toBe("allow");
  });

  it("allows a launcher word a multiplexer only types into a session", () => {
    expect(ruleOf(bash("tmux send-keys -t x open Enter"))).toBe("allow");
  });
  // Deliberate fail-closed trade-off: a runner's options are not modelled, so every later word is
  // judged as a command, and these ordinary lines are refused (refusal telemetry measures the cost).
  it.each([
    "pnpm exec vitest run -t batch apps/x.test.ts",
    "npx vitest run -t open",
    "npx tsx scripts/run.ts batch",
    "npx cypress open",
    "pnpm exec vitest run -t at",
    "pnpm -s exec vitest run -t at",
    "pnpm -s exec tsx x.ts open",
  ])("refuses a launcher word among a runner's arguments: %s", (c) => {
    expect(ruleOf(bash(c))).toBe("background");
  });
  it.each([
    "env open .",
    "command at now",
    'sh -c "open x"',
    "xargs open",
    "pnpm exec open .",
    "npx open .",
    "ssh-agent sh",
    "ssh-agent -k",
    "/usr/bin/ssh-agent -s",
    "gpg-agent --daemon",
    "gpgconf --launch gpg-agent",
    "systemd-run sleep 9",
    "daemonize /bin/sleep 9",
    // a runner's options, `--` or another runner first: the command may be any later word
    "npx -y open .",
    "npx --yes open .",
    "npx -y -- open .",
    "npx -p foo open .",
    "npx --package=foo open .",
    "npx -c open",
    "npx -y bash -c open",
    "bunx --bun open .",
    "pnpm dlx -y open .",
    "npm exec -- open .",
    "npm exec --yes -- open .",
    "npm x -y open .",
    "pnpm exec -- open .",
    "pnpm exec -- launchctl load x.plist",
    "uvx --from x open",
    "npx -y osascript -e 'tell app \"Terminal\" to activate'",
    "npx -y crontab f",
    "npx -y at now",
    "npx -y env open .",
    "watch -n 1 open .",
    "watch -n1 open .",
    "watch -n 9 crontab f",
    "caffeinate -i open .",
    "caffeinate -t 5 open .",
    "flock f open .",
    "flock /tmp/l launchctl submit -l x -- /bin/sh -c x",
    "script -q /dev/null open .",
    "taskset 0x1 open .",
    "ionice -c3 open .",
    "doas -u root open .",
    "npx npx open .",
    "pnpm exec npx open .",
    "npx watch open .",
    "watch npx open .",
    "unbuffer npx open .",
    "timeout 5 npx -y open .",
    "=npx -y open .",
    "npx -y ssh-agent sh",
    "npx -y =open .",
    "npx -y vitest run -t open",
    "npm exec -- vitest run -t batch",
    // an option value that looks like a run verb only moves where the judged words start
    "npm --prefix dlx x open .",
    "npm --prefix x x open .",
    "pnpm -C dlx dlx open .",
    "pnpm --filter dlx dlx open .",
    "pnpm --dir x x open .",
    "yarn --cwd dlx dlx open .",
    // an expansion, glob or EQUALS word as the runner's first word
    "npx $X open .",
    'npx "$X" open .',
    "npx ${X} open .",
    "npx $(echo -y) open .",
    "npx `echo -y` open .",
    "npx * open .",
    "npx [-]y open .",
    "npx =npx open .",
    "npx =npx -y open .",
    "npx =watch open .",
    // pnpm and yarn run a binary for a word that is not their own command
    "pnpm open .",
    "pnpm -s open .",
    "yarn open .",
    "yarn run open .",
    // a verb-looking later word is an argument, not the verb: the binary is still judged
    "pnpm open . x",
    "pnpm open -a Calculator --args x",
    "pnpm open -a Calculator --args exec",
    "pnpm osascript -e 'display dialog \"hi\"' x",
    "pnpm crontab x",
    "pnpm launchctl load x",
    "pnpm at now dlx",
    "pnpm gpgconf --launch gpg-agent x",
    "pnpm Open . x",
    "yarn open . x",
    "yarn run open . exec",
    "npm --prefix foo exec open .",
    // yarn workspace forms run a command too
    "yarn workspace foo open .",
    "yarn workspaces foreach -A open",
    "yarn workspaces foreach -A run open",
    // more shells read -c scripts
    "fish -c open",
    "ksh -c open",
    "mksh -c open",
    "tcsh -c open",
    "csh -c open",
    "pwsh -c 'open .'",
    // GnuPG takes unambiguous option prefixes
    "gpg-agent --dae",
    "gpg-agent --daemon=x",
    "gpgconf --la gpg-agent",
    "gpgconf --lau gpg-agent",
  ])("still refuses a launcher that is the command: %s", (c) => {
    expect(ruleOf(bash(c))).toBe("background");
  });

  it("fails closed on an eval command-word expansion", () => {
    expect(ruleOf(bash('eval "$(ssh-agent -s)"'))).toBe("unreadable");
  });

  it.each(["tmux kill-$X", "tmux ls $X", "tmux -L $S ls", "tmux ls `x`"])(
    "refuses tmux with an expansion that could become a command: %s",
    (c) => {
      expect(ruleOf(bash(c))).toBe("background");
    },
  );
});

describe("wholeFileRead", () => {
  const read = (input: GuardEvent["input"], tool = "Read") => wholeFileRead({ tool, input });
  it("names the file of a Read with no range", () => {
    expect(read({ file_path: "/w/a.ts" })).toBe("/w/a.ts");
  });
  it("passes a Read with an offset or a limit", () => {
    expect(read({ file_path: "/w/a.ts", offset: 100 })).toBeNull();
    expect(read({ file_path: "/w/a.ts", limit: 50 })).toBeNull();
  });
  it("passes a Read of a page range", () => {
    expect(read({ file_path: "/w/spec.pdf", pages: "1-5" })).toBeNull();
  });
  it.each(["cat a.ts", "cat -- a.ts", "sed -n p a.ts", "sed -n '1,$p' a.ts"])(
    "names the file of the whole-file shell read %s",
    (command) => expect(read({ command }, "Bash")).toBe("a.ts"),
  );
  it.each([
    "sed -n '10,40p' a.ts",
    "sed -n 10,40p a.ts",
    "cat a.ts b.ts",
    "cat a.ts | head",
    "cat a.ts > b.ts",
    "cat < a.ts",
    "cat $F",
    "cat -n a.ts",
    "head -50 a.ts",
    "cat a.ts && ls",
  ])("passes %s", (command) => expect(read({ command }, "Bash")).toBeNull());
  it("ignores other tools", () => {
    expect(read({ file_path: "/w/a.ts" }, "Edit")).toBeNull();
  });
});

describe("rereadVerdict", () => {
  const big = REREAD_MIN_BYTES;
  const prior: ReadRecord = { size: big, mtimeMs: 5, compactions: 0, toolUseId: "toolu_1", at: 1 };
  const now = { size: big, mtimeMs: 5, compactions: 0 };
  it("refuses a second whole read of an unchanged large file, naming the earlier read", () => {
    const v = rereadVerdict("a.ts", now, prior);
    expect(v.kind).toBe("deny");
    if (v.kind !== "deny") return;
    expect(v.text).toContain("toolu_1");
    expect(v.text).toContain("offset and limit");
    expect(v.tokensSaved).toBe(Math.ceil(big / 4));
  });
  it("passes a first read", () => {
    expect(rereadVerdict("a.ts", now, undefined)).toEqual({ kind: "allow" });
  });
  it("passes a file under the threshold", () => {
    const small = { ...now, size: big - 1 };
    expect(rereadVerdict("a.ts", small, { ...prior, size: big - 1 })).toEqual({ kind: "allow" });
  });
  it("passes a changed file (mtime or size)", () => {
    expect(rereadVerdict("a.ts", { ...now, mtimeMs: 6 }, prior)).toEqual({ kind: "allow" });
    expect(rereadVerdict("a.ts", { ...now, size: big + 1 }, prior)).toEqual({ kind: "allow" });
  });
  it("passes after a compaction, when the earlier read is no longer in context", () => {
    expect(rereadVerdict("a.ts", { ...now, compactions: 1 }, prior)).toEqual({ kind: "allow" });
  });
});
