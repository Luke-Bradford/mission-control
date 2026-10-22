import type { ReactNode } from "react";
import { githubHref } from "../links.ts";

/**
 * A link to GitHub in a new tab; a URL that is not https://github.com is plain text. `label` is
 * the link's accessible name when the visible text alone would not say what it opens.
 */
export function ExternalLink({
  url,
  label,
  children,
}: {
  url: string;
  label?: string;
  children: ReactNode;
}) {
  const href = githubHref(url);
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" aria-label={label}>
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}
