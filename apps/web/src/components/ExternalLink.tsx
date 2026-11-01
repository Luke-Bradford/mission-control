import type { ReactNode } from "react";
import { githubHref } from "../links.ts";

/**
 * A link to an explicitly allowed origin (GitHub by default); other URLs are plain text. `label` is
 * the link's accessible name when the visible text alone would not say what it opens.
 */
export function ExternalLink({
  url,
  label,
  className,
  children,
  allowedOrigin = "https://github.com",
}: {
  url: string;
  allowedOrigin?: "https://github.com" | "https://teams.microsoft.com";
  label?: string;
  className?: string;
  children?: ReactNode;
}) {
  let href: string | null = null;
  if (allowedOrigin === "https://github.com") {
    href = githubHref(url);
  } else {
    try {
      const parsed = new URL(url);
      if (parsed.origin === allowedOrigin && !parsed.username && !parsed.password) {
        href = parsed.href;
      }
    } catch {
      // Invalid URLs remain plain text.
    }
  }
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className={className}
    >
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}
