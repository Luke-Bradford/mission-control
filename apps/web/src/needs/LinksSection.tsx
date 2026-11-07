import type { AttentionItem, Crew } from "@mc/core";
import { RESOURCES, useResource } from "../data.ts";
import { SafeLink } from "../components/SafeLink.tsx";
import { agentPath, followLink } from "../router.ts";
import { plainTitle } from "./QuestionBand.tsx";
import { briefLinks } from "./pictures.ts";

/**
 * The ticket and PR the item is about, labelled by their titles. With no title a link says "the
 * ticket" or "the pull request", never its number. A PR titled after its ticket ("#1389 Server
 * enforces …") adds nothing beside the ticket link, so it is left out.
 */
export function pinnedLinks(item: AttentionItem): { label: string; url: string }[] {
  const { ticket, pr } = item.pinned ?? {};
  const out: { label: string; url: string }[] = [];
  if (ticket?.url) out.push({ label: plainTitle(ticket.title) ?? "the ticket", url: ticket.url });
  if (pr?.url) {
    const title = plainTitle(pr.title);
    if (!(ticket?.url && title !== null && title === plainTitle(ticket.title)))
      out.push({ label: title ?? "the pull request", url: pr.url });
  }
  return out;
}

/**
 * The item's links, at the bottom: the ticket and PR by title, then every link in the brief, the
 * item's own URL and a person item's references, once each.
 */
export function LinksSection({ item }: { item: AttentionItem }) {
  // the seat's page is a link here, by its call sign, never by its id
  const callSign = useResource<Crew>(RESOURCES.crew).data?.rows.find(
    (r) => r.id === item.agentId,
  )?.displayCallSign;
  const seen = new Set<string>();
  const links = [...pinnedLinks(item), ...briefLinks(item)].filter((l) => {
    if (seen.has(l.url)) return false;
    seen.add(l.url);
    return true;
  });
  const agentId = item.agentId;
  if (links.length === 0 && agentId === null) return null;
  return (
    <section className="needs-links" aria-label="Links">
      <h3 className="bsec">Links</h3>
      <ul>
        {links.map((l) => (
          <li key={l.url}>
            <SafeLink url={l.url}>{l.label}</SafeLink>
          </li>
        ))}
        {agentId !== null && (
          <li>
            <a href={agentPath(agentId)} onClick={(e) => followLink(e, agentPath(agentId))}>
              {callSign ? `${callSign}'s page` : "The agent's page"}
            </a>
          </li>
        )}
      </ul>
    </section>
  );
}
