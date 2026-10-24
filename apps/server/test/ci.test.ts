import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import config from "../../../vitest.config.ts";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

describe("CI", () => {
  it("pins pnpm through packageManager", () => {
    expect(JSON.parse(read("package.json")).packageManager).toBe("pnpm@11.28.7");
    expect(read(".github/workflows/ci.yml")).not.toMatch(/version: 11/);
  });

  it("runs three jobs behind the required check, including failures and cancellations", () => {
    const workflow = read(".github/workflows/ci.yml");
    expect(workflow).toContain("needs: [validate, server, web-core]");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression.
    expect(workflow).toContain("if: ${{ always() }}");
    for (const job of ["validate", "server", "web-core"]) {
      expect(workflow).toContain(`needs.${job}.result`);
    }
    expect(workflow).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression.
      "pnpm exec vitest run --project server --shard=${{ matrix.shard }}/2",
    );
    expect(workflow).toMatch(
      /server:\n {4}runs-on: ubuntu-latest\n {4}strategy:\n {6}matrix:\n {8}shard: \[1, 2\]/,
    );
    expect(workflow).toContain("pnpm exec vitest run --project web --project core");
  });

  it("assigns server and core tests to separate projects", () => {
    expect(config.test?.projects).toContainEqual({
      test: {
        name: "server",
        environment: "node",
        include: ["apps/server/test/**/*.test.ts"],
      },
    });
    expect(config.test?.projects).toContainEqual({
      test: {
        name: "core",
        environment: "node",
        include: ["packages/**/test/**/*.test.ts"],
      },
    });
  });
});
