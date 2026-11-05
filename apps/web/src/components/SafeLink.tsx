import type { ReactNode } from "react";
import { openableHref, schemeOf } from "../links.ts";

/** Said where a link is refused, so the operator knows to ask for a web link. */
export const refusedLinkText = (url: string): string =>
  `Not opened: ${schemeOf(url)} links can't open from the browser. Ask FLIGHT for a web link.`;

/** The host a link goes to, shown beside its label so a label cannot hide it. */
function hostOf(href: string): string | null {
  try {
    const u = new URL(href, window.location.href);
    return u.host === window.location.host ? null : u.host;
  } catch {
    return null;
  }
}

/**
 * A link from agent text. Allowed ones open in a new tab with the host beside the label; a refused
 * one (see `openableHref`) is its URL as plain text with the reason, never an anchor.
 */
export function SafeLink({ url, children }: { url: string; children?: ReactNode }) {
  const href = openableHref(url);
  if (href === null) {
    return (
      <span className="safe-link refused">
        <span className="safe-link-url">{url}</span>{" "}
        <span className="note">{refusedLinkText(url)}</span>
      </span>
    );
  }
  const host = hostOf(href);
  return (
    <span className="safe-link">
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children ?? url}
      </a>
      {host && <span className="safe-link-host s"> {host}</span>}
    </span>
  );
}
