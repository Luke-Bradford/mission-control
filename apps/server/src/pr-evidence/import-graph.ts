/**
 * Which HUD pages reach each file under `apps/web/src`, read from the static imports of a checkout.
 * A page is a file in `pages/` (the lazy `import()` in App.tsx is the boundary); the shell is what
 * `main.tsx` and `App.tsx` reach, and counts for every page. CSS belongs to the file that imports it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  EVIDENCE_PAGES,
  type EvidencePage,
  evidencePageOfPageFile,
  type WebPageGraph,
} from "@mc/core";

const SHELL_ROOTS = ["main.tsx", "App.tsx"];
const REPO_PREFIX = "apps/web/src/";
const SOURCE = /\.(?:[cm]?[jt]sx?|css)$/;
const TEST_FILE = /(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".css"];
const INDEXES = ["index.ts", "index.tsx", "index.js"];

/** `import … from "x"`, `export … from "x"`, `import "x"`, `import("x")` and CSS `@import "x"`. */
const FROM = /\b(?:import|export)\b[^'";]*?\bfrom\s*["']([^"']+)["']/g;
const SIDE_EFFECT = /\bimport\s*["']([^"']+)["']/g;
const DYNAMIC = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const CSS_IMPORT = /@import\s+(?:url\(\s*)?["']([^"']+)["']/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const matches = (re: RegExp, text: string): string[] =>
  [...text.matchAll(re)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));

/** The page of every dynamic import of a `pages/` file is a boundary, not an edge. */
export function readWebPageGraph(srcDir: string): WebPageGraph {
  const files = walk(srcDir).filter((f) => SOURCE.test(f));
  const key = (f: string): string => relative(srcDir, f).split(sep).join("/");
  const known = new Set(files.filter((f) => !TEST_FILE.test(key(f))).map(key));

  const resolveSpec = (from: string, spec: string): string | null => {
    if (!spec.startsWith(".")) return null;
    const base = relative(srcDir, resolve(dirname(join(srcDir, from)), spec.replace(/[?#].*$/, "")))
      .split(sep)
      .join("/");
    if (base.startsWith("..")) return null;
    for (const ext of EXTENSIONS) if (known.has(base + ext)) return base + ext;
    for (const index of INDEXES) if (known.has(`${base}/${index}`)) return `${base}/${index}`;
    return null;
  };

  const edges = new Map<string, string[]>();
  for (const name of known) {
    const text = readFileSync(join(srcDir, name), "utf8");
    const out: string[] = [];
    const specs = [
      ...matches(FROM, text),
      ...matches(SIDE_EFFECT, text),
      ...matches(DYNAMIC, text),
      ...matches(CSS_IMPORT, text),
    ];
    for (const spec of specs) {
      const target = resolveSpec(name, spec);
      if (target === null) continue;
      // a lazy page is a boundary; the page file is its own root
      if (target.startsWith("pages/") && matches(DYNAMIC, text).includes(spec)) continue;
      out.push(target);
    }
    edges.set(name, out);
  }

  const reach = (roots: string[]): Set<string> => {
    const seen = new Set<string>();
    const stack = roots.filter((r) => known.has(r));
    while (stack.length > 0) {
      const next = stack.pop() as string;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(edges.get(next) ?? []));
    }
    return seen;
  };

  const pages = new Map<string, Set<EvidencePage>>();
  const mark = (file: string, page: EvidencePage) => {
    const set = pages.get(file) ?? new Set<EvidencePage>();
    set.add(page);
    pages.set(file, set);
  };
  for (const file of reach(SHELL_ROOTS)) for (const page of EVIDENCE_PAGES) mark(file, page);
  for (const name of known) {
    if (!name.startsWith("pages/")) continue;
    const page = evidencePageOfPageFile(REPO_PREFIX + name);
    if (page === null) continue;
    for (const file of reach([name])) mark(file, page);
  }

  const graph: Record<string, EvidencePage[]> = {};
  for (const [file, set] of pages)
    graph[REPO_PREFIX + file] = EVIDENCE_PAGES.filter((p) => set.has(p));
  return graph;
}
