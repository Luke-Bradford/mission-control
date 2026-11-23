import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "../../..");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);

/** Every `*.test.ts` and `*.test.tsx` file in the repository. */
const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
};

/** The identifier a call chain starts from: `it.skipIf(x)(...)` and `expect(x).toBe` give it and expect. */
const rootOf = (node: ts.Expression): string | null => {
  let n: ts.Expression = node;
  for (;;) {
    if (ts.isIdentifier(n)) return n.text;
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) n = n.expression;
    else if (ts.isCallExpression(n) || ts.isNonNullExpression(n) || ts.isParenthesizedExpression(n))
      n = n.expression;
    else if (ts.isAwaitExpression(n)) n = n.expression;
    else return null;
  }
};

const ASSERTERS = new Set(["expect", "expectTypeOf", "assert", "assertType"]);
/** Testing Library queries and waits that throw when what they look for is missing. */
const THROWING_QUERY = /^(?:find(?:All)?By\w+|get(?:All)?By\w+|waitFor(?:ElementToBeRemoved)?)$/;

/** Tests in `source` whose callback never makes an assertion call, directly or through a helper. */
export function testsWithoutAssertion(file: string, source: string): string[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);

  // Test factories: it, test, and any name bound to one (const itX = cond ? it : it.skip, it.skipIf(c)).
  const factories = new Set(["it", "test"]);
  const helpers = new Map<string, ts.Node>();
  const collect = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) helpers.set(n.name.text, n.body);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = n.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        helpers.set(n.name.text, init.body);
      else {
        const texts = [init.getText(sf)];
        if (ts.isConditionalExpression(init))
          texts.push(init.whenTrue.getText(sf), init.whenFalse.getText(sf));
        if (texts.some((t) => /^(?:it|test)(?:\.\w+(?:\([^)]*\))?)*$/.test(t.trim())))
          factories.add(n.name.text);
      }
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);

  /** `inHelper`: a same-file helper that throws on failure (a polling wait) counts as asserting. */
  const makesAssertion = (node: ts.Node, seen: Set<string>, inHelper = false): boolean => {
    let found = false;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (inHelper && ts.isThrowStatement(n)) {
        found = true;
        return;
      }
      if (ts.isCallExpression(n)) {
        const root = rootOf(n.expression);
        const callee = n.expression;
        const name = ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ts.isIdentifier(callee)
            ? callee.text
            : "";
        if (root !== null && ASSERTERS.has(root)) found = true;
        else if (THROWING_QUERY.test(name)) found = true;
        else if (
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "fail" &&
          root === "expect"
        )
          found = true;
        else if (root !== null && helpers.has(root) && !seen.has(root)) {
          seen.add(root);
          if (makesAssertion(helpers.get(root) as ts.Node, seen, true)) found = true;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
  };

  const missing: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const root = rootOf(n.expression);
      const callbackArg = n.arguments.find(
        (a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a),
      );
      const calledName = n.expression.getText(sf);
      const isTodoOrSkip = /\.(?:skip|todo)\b/.test(calledName.split("(")[0] ?? "");
      if (
        root !== null &&
        factories.has(root) &&
        callbackArg !== undefined &&
        !isTodoOrSkip &&
        n.arguments.indexOf(callbackArg) > 0 &&
        !makesAssertion(callbackArg, new Set())
      ) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
        missing.push(`${file}:${line} ${n.arguments[0]?.getText(sf) ?? ""}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return missing;
}

describe("every test asserts something", () => {
  it("finds a test with no assertion, and passes one that asserts through a helper", () => {
    const bare = 'import {it} from "vitest";\nit("a", () => { const x = 1; });';
    expect(testsWithoutAssertion("x.test.ts", bare)).toHaveLength(1);
    const helped =
      'import {it,expect} from "vitest";\nconst check = () => { expect(1).toBe(1); };\nit("a", () => { check(); });';
    expect(testsWithoutAssertion("x.test.ts", helped)).toEqual([]);
  });

  it("is not fooled by the word expect in a comment or a string", () => {
    const fooled = 'it("a", () => { // expect(1)\n  const s = "expect(2)"; });';
    expect(testsWithoutAssertion("x.test.ts", fooled)).toHaveLength(1);
  });

  it("counts a same-file helper that throws on failure, but not a bare throw in the test", () => {
    const polled =
      'async function eventually() { throw new Error("late"); }\nit("a", async () => { await eventually(); });';
    expect(testsWithoutAssertion("x.test.ts", polled)).toEqual([]);
  });

  it("checks conditional and aliased factories and TSX files", () => {
    const aliased =
      'const itX = process.env.X ? it : it.skip;\nconst itY = it.skipIf(true);\nitX("a", () => {});\nitY("b", () => {});';
    expect(testsWithoutAssertion("x.test.ts", aliased)).toHaveLength(2);
    const tsx = 'it("a", () => { const el = <div />; });';
    expect(testsWithoutAssertion("x.test.tsx", tsx)).toHaveLength(1);
  });

  it("has no test anywhere in the repository that never reaches an assertion", () => {
    const missing = walk(REPO).flatMap((file) =>
      testsWithoutAssertion(file, readFileSync(file, "utf8")),
    );
    expect(missing).toEqual([]);
  });
});
