import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** Test files whose callbacks must each reach an assertion, directly or through a helper in the file. */
const ROOTS = ["../../server/test", "../../../packages/core/test"];
const here = dirname(fileURLToPath(import.meta.url));

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules") walk(path, out);
    } else if (name.endsWith(".test.ts")) out.push(path);
  }
  return out;
};

const ASSERTION = /\b(?:expect|expectTypeOf|assert|fail)\b|\.(?:rejects|resolves)\b|toThrow/;

/** Tests in `source` whose body never reaches an assertion. */
export function testsWithoutAssertion(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const helpers = new Map<string, ts.Node>();
  const collect = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) helpers.set(n.name.text, n.body);
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    )
      helpers.set(n.name.text, n.initializer.body);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const asserting = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, body] of helpers) {
      if (asserting.has(name)) continue;
      const text = body.getText(sf);
      if (ASSERTION.test(text) || [...asserting].some((h) => new RegExp(`\\b${h}\\b`).test(text))) {
        asserting.add(name);
        changed = true;
      }
    }
  }
  const missing: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf);
      const isTest =
        /^(?:it|test)(?:\.each\([\s\S]*\))?$/.test(callee) || /^(?:it|test)\.each/.test(callee);
      const cb = n.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
      if (isTest && cb) {
        const text = cb.getText(sf);
        const reaches =
          ASSERTION.test(text) || [...asserting].some((h) => new RegExp(`\\b${h}\\b`).test(text));
        if (!reaches) {
          const title = n.arguments[0]?.getText(sf) ?? "";
          missing.push(
            `${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${title}`,
          );
        }
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

  it("has no test in the server or core suites that never reaches an assertion", () => {
    const missing = ROOTS.flatMap((root) =>
      walk(join(here, root)).flatMap((file) =>
        testsWithoutAssertion(file, readFileSync(file, "utf8")),
      ),
    );
    expect(missing).toEqual([]);
  });
});
