import type { AttentionItem } from "@mc/core";
import { SafeLink } from "../components/SafeLink.tsx";
import { briefLinks } from "./pictures.ts";

/**
 * The ticket and PR the item is about, labelled by their titles. With no title a link says "the
 * ticket" or "the pull request", never its number. A PR titled after its ticket ("#1389 Server
 * enforces …") adds nothing beside the ticket link, so it is left out.
 */
export function pinnedLinks(item: AttentionItem): { label: string; url: string }[] {
  const { ticket, pr } = item.pinned ?? {};
  const out: { label: string; url: string }[] = [];
  if (ticket?.url) out.push({ label: ticket.title?.trim() || "the ticket", url: ticket.url });
  if (pr?.url) {
    const title = pr.title.replace(/^#\d+\s*/, "").trim();
    if (!(ticket?.url && title !== "" && title === ticket.title?.trim()))
      out.push({ label: title || "the pull request", url: pr.url });
  }
  return out;
}

/**
 * The item's links, at the bottom: the ticket and PR by title, then every link in the brief, the
 * item's own URL and a person item's references, once each.
 */
export function LinksSection({ item }: { item: AttentionItem }) {
  const seen = new Set<string>();
  const links = [...pinnedLinks(item), ...briefLinks(item)].filter((l) => {
    if (seen.has(l.url)) return false;
    seen.add(l.url);
    return true;
  });
  if (links.length === 0) return null;
  return (
    <section className="needs-links" aria-label="Links">
      <h3 className="bsec">Links</h3>
      <ul>
        {links.map((l) => (
          <li key={l.url}>
            <SafeLink url={l.url}>{l.label}</SafeLink>
          </li>
        ))}
      </ul>
    </section>
  );
}
