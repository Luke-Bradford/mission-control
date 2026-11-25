import type { ConfigView, FlightPointerKind, FlightPointerRef } from "@mc/core";
import { prLabel } from "../../fmt.ts";
import { parseTicket } from "../../hud/RepoRef.tsx";
import { githubHref, githubItemHref } from "../../links.ts";
import { agentPath, boardPath, PAGE_PATHS, ticketPath } from "../../router.ts";

/** What each kind of pointer is called on the page. */
export const POINTER_KIND_WORD: Record<FlightPointerKind, string> = {
  pr: "PR",
  ticket: "Ticket",
  seat: "Seat",
  repo: "Repo",
  person: "Person",
  metric: "Metric",
};

/** What a pointer opens: an in-app page (`to`), a GitHub page (`href`), both, or neither. */
export interface PointerLink {
  kind: string;
  label: string;
  to: string | null;
  href: string | null;
}

const ID = /^[\w.-]+$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * Where a pointer's target leads. A target the hub stored but that names nothing this page can open
 * (an unknown repo, a malformed ref) gets no link, and its label is the target as written.
 */
export function pointerLink(p: FlightPointerRef, config: ConfigView | undefined): PointerLink {
  const kind = POINTER_KIND_WORD[p.kind];
  const none: PointerLink = { kind, label: p.target, to: null, href: null };
  const repo = (id: string) => config?.repos.find((r) => r.id === id);
  switch (p.kind) {
    case "ticket":
    case "pr": {
      const t = parseTicket(p.target);
      const r = t && repo(t.repoId);
      if (!t || !r || !Number.isSafeInteger(t.number) || t.number < 1) return none;
      const pr = p.kind === "pr";
      return {
        kind,
        label: `${t.repoId} ${pr ? prLabel(t.number) : `#${t.number}`}`,
        to: pr ? null : ticketPath(t.repoId, t.number),
        href: githubItemHref(r.github, pr ? "pr" : "issue", t.number),
      };
    }
    case "seat":
      return ID.test(p.target) ? { ...none, to: agentPath(p.target) } : none;
    case "repo":
      return repo(p.target) ? { ...none, to: boardPath(p.target) } : none;
    case "person":
      return LOGIN.test(p.target)
        ? { ...none, href: githubHref(`https://github.com/${p.target}`) }
        : none;
    case "metric":
      return ID.test(p.target) ? { ...none, to: PAGE_PATHS.telemetry } : none;
  }
}
