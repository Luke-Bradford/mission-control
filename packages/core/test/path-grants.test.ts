import { describe, expect, it } from "vitest";
import {
  approvedGrantPaths,
  type CrewCliInput,
  crewCliArgs,
  grantDecisionText,
  grantedPath,
  pathGrantProblem,
  protectedFileRules,
  ticketPathGrants,
} from "../src/index.ts";

describe("ticketPathGrants", () => {
  it("reads a Paths: line, with a list marker, backticks and commas", () => {
    expect(ticketPathGrants("## What\n\nPaths: package.json\n")).toEqual(["package.json"]);
    expect(ticketPathGrants("- Paths: `package.json`, `.gitignore`")).toEqual([
      "package.json",
      ".gitignore",
    ]);
  });

  it("ignores the word Paths: inside a sentence, and lists each path once", () => {
    expect(ticketPathGrants("A ticket can list `Paths:` outside the areas.")).toEqual([]);
    expect(ticketPathGrants("Paths: a.json\nPaths: a.json b.json")).toEqual(["a.json", "b.json"]);
  });
});

describe("pathGrantProblem", () => {
  it("accepts a file at the top, protected or not", () => {
    expect(pathGrantProblem("package.json")).toBeNull();
    expect(pathGrantProblem(".gitignore")).toBeNull();
    expect(pathGrantProblem("CLAUDE.md")).toBeNull();
  });

  it.each([
    "../x",
    "/etc/passwd",
    "a/../b",
    "src/*",
    "a b",
    "dir/",
    ".git",
    "x/.git/config",
    ".github/workflows/ci.yml",
    ".claude/settings.json",
    ".codex/config.toml",
    ".husky/pre-commit",
    ".npmrc",
    ".gitattributes",
    "apps/web/package.json",
  ])("refuses %s", (p) => {
    expect(pathGrantProblem(p)).not.toBeNull();
  });
});

describe("grantedPath and the decision text", () => {
  it("matches the exact file, folding case as APFS does", () => {
    expect(grantedPath(["package.json"], "package.json")).toBe(true);
    expect(grantedPath(["package.json"], "Package.json")).toBe(true);
    expect(grantedPath(["package.json"], "apps/web/package.json")).toBe(false);
    expect(grantedPath([], "package.json")).toBe(false);
  });

  it("reads back the paths a decision approved for its own ticket only", () => {
    const text = grantDecisionText("mc#1", ["package.json", ".gitignore"]);
    expect(approvedGrantPaths("mc#1", text)).toEqual(["package.json", ".gitignore"]);
    expect(approvedGrantPaths("mc#2", text)).toEqual([]);
  });
});

describe("a run's Edit and Write rules with a grant", () => {
  const cwd = "/w/x";
  const denies = (granted: string[]) => protectedFileRules(cwd, [], granted);

  it("denies the top package.json without a grant, and lets it through with one", () => {
    expect(denies([])).toContain("Edit(//w/x/**/package.json)");
    expect(denies(["package.json"])).not.toContain("Edit(//w/x/**/package.json)");
    expect(denies(["package.json"])).not.toContain("Write(//w/x/**/package.json)");
  });

  it("still denies a package.json in a folder, and every other protected file", () => {
    const rules = denies(["package.json"]);
    expect(rules).toContain("Edit(//w/x/*/**/package.json)");
    expect(rules).toContain("Edit(//w/x/pnpm-lock.yaml)");
    expect(rules).toContain("Edit(//w/x/**/tsconfig*.json)");
  });

  it("refuses a granted file in a protected folder", () => {
    expect(() => denies(["apps/web/package.json"])).toThrow(/cannot be granted/);
  });

  it("allows the granted file on the CLI line only for the run that holds it", () => {
    const base: CrewCliInput = {
      model: "sonnet",
      mode: "writer",
      rolePromptFile: "/mc/roles/GUIDO.md",
      sessionId: "11111111-2222-4333-8444-555555555555",
      resume: false,
      area: ["apps/server/**"],
      sandbox: {
        cwd: "/mc/wt/guido-1",
        gitCommonDir: "/mc/clone/.git",
        worktreeGitDir: "/mc/clone/.git/worktrees/guido-1",
        home: "/home/you",
        dataDir: "/home/you/.local/share/mission-control",
        denyRead: [],
        pnpmStoreDir: "/mc/crew/.mc-pnpm-store/shared",
      },
      mcpConfigFile: "/home/you/.local/share/mission-control/crew/guido-1:1.mcp.json",
      hook: { command: "'/n' || exit 2", timeoutS: 1 },
    };
    const withGrant = crewCliArgs({ ...base, granted: ["package.json"] });
    const without = crewCliArgs(base);
    expect(withGrant).toContain("Edit(//mc/wt/guido-1/package.json)");
    expect(withGrant).toContain("Write(//mc/wt/guido-1/package.json)");
    expect(without).not.toContain("Edit(//mc/wt/guido-1/package.json)");
    expect(without).toContain("Edit(//mc/wt/guido-1/**/package.json)");
    expect(withGrant).not.toContain("Edit(//mc/wt/guido-1/**/package.json)");
  });
});
