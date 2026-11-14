import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** The biome part of the repo's own `lint` script, so this test follows any change to it. */
function lintBiomeArgs(): string[] {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts: { lint: string };
  };
  const biome = pkg.scripts.lint.split("&&")[0]?.trim() ?? "";
  const words = biome.split(/\s+/);
  expect(words.slice(0, 2)).toEqual(["biome", "check"]);
  // drop the trailing path; the test points biome at its own file
  return words.slice(1, -1);
}

it("a new biome warning makes the lint script's biome step exit non-zero", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-lint-warning-"));
  try {
    // an unused variable is a warning under the recommended rules, not an error
    writeFileSync(
      join(dir, "warns.ts"),
      "export function f() {\n  const unused = 1;\n  return 2;\n}\n",
    );
    const biome = join(root, "node_modules", ".bin", "biome");
    const run = (args: string[]) =>
      spawnSync(biome, [...args, `--config-path=${root}`, "warns.ts"], {
        cwd: dir,
        encoding: "utf8",
      });
    const args = lintBiomeArgs();
    expect(args).toContain("--error-on-warnings");
    const plain = run(["check"]);
    expect(plain.status, plain.stdout + plain.stderr).toBe(0);
    const strict = run(args);
    expect(strict.status).not.toBe(0);
    expect(strict.stdout + strict.stderr).toContain("noUnusedVariables");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
