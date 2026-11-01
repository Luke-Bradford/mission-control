/** Lint the complete core import graph, including type-only and re-export edges. */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export function coreImportGraph(directory: string): Map<string, Set<string>> {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.[cm]?tsx?$/.test(entry.name)) files.push(resolve(path));
    }
  };
  walk(resolve(directory));
  const graph = new Map(files.map((file) => [file, new Set<string>()]));
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    jsx: ts.JsxEmit.Preserve,
  };
  const cache = ts.createModuleResolutionCache(resolve(directory), (path) => path, options);
  const target = (file: string, name: string): string | null => {
    if (name === "@mc/core") {
      const index = resolve(directory, "index.ts");
      return graph.has(index) ? index : null;
    }
    if (!name.startsWith(".")) return null;
    const found = ts.resolveModuleName(name, file, options, ts.sys, cache).resolvedModule
      ?.resolvedFileName;
    return found && graph.has(found) ? found : null;
  };
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const record = (value: ts.Node | undefined) => {
      if (!value || !ts.isStringLiteralLike(value)) return;
      const path = target(file, value.text);
      if (path) graph.get(file)?.add(path);
    };
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        record(node.moduleSpecifier);
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
  }
  return graph;
}

/** Tarjan components; a self import is a cycle too. */
export function importCycles(graph: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  let next = 0;
  const index = new Map<string, number>(),
    low = new Map<string, number>();
  const stack: string[] = [],
    active = new Set<string>(),
    cycles: string[][] = [];
  const visit = (file: string) => {
    index.set(file, next);
    low.set(file, next++);
    stack.push(file);
    active.add(file);
    for (const dependency of graph.get(file) ?? []) {
      if (!index.has(dependency)) {
        visit(dependency);
        low.set(file, Math.min(low.get(file) as number, low.get(dependency) as number));
      } else if (active.has(dependency))
        low.set(file, Math.min(low.get(file) as number, index.get(dependency) as number));
    }
    if (low.get(file) !== index.get(file)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop() as string;
      active.delete(member);
      component.push(member);
    } while (member !== file);
    if (component.length > 1 || graph.get(file)?.has(file)) cycles.push(component.sort());
  };
  for (const file of graph.keys()) if (!index.has(file)) visit(file);
  return cycles.sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(process.argv[2] ?? "packages/core/src"),
    graph = coreImportGraph(directory);
  const cycles = importCycles(graph);
  if (cycles.length) {
    for (const component of cycles)
      console.error(
        `Core import cycle: ${component.map((file) => relative(directory, file)).join(", ")}`,
      );
    process.exitCode = 1;
  } else console.log(`Core imports: ${graph.size} modules, no cycles.`);
}
