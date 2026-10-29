import { defineConfig } from "vitest/config";

// The server suites that spawn real keeper and fake-CLI process trees. Run side by side on a
// 2-vCPU CI shard, their cleanup waits timed out (#810: 16 of 28 failed runs, 27–28 Oct), so they
// run in their own project, one file at a time.
const PROCESS_SUITES = [
  "apps/server/test/supervisor-*.test.ts",
  "apps/server/test/startup.test.ts",
  "apps/server/test/codex-safety.test.ts",
  "apps/server/test/codex-session.test.ts",
  "apps/server/test/keeper.test.ts",
  "apps/server/test/keeper-process.test.ts",
  "apps/server/test/runtime-session.test.ts",
];

// Per-project environments: node for the server and core, jsdom for the web app (its own config).
export default defineConfig({
  test: {
    passWithNoTests: true,
    // Several crew seats and the observed loops share one 10-core Mac: unbounded workers (about
    // nine per run) drove its load past 18. Off CI, a run uses at most 3 workers; CI keeps the default.
    maxWorkers: process.env.CI ? undefined : 3,
    projects: [
      {
        test: {
          name: "server",
          environment: "node",
          include: ["apps/server/test/**/*.test.ts"],
          exclude: PROCESS_SUITES,
          // A loaded CI shard ran tests that take 0.1–0.5 s here past vitest's 5 s default (24 Oct).
          testTimeout: 15_000,
        },
      },
      {
        test: {
          name: "server-process",
          environment: "node",
          include: PROCESS_SUITES,
          testTimeout: 15_000,
          // one fork runs the files in turn (a project can't set fileParallelism)
          poolOptions: { forks: { singleFork: true } },
        },
      },
      {
        test: {
          name: "core",
          environment: "node",
          include: ["packages/**/test/**/*.test.ts"],
        },
      },
      "apps/web",
    ],
  },
});
