import { ATTENTION_LABEL, type AttentionItem, type CrewRow, needsYouAlert } from "@mc/core";
import { useSecond, useTz } from "../clock.ts";
import { Markdown, MarkdownInline } from "../components/Markdown.tsx";
import { raisedAt, rel } from "../fmt.ts";
import { Pill } from "../hud/Pill.tsx";

/** A title without its leading number ("#1389 Server enforces …"), or null when none is left. */
export const plainTitle = (title: string | null | undefined): string | null =>
  title?.replace(/^#\d+\s*/, "").trim() || null;

/** What an item asks, in words: FLIGHT's ask where it briefed one, else the item's text. */
export const questionOf = (item: AttentionItem): string => item.brief?.ask?.trim() || item.text;

/**
 * The item's title: the pinned ticket's or PR's title, in the asker's words, else the question.
 * Needs you's entry rules (#1543) make sure an item has one or the other.
 */
export const titleOf = (item: AttentionItem): string =>
  plainTitle(item.pinned?.ticket?.title) ?? plainTitle(item.pinned?.pr?.title) ?? questionOf(item);

/**
 * Who asks: the seat or loop behind the item, else FLIGHT when it briefed the question, else the
 * hub (an alert).
 */
export const askerOf = (item: AttentionItem, callSign?: string | null): string =>
  item.alert || needsYouAlert(item)
    ? "the hub"
    : (callSign ?? item.agentId ?? (item.brief?.for === "operator" ? "FLIGHT" : "the hub"));

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

/** The brief's context paragraph: what the operator needs to know before the question. */
export const contextOf = (item: AttentionItem): string | null =>
  item.brief?.assessment?.trim() || item.brief?.context?.trim() || null;

/**
 * The band over the open item: its title, when it was raised and by whom, the context, and what
 * the operator must decide. The ticket and PR it is about are links at the bottom of the item. It sits outside the scrolling columns, so the
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
  const context = contextOf(item);
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
      {context && (
        <div className="needs-band-context">
          <Markdown text={context} />
        </div>
      )}
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
    </section>
  );
}
