/** Shared data and helpers; independent of domain control flow. */

/** Code that enforces FLIGHT's floors requires independent RETRO review. */
export const FLIGHT_FLOOR_ENFORCING_PATHS: readonly string[] = Object.freeze([
  "apps/server/src/away.ts",
  "apps/server/src/guard/**",
  "apps/server/src/mcp/**",
  "apps/server/src/runtime/**",
  "apps/server/src/engine/**",
  "apps/server/src/flight/**",
  "packages/core/src/away.ts",
  "packages/core/src/guard.ts",
  "packages/core/src/flight.ts",
  "packages/core/src/loop.ts",
  "packages/core/src/repo-rules.ts",
  "packages/core/src/runtime.ts",
  "packages/core/src/flight-model.ts",
  "packages/core/src/guard-model.ts",
  "packages/core/src/runtime-model.ts",
  "packages/core/src/repo-rules-model.ts",
  "packages/core/src/rule-paths.ts",
  "packages/core/src/loop-shared.ts",
  "apps/server/src/update.ts",
  "apps/server/src/config.ts",
  "apps/server/src/crew-apply.ts",
]);

export const DEFAULT_HARD_RULES: string[] = Object.freeze([
  ...FLIGHT_FLOOR_ENFORCING_PATHS,
  "packages/core/src/review.ts",
  "packages/core/src/review-model.ts",
  "loops/**",
  "roles/**",
  "CLAUDE.md",
  ".github/**",
  "config.example.yaml",
]) as string[];

/**
 * Paths whose change FLIGHT never clears on a `superuser` repo, whatever its `hard_rules_by`: the
 * operator or the delegate does (floor 7). CLAUDE.md is held unless the engine verifies
 * that its `## Mission Control` block is unchanged.
 */
export const FLIGHT_FLOOR_PATHS: readonly string[] = Object.freeze(["CLAUDE.md", ".github/**"]);
