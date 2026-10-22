/**
 * A repo's board rules, read from the `## Mission Control` section of its `CLAUDE.md`: which
 * statuses a seat may pick from, which area labels match a seat, and which paths are hard-rule
 * files. The parser is the server's; this is the shape, the defaults and the label match.
 */
import { pathInArea } from "./runtime.ts";

export interface RepoRules {
  /** Board statuses a seat may pick a ticket from. */
  pickFrom: string[];
  /** Whether the hub may promote Backlog tickets to a pickable status. */
  promoteBacklog: boolean;
  /** Area label → the globs it covers. */
  areas: Record<string, string[]>;
  /** Globs of files that need the operator's sign-off. */
  hardRules: string[];
  alwaysAsk: string[];
}

/**
 * Freezes `rules` and everything inside it, so a caller cannot corrupt the shared defaults or a
 * cached result. The type stays mutable: the freeze is the runtime guard.
 */
export function freezeRules(rules: RepoRules): RepoRules {
  for (const globs of Object.values(rules.areas)) Object.freeze(globs);
  Object.freeze(rules.areas);
  Object.freeze(rules.pickFrom);
  Object.freeze(rules.hardRules);
  Object.freeze(rules.alwaysAsk);
  return Object.freeze(rules);
}

export const DEFAULT_HARD_RULES: string[] = Object.freeze([
  "apps/server/src/guard/**",
  "apps/server/src/mcp/**",
  "apps/server/src/runtime/**",
  "apps/server/src/engine/**",
  "packages/core/src/guard.ts",
  "packages/core/src/loop.ts",
  "packages/core/src/review.ts",
  "packages/core/src/repo-rules.ts",
  "packages/core/src/runtime.ts",
  "loops/**",
  "roles/**",
  "CLAUDE.md",
  ".github/**",
  "config.example.yaml",
]) as string[];

export const DEFAULT_REPO_RULES: RepoRules = freezeRules({
  pickFrom: ["Ready"],
  promoteBacklog: false,
  areas: {},
  hardRules: DEFAULT_HARD_RULES,
  alwaysAsk: [],
});

/**
 * The area labels that match a seat, in `areas` order. A seat area of `[]` (the whole checkout)
 * matches every label; otherwise a label matches when each of its globs, with a trailing `/**`
 * cut to `/`, is a path the seat's area accepts (`apps/server/` is in `apps/server/**`; the bare
 * `apps/server` would not be, as `globMatches` wants the slash after a `/**` folder).
 */
export function areaLabelsFor(rules: RepoRules, seatArea: string[]): string[] {
  return Object.entries(rules.areas)
    .filter(
      ([, globs]) =>
        globs.length > 0 &&
        (seatArea.length === 0 ||
          globs.every((g) => pathInArea(seatArea, g.replace(/\/\*\*$/, "/")))),
    )
    .map(([label]) => label);
}
