import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EVIDENCE_PAGES, prEvidenceAffectedPages } from "@mc/core";
import { afterEach, describe, expect, it } from "vitest";
import { readHeadWebPageGraph, readWebPageGraph } from "../src/pr-evidence/import-graph.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A web source tree with a lazy page boundary, written to a temp dir. */
function tree(): string {
  const root = mkdtempSync(join(tmpdir(), "mc-graph-"));
  dirs.push(root);
  const files: Record<string, string> = {
    "main.tsx": `import "./hud.css";\nimport { App } from "./App.tsx";\n`,
    "App.tsx": [
      `import { lazy } from "react";`,
      `import { Header } from "./shell/Header.tsx";`,
      `import type { Row } from "./types.ts";`,
      `const Needs = lazy(() => import("./pages/Needs.tsx"));`,
      `const Comms = lazy(() => import("./pages/Comms.tsx"));`,
      `const Setup = lazy(() => import("./pages/Setup.tsx"));`,
      `const Ticket = lazy(() => import("./pages/TicketPage.tsx"));`,
    ].join("\n"),
    "hud.css": "",
    "types.ts": "",
    "shell/Header.tsx": `import { badge } from "../shell/badge.ts";\nexport {};`,
    "shell/badge.ts": "",
    "pages/Needs.tsx": `import { Brief } from "../comms/ItemBrief.tsx";\nimport "./needs.css";`,
    "pages/needs.css": `@import "../needs/more.css";`,
    "needs/more.css": "",
    "pages/Comms.tsx": `import { Brief } from "../comms/index.ts";\nimport("../comms/Lazy.tsx");`,
    "pages/Setup.tsx": `import { Accounts } from "../setup/Accounts.tsx";`,
    "pages/TicketPage.tsx": `import { x } from "../ticket/Ticket.tsx";`,
    "comms/index.ts": `export * from "./ItemBrief.tsx";`,
    "comms/ItemBrief.tsx": `import "./brief.css";\nexport const Brief = 1;`,
    "comms/brief.css": "",
    "comms/Lazy.tsx": "",
    "comms/Brief.test.tsx": `import "./ItemBrief.tsx";`,
    "setup/Accounts.tsx": "",
    "ticket/Ticket.tsx": "",
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

const P = (name: string) => `apps/web/src/${name}`;

describe("readWebPageGraph", () => {
  it("reads a committed head instead of changed checkout files and removes its scratch archive", async () => {
    const repo = mkdtempSync(join(tmpdir(), "mc-head-graph-"));
    dirs.push(repo);
    const src = join(repo, "apps/web/src");
    mkdirSync(join(src, "pages"), { recursive: true });
    mkdirSync(join(src, "comms"), { recursive: true });
    writeFileSync(join(src, "App.tsx"), `import("./pages/Needs.tsx");`);
    writeFileSync(join(src, "pages/Needs.tsx"), `import "../comms/ItemBrief.tsx";`);
    writeFileSync(join(src, "comms/ItemBrief.tsx"), "export {};");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture head",
    );
    const sha = git("rev-parse", "HEAD");
    writeFileSync(join(src, "pages/Needs.tsx"), "export {};");
    const scratch = join(repo, "scratch");
    mkdirSync(scratch);
    const graph = await readHeadWebPageGraph(repo, sha, new AbortController().signal, scratch);
    expect(graph[P("comms/ItemBrief.tsx")]).toEqual(["needs"]);
    expect(readdirSync(scratch)).toEqual([]);
    await expect(
      readHeadWebPageGraph(repo, "f".repeat(40), new AbortController().signal, scratch),
    ).rejects.toThrow();
    expect(readdirSync(scratch)).toEqual([]);
    const controller = new AbortController();
    controller.abort();
    await expect(readHeadWebPageGraph(repo, sha, controller.signal, scratch)).rejects.toThrow();
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("does not read files through source-tree symlinks", () => {
    const root = tree();
    symlinkSync(join(root, "comms"), join(root, "outside"));
    expect(readWebPageGraph(root)[P("outside/ItemBrief.tsx")]).toBeUndefined();
  });
  it("lists a file used by two pages under both", () => {
    const graph = readWebPageGraph(tree());
    expect(graph[P("comms/ItemBrief.tsx")]).toEqual(["needs", "comms"]);
    expect(graph[P("comms/brief.css")]).toEqual(["needs", "comms"]);
    expect(graph[P("comms/Lazy.tsx")]).toEqual(["comms"]);
    expect(prEvidenceAffectedPages([P("comms/ItemBrief.tsx")], graph)).toEqual(["needs", "comms"]);
  });

  it("keeps a file only one page uses to that page", () => {
    const graph = readWebPageGraph(tree());
    expect(graph[P("setup/Accounts.tsx")]).toEqual(["setup"]);
    expect(prEvidenceAffectedPages([P("setup/Accounts.tsx")], graph)).toEqual([
      "setup",
      "setup_repos",
      "setup_loops",
      "setup_accounts",
      "setup_roles",
      "setup_sources",
      "setup_access",
    ]);
    // CSS belongs to the file that imports it, and a CSS import to its importer
    expect(graph[P("pages/needs.css")]).toEqual(["needs"]);
    expect(graph[P("needs/more.css")]).toEqual(["needs"]);
  });

  it("counts what the shell reaches for every page; a lazy page is not the shell's", () => {
    const graph = readWebPageGraph(tree());
    for (const name of ["shell/Header.tsx", "shell/badge.ts", "hud.css", "App.tsx", "types.ts"])
      expect(graph[P(name)]).toEqual(EVIDENCE_PAGES);
    expect(graph[P("pages/Needs.tsx")]).toEqual(["needs"]);
    expect(prEvidenceAffectedPages([P("shell/Header.tsx")], graph)).toEqual(EVIDENCE_PAGES);
  });

  it("leaves out tests and files only an unphotographed page reaches", () => {
    const graph = readWebPageGraph(tree());
    expect(graph[P("comms/Brief.test.tsx")]).toBeUndefined();
    expect(graph[P("ticket/Ticket.tsx")]).toEqual([]);
    expect(prEvidenceAffectedPages([P("ticket/Ticket.tsx")], graph)).toEqual([]);
  });

  it("keeps a static page edge even when the same specifier is also lazy", () => {
    const root = tree();
    writeFileSync(
      join(root, "App.tsx"),
      `import "./pages/Needs.tsx"; import("./pages/Needs.tsx");`,
    );
    expect(readWebPageGraph(root)[P("comms/ItemBrief.tsx")]).toEqual(EVIDENCE_PAGES);
  });
});
