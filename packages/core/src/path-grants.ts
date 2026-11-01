/**
 * A ticket whose change sits outside every seat's area (the root `package.json`, `.gitignore`) lists
 * the files in a `Paths:` line. FLIGHT approves them with a logged decision before the start; the
 * run that starts may then write exactly those files, and no other run may.
 */
import { foldForMatch, globMatches, isProtectedPath } from "./runtime.ts";

/** A `Paths:` line of a ticket body, with an optional list marker in front. */
const PATHS_LINE = /^[ \t]*(?:[-*][ \t]+)?Paths:[ \t]*(.*)$/gm;
/** One path: plain segments joined with `/`; no glob, no `.` or `..` segment, no leading or trailing `/`. */
const PLAIN_PATH = /^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;

/**
 * Files the crew's own rules and hooks run from, or that hide a file from the hub's diff reads. No
 * grant covers them: a seat that could write them could widen its own write set.
 */
export const UNGRANTABLE_PATHS = [
  ".git",
  ".github/**",
  ".husky/**",
  ".claude/**",
  ".codex/**",
  ".gitmodules",
  ".gitattributes",
  ".npmrc",
  ".pnpmfile.cjs",
] as const;

/** The paths a ticket body lists in its `Paths:` lines, in order, once each. Empty when none. */
export function ticketPathGrants(body: string): string[] {
  const found: string[] = [];
  for (const m of body.matchAll(PATHS_LINE)) {
    for (const raw of (m[1] ?? "").split(/[\s,]+/)) {
      const p = raw.replace(/^`+|`+$/g, "");
      if (p !== "" && !found.includes(p)) found.push(p);
    }
  }
  return found;
}

/**
 * Why `path` cannot be granted, or null. A grant names one file. A nested file that a protected
 * glob covers is refused as well: the CLI's Edit denies match those globs at any depth and cannot
 * be narrowed to one nested file.
 */
export function pathGrantProblem(path: string, extra: readonly string[] = []): string | null {
  if (!PLAIN_PATH.test(path) || path.split("/").some((s) => s === "." || s === "..")) {
    return "it is not a plain repo-relative file path";
  }
  if (path.split("/").includes(".git")) return "it is inside a .git folder";
  if (
    UNGRANTABLE_PATHS.some((g) => globMatches(g, foldForMatch(path), true) || globMatches(g, path))
  ) {
    return "the crew's own rules and hooks run from it";
  }
  if (path.includes("/") && isProtectedPath(path, extra)) {
    return "a protected-file rule covers it in a folder, so only a file at the repo's top can be granted";
  }
  return null;
}

/** Whether a run holding `grants` may write `path`. A grant is the exact file, folded as APFS folds names. */
export function grantedPath(grants: readonly string[], path: string): boolean {
  const p = foldForMatch(path);
  return grants.some((g) => foldForMatch(g) === p);
}

/** The words of the FLIGHT decision that approves `paths` for `ref`; `approvedGrantPaths` reads them back. */
export const grantDecisionText = (ref: string, paths: readonly string[]): string =>
  `Approved ${ref} to write ${paths.join(", ")}`;

/** The paths a grant decision's text approves, or an empty list for text that is not one. */
export function approvedGrantPaths(ref: string, decision: string): string[] {
  const head = `Approved ${ref} to write `;
  return decision.startsWith(head) ? decision.slice(head.length).split(", ") : [];
}

export const grantRefusedText = (ref: string, paths: readonly string[]): string =>
  `Not started: ${ref} lists Paths: ${paths.join(", ")} outside the seat's area, and FLIGHT has not approved them. FLIGHT approves with mc start_seat { paths }.`;
export const grantUngrantableText = (path: string, why: string): string =>
  `Not started: Paths: ${path} cannot be granted: ${why}.`;
export const GRANT_NOT_LISTED_TEXT =
  "Not started: paths were given, but the ticket has no Paths: line. Add the line to the ticket, then start it again.";
export const grantNotOnTicketText = (ref: string, paths: readonly string[]): string =>
  `Not started: ${paths.join(", ")} is not in ${ref}'s Paths: line. A grant covers only what the ticket lists.`;
export const GRANT_PLANNER_TEXT = "Not started: a planner writes no files, so paths do not apply.";
