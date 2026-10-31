import type { ConfigView } from "@mc/core";
import type { CSSProperties } from "react";
import { ExternalLink } from "../components/ExternalLink.tsx";
import { RESOURCES, useResource } from "../data.ts";
import { prLabel } from "../fmt.ts";
import { githubItemHref } from "../links.ts";
import { repoColor } from "../repoColor.ts";
import { followLink, ticketPath } from "../router.ts";
import "./RepoRef.css";

/**
 * An issue or PR: the repo as a chip in its colour, then the number apart from it, linked to
 * GitHub from the repo's configured owner/name. `bare` leaves the chip out, for a page that shows
 * one repo. A repo that is not in the config gets a plain chip and, unless `url` is given, no link.
 * `url` is the fallback the server sent; it is only linked when it is a github.com URL.
 * With `to`, the number opens that Mission Control page and GitHub is a second, marked link.
 */
export function RepoRef({
  repoId,
  number,
  kind = "issue",
  bare = false,
  title,
  url,
  to,
}: {
  repoId: string;
  number: number;
  kind?: "issue" | "pr";
  bare?: boolean;
  title?: string;
  url?: string | null;
  /** An in-app path for the number to open; GitHub stays beside it as a second link. */
  to?: string;
}) {
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const repos = config?.repos ?? [];
  const github = repos.find((r) => r.id === repoId)?.github;
  const colour = repoColor(
    repos.map((r) => r.id),
    repoId,
  );
  const label = kind === "pr" ? prLabel(number) : `#${number}`;
  const href = (github ? githubItemHref(github, kind, number) : null) ?? url ?? null;
  const style = colour ? ({ "--c": colour } as CSSProperties) : undefined;
  return (
    <span className="rref" title={title}>
      {!bare && (
        <>
          <span className="rchip" style={style} title={repoId}>
            {repoId}
          </span>{" "}
        </>
      )}
      {to ? (
        <>
          <a href={to} aria-label={`${repoId} ${label}`} onClick={(e) => followLink(e, to)}>
            {label}
          </a>
          {href && (
            // the ↗ is drawn by CSS, so the number's text stays what it was
            <ExternalLink url={href} label={`${repoId} ${label} on GitHub`} className="rref-gh" />
          )}
        </>
      ) : href ? (
        <ExternalLink url={href} label={`${repoId} ${label}`}>
          {label}
        </ExternalLink>
      ) : (
        <span>{label}</span>
      )}
    </span>
  );
}

const TICKET = /^(.+)#(\d+)$/;

/** A `repo#n` ticket string taken apart; null for a string of any other shape. */
export function parseTicket(ticket: string): { repoId: string; number: number } | null {
  const m = TICKET.exec(ticket);
  return m ? { repoId: m[1] as string, number: Number(m[2]) } : null;
}

/** A `repo#n` ticket string as a RepoRef; a string of any other shape is shown as it is. */
export function TicketRef({
  ticket,
  bare,
  kind,
  url,
}: {
  ticket: string;
  bare?: boolean;
  kind?: "issue" | "pr";
  url?: string | null;
}) {
  const t = parseTicket(ticket);
  if (!t) return <span className="chipref">{ticket}</span>;
  return (
    <RepoRef
      repoId={t.repoId}
      number={t.number}
      bare={bare}
      kind={kind}
      url={url}
      to={kind === "pr" ? undefined : ticketPath(t.repoId, t.number)}
    />
  );
}
