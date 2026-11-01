/**
 * FLIGHT's full access (#1214): the hub routes `mc operator` may call, the verbs `mc gh_write`
 * runs, and the rules a controller can approve an override for. The repo's own rules are the only
 * floor; none of these lists is a cap on how often FLIGHT acts.
 */
import { API_PREFIX } from "./mcp.ts";

/** The operator routes `mc operator` may POST to; `:id` and `:key` match one path segment. */
export const FLIGHT_OPERATOR_ROUTES: readonly string[] = [
  "/runs/:id/resume",
  "/runs/:id/end",
  "/runs/:id/message",
  "/runs/:id/controller-check",
  "/runs/:id/merge-hold",
  "/seats/:id/start",
  "/seats/:id/message",
  "/seats/:id/interrupt",
  "/seats/:id/end",
  "/settings/crew-pause",
  "/settings/away",
  "/update",
  "/attention/:key/dismiss",
  "/attention/:key/hold",
  "/attention/:key/hold/release",
];
const routePattern = (route: string) =>
  new RegExp(`^${API_PREFIX}${route.replace(/:[a-z]+/g, "[^/]+")}$`);
const ROUTE_PATTERNS = FLIGHT_OPERATOR_ROUTES.map(routePattern);

/** Reads `mc operator` never makes: the page-only token and stored screenshots. */
const READ_REFUSED = new RegExp(`^${API_PREFIX}/(?:operator(?:/|$)|hud-screenshots(?:/|$))`);

export const FLIGHT_OPERATOR_BODY_MAX = 20_000;
export const FLIGHT_OPERATOR_RESPONSE_MAX = 8000;

/** Whether `mc operator` may call this method and path; only a read carries a query string. */
export function flightOperatorAllowed(method: string, path: string): boolean {
  const route = method === "GET" ? (path.split("?")[0] ?? "") : path;
  if (!route.startsWith(`${API_PREFIX}/`) || route.includes("?") || path.includes(".."))
    return false;
  if (method === "GET") return !READ_REFUSED.test(route);
  return method === "POST" && ROUTE_PATTERNS.some((r) => r.test(route));
}

export const flightOperatorRefusedText = (method: string, path: string): string =>
  `Refused: ${method} ${path} is not a route mc operator calls. It POSTs to ${FLIGHT_OPERATOR_ROUTES.join(", ")}, and reads any other /api path with GET.`;

/**
 * The rules a controller's approval can override, for the guard and the merge gate. `merge-floor`:
 * clearing a PR that touches `CLAUDE.md` or `.github/**` (scope `pr:<number>@<head sha>`); the
 * guard's rules: one refused command or file path (scope: the exact command or path).
 */
export const FLIGHT_APPROVAL_RULES = ["merge-floor", "repo-rules", "merge-push"] as const;
export type FlightApprovalRule = (typeof FLIGHT_APPROVAL_RULES)[number];

/** The `gh` verbs `mc gh_write` runs, on FLIGHT's own repo only. */
export const FLIGHT_GH_WRITE_ACTIONS = [
  "comment",
  "label",
  "edit",
  "close",
  "reopen",
  "ready",
  "delete_branch",
] as const;
export type FlightGhWriteAction = (typeof FLIGHT_GH_WRITE_ACTIONS)[number];

/** Branches `gh_write` never deletes, whatever the PRs say. */
export const FLIGHT_PROTECTED_BRANCHES: readonly RegExp[] = [/^main$/, /^archive\//];
