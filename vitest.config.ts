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
