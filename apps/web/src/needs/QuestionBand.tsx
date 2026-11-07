import { ATTENTION_LABEL, type AttentionItem, type CrewRow } from "@mc/core";
import { useSecond, useTz } from "../clock.ts";
import { MarkdownInline } from "../components/Markdown.tsx";
import { SafeLink } from "../components/SafeLink.tsx";
import { raisedAt, rel } from "../fmt.ts";
import { Pill } from "../hud/Pill.tsx";

/** What an item asks, in words: FLIGHT's ask where it briefed one, else the item's text. */
export const questionOf = (item: AttentionItem): string => item.brief?.ask?.trim() || item.text;

/**
 * The item's title: the pinned ticket's or PR's title, in the asker's words, else the question.
 * Needs you's entry rules (#1543) make sure an item has one or the other.
 */
export const titleOf = (item: AttentionItem): string =>
  item.pinned?.ticket?.title ?? item.pinned?.pr?.title ?? questionOf(item);

/**
 * Who asks: the seat or loop behind the item, else FLIGHT when it briefed the question, else the
 * hub (an alert).
 */
export const askerOf = (item: AttentionItem, callSign?: string | null): string =>
  callSign ?? item.agentId ?? (item.brief?.for === "operator" ? "FLIGHT" : "the hub");

/** The recommended option's label, when the brief names one. */
export function recommendedLabel(item: AttentionItem): string | null {
  const id = item.brief?.recommendedOptionId;
  return item.brief?.options.find((o) => o.id !== undefined && o.id === id)?.label ?? null;
}

/** When the item was raised, in full, then how long ago: `Fri 6 Nov 17:23 · 7 h ago`. */
export function Raised({ at }: { at: number }) {
  const now = useSecond();
  const tz = useTz();
  if (at <= 0 || tz === null) return <span className="s">—</span>;
  return (
    <time className="s" dateTime={new Date(at).toISOString()}>
      {`${raisedAt(at, tz)} · ${rel(at, now, tz)}`}
    </time>
  );
}

/** A PR titled after its ticket ("#1389 Server enforces …") adds nothing beside the ticket. */
const sameTitle = (pr: string, ticket: string | null | undefined): boolean =>
  ticket != null && pr.replace(/^#\d+\s*/, "").trim() === ticket.trim();

/** The ticket and PR the item is about, pinned: number, title and link (#1543). */
export function PinnedLinks({ item }: { item: AttentionItem }) {
  const { ticket, pr } = item.pinned ?? {};
  if (!ticket && !pr) return null;
  const num = (ref: string) => ref.match(/#\d+$/)?.[0] ?? ref;
  return (
    <ul className="needs-pins" aria-label="Ticket and PR">
      {ticket && (
        <li>
          {ticket.url ? (
            <SafeLink url={ticket.url}>{`Ticket ${num(ticket.ref)}`}</SafeLink>
          ) : (
            <span>{`Ticket ${num(ticket.ref)}`}</span>
          )}
          {ticket.title && <span className="needs-pin-title">{ticket.title}</span>}
        </li>
      )}
      {pr && (
        <li>
          <SafeLink url={pr.url}>{`PR ${pr.number}`}</SafeLink>
          {!sameTitle(pr.title, ticket?.title) && (
            <span className="needs-pin-title">{pr.title}</span>
          )}
        </li>
      )}
    </ul>
  );
}

/**
 * The band over the open item: its title, when it was raised and by whom, what the operator must
 * decide, and the ticket and PR it is about. It sits outside the scrolling columns, so the
 * question stays on screen while the rest scrolls.
 */
export function QuestionBand({
  item,
  row,
  actions,
}: {
  item: AttentionItem;
  row: CrewRow | undefined;
  /** Controls that sit in the meta row (Hold). */
  actions?: React.ReactNode;
}) {
  const title = titleOf(item);
  const ask = questionOf(item);
  const pick = recommendedLabel(item);
  return (
    <section className="needs-band" aria-label="The question">
      <div className="needs-band-meta">
        <Pill tone={item.kind === "decision" ? "warn" : "plain"}>{ATTENTION_LABEL[item.kind]}</Pill>
        <span className="needs-band-who">{`Asked by ${askerOf(item, row?.displayCallSign)}`}</span>
        <Raised at={item.at} />
        {actions}
      </div>
      <h2 className="needs-band-title">
        <MarkdownInline text={title} />
      </h2>
      {ask !== title && (
        <p className="needs-band-question">
          <span className="needs-band-label">What you need to decide: </span>
          <MarkdownInline text={ask} />
        </p>
      )}
      {pick && (
        <p className="needs-band-pick">
          FLIGHT recommends: <b>{pick}</b>
        </p>
      )}
      <PinnedLinks item={item} />
    </section>
  );
}
