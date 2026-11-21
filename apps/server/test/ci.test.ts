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
    // every sharded job lists as many shards as its command divides by, so no test file is skipped
    const shards = (job: string) => {
      const from = workflow.indexOf(`\n  ${job}:\n`) + 1;
      // this job's lines only: up to the next job heading, so a missing value is not read from a later job
      const next = workflow.slice(from + 1).search(/\n {2}[a-z-]+:\n/);
      const body = next < 0 ? workflow.slice(from) : workflow.slice(from, from + 1 + next);
      const list = /shard: \[([\d, ]+)\]/.exec(body)?.[1].split(",").map(Number) ?? [];
      const of = Number(/--shard=\$\{\{ matrix\.shard \}\}\/(\d+)/.exec(body)?.[1]);
      return { list, of };
    };
    for (const job of ["server", "server-process", "web-core"]) {
      const { list, of } = shards(job);
      expect(list, job).toEqual(Array.from({ length: of }, (_, i) => i + 1));
      expect(of, job).toBeGreaterThan(1);
    }
    expect(workflow).toContain("ci-vitest.ts --project server --shard=");
    expect(workflow).toContain("ci-vitest.ts --project server-process --shard=");
    expect(workflow).toContain("vitest run --project web --project core --shard=");
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
        testTimeout: 15_000,
      },
    });
  });
});
