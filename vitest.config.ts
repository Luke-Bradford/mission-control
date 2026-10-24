import { defineConfig } from "vitest/config";

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
          // A loaded CI shard ran tests that take 0.1–0.5 s here past vitest's 5 s default (24 Oct).
          testTimeout: 15_000,
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
