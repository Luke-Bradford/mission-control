import type { AttentionItem } from "@mc/core";
import { SafeLink } from "../components/SafeLink.tsx";
import { briefLinks } from "./pictures.ts";

/** Every link in the brief, the item's own URL and a person item's references, once each. */
export function LinksSection({ item }: { item: AttentionItem }) {
  const links = briefLinks(item);
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
