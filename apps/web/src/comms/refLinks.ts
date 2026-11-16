import { COMMS_TICKET, type ConfigView } from "@mc/core";
import { parseTicket } from "../hud/RepoRef.tsx";
import { githubItemHref } from "../links.ts";
import { ticketPath } from "../router.ts";

/** The repo a bare `#n` or `PR n` in a message means: its ticket's, else its sender's or recipient's, else the only one. */
export function refRepo(
  ticket: string | null,
  senderRepo: string | undefined,
  config: ConfigView | undefined,
): string | null {
  const parsed = ticket !== null && COMMS_TICKET.test(ticket) ? parseTicket(ticket) : null;
  if (parsed) return parsed.repoId;
  if (senderRepo) return senderRepo;
  return config?.repos.length === 1 ? (config.repos[0]?.id ?? null) : null;
}

export function resolveRef(
  refText: string,
  repoId: string,
  config: ConfigView | undefined,
  ticket: string | null = null,
): { to: string | null; github: string | null } | null {
  const issue = /^#(\d+)$/.exec(refText)?.[1];
  if (issue !== undefined) return { to: ticketPath(repoId, Number(issue)), github: null };
  const pr = /^PR (\d+)$/.exec(refText)?.[1];
  // a PR the message is about (its own ref) belongs to the message's ticket: open that ticket's
  // page. A PR named in the text may belong to any ticket, so it keeps its GitHub link.
  const parsed = ticket !== null && COMMS_TICKET.test(ticket) ? parseTicket(ticket) : null;
  if (pr !== undefined && parsed)
    return { to: ticketPath(parsed.repoId, parsed.number), github: null };
  const github = config?.repos.find((r) => r.id === repoId)?.github;
  const href = pr !== undefined && github ? githubItemHref(github, "pr", Number(pr)) : null;
  return href ? { to: null, github: href } : null;
}

/**
 * Markdown with each `#n` and `PR n` that resolves to a repo turned into a link, so FLIGHT's
 * Markdown shows ticket and PR references as links. Code spans are left as they are.
 */
export function linkRefs(
  text: string,
  ticket: string | null,
  senderRepo: string | undefined,
  config: ConfigView | undefined,
): string {
  const repoId = refRepo(ticket, senderRepo, config);
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(
            /(?<![\w[])(?:([\w.-]+)(#\d+)|(PR \d+)|(#\d+))\b(?!\])/g,
            (ref, repo: string | undefined, qualified: string | undefined) => {
              // `shop-app#12` names its repo; a bare `#12` or `PR 12` takes the message's.
              const inRepo = repo !== undefined ? repo : repoId;
              if (inRepo === null || !config?.repos.some((r) => r.id === inRepo)) return ref;
              const target = resolveRef(qualified ?? ref, inRepo, config);
              const href = target?.to ?? target?.github ?? null;
              return href === null ? ref : `[${ref}](${href})`;
            },
          ),
    )
    .join("");
}
