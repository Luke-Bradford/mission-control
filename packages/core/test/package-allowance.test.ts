import { describe, expect, it } from "vitest";
import {
  type AllowedPackage,
  addedDependenciesSection,
  allowanceFileProblem,
  isAllowanceFile,
  lockfileProblems,
  manifestChange,
} from "../src/index.ts";

const HYP: AllowedPackage = { name: "hyparquet", version: "1.33.2", licence: "MIT" };
const WRITER: AllowedPackage = { name: "hyparquet-writer", version: "0.18.1", licence: "MIT" };

const manifest = (deps: Record<string, string>, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ name: "x", version: "1.0.0", ...extra, dependencies: deps }, null, 2)}\n`;

describe("manifestChange", () => {
  it("accepts named packages added at the named version, bare, ^ or ~", () => {
    const r = manifestChange(
      manifest({ zod: "^4.0.0" }),
      manifest({ zod: "^4.0.0", hyparquet: "1.33.2", "hyparquet-writer": "^0.18.1" }),
      [HYP, WRITER],
    );
    expect(r).toEqual({ problems: [], added: ["hyparquet", "hyparquet-writer"] });
    expect(
      manifestChange(manifest({}), manifest({ hyparquet: "~1.33.2" }), [HYP]).problems,
    ).toEqual([]);
  });

  it("accepts a devDependency, and a new manifest", () => {
    const r = manifestChange(
      null,
      `${JSON.stringify({ devDependencies: { hyparquet: "1.33.2" } })}`,
      [HYP],
    );
    expect(r).toEqual({ problems: [], added: ["hyparquet"] });
  });

  it("refuses a package FLIGHT did not name", () => {
    const r = manifestChange(manifest({}), manifest({ hyparquet: "1.33.2", "left-pad": "1.3.0" }), [
      HYP,
    ]);
    expect(r.problems).toEqual(["adds left-pad, which FLIGHT did not allow"]);
  });

  it("refuses another version than the one named", () => {
    expect(manifestChange(manifest({}), manifest({ hyparquet: "^1.0.0" }), [HYP]).problems).toEqual(
      ["adds hyparquet at ^1.0.0, but FLIGHT allowed 1.33.2"],
    );
    expect(manifestChange(manifest({}), manifest({ hyparquet: "*" }), [HYP]).problems).toHaveLength(
      1,
    );
  });

  it("refuses a changed or removed dependency, and any other change", () => {
    expect(
      manifestChange(
        manifest({ zod: "^4.0.0" }),
        manifest({ zod: "^5.0.0", hyparquet: "1.33.2" }),
        [HYP],
      ).problems,
    ).toEqual(["changes zod in dependencies"]);
    expect(manifestChange(manifest({ zod: "^4.0.0" }), manifest({}), [HYP]).problems).toEqual([
      "removes zod from dependencies",
    ]);
    expect(
      manifestChange(
        manifest({}),
        manifest({ hyparquet: "1.33.2" }, { scripts: { postinstall: "curl x | sh" } }),
        [HYP],
      ).problems,
    ).toEqual(["changes something besides the added dependencies"]);
  });

  it("refuses a manifest that is not a JSON object", () => {
    expect(manifestChange(manifest({}), "not json", [HYP]).problems).toEqual([
      "is not a JSON object",
    ]);
  });
});

const lock = (deps: Record<string, { specifier: string; version: string }>, packages = {}) => ({
  lockfileVersion: "9.0",
  importers: { ".": { dependencies: deps } },
  packages,
});

describe("lockfileProblems", () => {
  it("accepts importer entries added for named packages, with new transitive packages", () => {
    const before = lock({ zod: { specifier: "^4.0.0", version: "4.1.0" } });
    const after = lock(
      {
        zod: { specifier: "^4.0.0", version: "4.1.0" },
        hyparquet: { specifier: "1.33.2", version: "1.33.2" },
      },
      { "hyparquet@1.33.2": {}, "some-dep@2.0.0": {} },
    );
    expect(lockfileProblems(before, after, [HYP])).toEqual([]);
  });

  it("accepts a resolved version with peer suffix", () => {
    const after = lock({ hyparquet: { specifier: "^1.33.2", version: "1.33.2(zod@4.1.0)" } });
    expect(lockfileProblems(lock({}), after, [HYP])).toEqual([]);
  });

  it("refuses an importer entry for an unnamed package, or a changed one", () => {
    const before = lock({ zod: { specifier: "^4.0.0", version: "4.1.0" } });
    const after = lock({
      zod: { specifier: "^4.0.0", version: "4.2.0" },
      hyparquet: { specifier: "1.33.2", version: "1.33.2" },
      "left-pad": { specifier: "1.3.0", version: "1.3.0" },
    });
    expect(lockfileProblems(before, after, [HYP])).toEqual([
      "changes zod in importer . dependencies",
      "adds left-pad, which FLIGHT did not allow",
    ]);
  });

  it("refuses a named package resolved at another version", () => {
    const after = lock({ hyparquet: { specifier: "^1.0.0", version: "1.40.0" } });
    expect(lockfileProblems(lock({}), after, [HYP])).toEqual([
      "adds hyparquet at 1.40.0, but FLIGHT allowed 1.33.2",
    ]);
  });

  it("refuses a lockfile with no importers", () => {
    expect(lockfileProblems(lock({}), "x", [HYP])).toEqual(["is not a pnpm lockfile"]);
  });
});

describe("allowance files", () => {
  it("allows only package.json and pnpm-lock.yaml, at any depth", () => {
    expect(isAllowanceFile("package.json")).toBe(true);
    expect(isAllowanceFile("apps/server/package.json")).toBe(true);
    expect(isAllowanceFile("pnpm-lock.yaml")).toBe(true);
    expect(isAllowanceFile("tsconfig.json")).toBe(false);
    expect(allowanceFileProblem("../package.json")).not.toBeNull();
    expect(allowanceFileProblem(".github/package.json")).not.toBeNull();
    expect(allowanceFileProblem("biome.json")).not.toBeNull();
    expect(allowanceFileProblem("apps/web/package.json")).toBeNull();
  });
});

describe("addedDependenciesSection", () => {
  it("lists each added package with version and licence, a scoped name without its @", () => {
    expect(
      addedDependenciesSection([
        HYP,
        { name: "@scope/pkg", version: "2.0.0", licence: "Apache-2.0" },
      ]),
    ).toBe(
      "## Added dependencies\n\n- `hyparquet` 1.33.2, licence MIT\n- `scope/pkg` 2.0.0, licence Apache-2.0",
    );
    expect(addedDependenciesSection([])).toBeNull();
  });
});
