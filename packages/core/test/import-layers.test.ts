import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { afterEach, expect, it } from "vitest";

// The layer check lives in this test (it runs in CI), not in scripts/check-core-cycles.ts.
type Layer = "core" | "server" | "web";
const LAYER_ROOTS: Readonly<Record<Layer, string>> = {
  core: "packages/core/src",
  server: "apps/server/src",
  web: "apps/web/src",
};
const LAYER_PACKAGES: Readonly<Record<string, Layer>> = {
  "@mc/core": "core",
  "@mc/server": "server",
  "@mc/web": "web",
};
const LAYER_FORBIDDEN: Readonly<Record<Layer, readonly Layer[]>> = {
  core: ["server", "web"],
  server: ["web"],
  web: ["server"],
};
interface LayerBreak {
  from: string;
  to: string;
  fromLayer: Layer;
  toLayer: Layer;
}
const RESOLVER_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  jsx: ts.JsxEmit.Preserve,
};

function moduleSpecifiers(file: string): string[] {
  const names: string[] = [];
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const record = (value: ts.Node | undefined) => {
    if (value && ts.isStringLiteralLike(value)) names.push(value.text);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) record(node.moduleSpecifier);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      record(node.argument.literal);
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      record(node.moduleReference.expression);
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    )
      record(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.[cm]?tsx?$/.test(entry.name)) files.push(resolve(path));
    }
  };
  walk(directory);
  return files;
}

function layerBreaks(root: string): LayerBreak[] {
  const base = resolve(root);
  const slash = (path: string) => relative(base, path).split(sep).join("/");
  const layers = Object.keys(LAYER_ROOTS) as Layer[];
  const found = new Map<string, LayerBreak>();
  for (const fromLayer of layers) {
    const folder = join(base, LAYER_ROOTS[fromLayer]);
    if (!existsSync(folder)) continue;
    for (const file of sourceFiles(folder)) {
      for (const spec of moduleSpecifiers(file)) {
        let to: string | null = null;
        let toLayer: Layer | null = null;
        const named = Object.keys(LAYER_PACKAGES).find(
          (key) => spec === key || spec.startsWith(`${key}/`),
        );
        if (named) {
          to = spec;
          toLayer = LAYER_PACKAGES[named] ?? null;
        } else if (spec.startsWith(".")) {
          const resolved = ts.resolveModuleName(spec, file, RESOLVER_OPTIONS, ts.sys).resolvedModule
            ?.resolvedFileName;
          const path = slash(resolved ?? resolve(dirname(file), spec));
          to = path;
          toLayer = layers.find((layer) => path.startsWith(`${LAYER_ROOTS[layer]}/`)) ?? null;
        }
        if (!to || !toLayer || !LAYER_FORBIDDEN[fromLayer].includes(toLayer)) continue;
        const from = slash(file);
        found.set(`${from}\0${to}`, { from, to, fromLayer, toLayer });
      }
    }
  }
  return [...found.values()].sort((a, b) =>
    a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1,
  );
}
const describe = (b: LayerBreak) =>
  `Layer break: ${b.from} imports ${b.to}; ${b.fromLayer} must not import ${b.toLayer}.`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "mc-layers-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(resolve(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}
it("reports a deliberate layer break with the file, the import and the rule", () => {
  const dir = fixture({
    "packages/core/src/a.ts":
      'import { s } from "../../../apps/server/src/s.ts"; export const a = s;',
    "apps/server/src/s.ts": "export const s = 1;",
  });
  expect(layerBreaks(dir).map(describe)).toEqual([
    "Layer break: packages/core/src/a.ts imports apps/server/src/s.ts; core must not import server.",
  ]);
});

it("lists every layer break and allows imports of core", () => {
  const dir = fixture({
    "apps/server/src/x.ts": 'import "../../web/src/w.tsx";',
    "apps/server/src/ok.ts": 'import { c } from "@mc/core"; export const o = c;',
    "apps/web/src/w.tsx": 'import { x } from "@mc/server"; export const w = x;',
    "apps/web/src/ok.ts":
      'import { c } from "../../../packages/core/src/c.ts"; export const o = c;',
    "packages/core/src/t.ts": 'export type T = import("../../../apps/web/src/w.tsx").W;',
    "packages/core/src/d.ts": 'export const d = () => import("../../../apps/server/src/x.ts");',
    "packages/core/src/c.ts": "export const c = 1;",
  });
  expect(layerBreaks(dir)).toEqual([
    {
      from: "apps/server/src/x.ts",
      to: "apps/web/src/w.tsx",
      fromLayer: "server",
      toLayer: "web",
    },
    { from: "apps/web/src/w.tsx", to: "@mc/server", fromLayer: "web", toLayer: "server" },
    {
      from: "packages/core/src/d.ts",
      to: "apps/server/src/x.ts",
      fromLayer: "core",
      toLayer: "server",
    },
    {
      from: "packages/core/src/t.ts",
      to: "apps/web/src/w.tsx",
      fromLayer: "core",
      toLayer: "web",
    },
  ]);
});

it("finds no layer break in this repository", () => {
  expect(layerBreaks(resolve(import.meta.dirname, "../../..")).map(describe)).toEqual([]);
});
