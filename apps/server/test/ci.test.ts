import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import config from "../../../vitest.config.ts";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

describe("CI", () => {
  it("pins pnpm through packageManager", () => {
    expect(JSON.parse(read("package.json")).packageManager).toBe("pnpm@11.28.7");
    expect(read(".github/workflows/ci.yml")).not.toMatch(/version: 11/);
  });

  it("runs four jobs behind the required check, including failures and cancellations", () => {
    const workflow = read(".github/workflows/ci.yml");
    expect(workflow).toContain("needs: [validate, server, server-process, web-core]");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression.
    expect(workflow).toContain("if: ${{ always() }}");
    for (const job of ["validate", "server", "server-process", "web-core"]) {
      expect(workflow).toContain(`needs.${job}.result`);
    }
    expect(workflow).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression.
      "pnpm exec vitest run --project server --shard=${{ matrix.shard }}/2",
    );
    expect(workflow).toMatch(
      /server:\n {4}runs-on: ubuntu-latest\n {4}strategy:\n {6}matrix:\n {8}shard: \[1, 2\]/,
    );
    expect(workflow).toContain("pnpm exec vitest run --project server-process\n");
    expect(workflow).toContain("pnpm exec vitest run --project web --project core");
  });

  it("assigns server and core tests to separate projects", () => {
    const projects = config.test?.projects ?? [];
    const named = (name: string) =>
      (projects as { test?: Record<string, unknown> }[]).find((p) => p.test?.name === name)?.test;
    const server = named("server");
    const proc = named("server-process");
    expect(server).toMatchObject({
      environment: "node",
      include: ["apps/server/test/**/*.test.ts"],
      // A loaded CI shard can take over vitest's 5 s default for tests that run in 0.1–0.5 s here.
      testTimeout: 15_000,
    });
    // The process-spawning suites (#810) run in their own project, one file at a time, and only there.
    expect(proc).toMatchObject({
      environment: "node",
      testTimeout: 15_000,
      poolOptions: { forks: { singleFork: true } },
    });
    expect(proc?.include).toContain("apps/server/test/supervisor-*.test.ts");
    expect(server?.exclude).toEqual(proc?.include);
    expect(projects).toContainEqual({
      test: {
        name: "core",
        environment: "node",
        include: ["packages/**/test/**/*.test.ts"],
      },
    });
  });
});
