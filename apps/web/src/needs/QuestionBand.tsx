import { ATTENTION_LABEL, type AttentionItem, type CrewRow } from "@mc/core";
import { useSecond, useTz } from "../clock.ts";
import { MarkdownInline } from "../components/Markdown.tsx";
import { rel } from "../fmt.ts";
import { Pill } from "../hud/Pill.tsx";

/** What an item asks, in words: FLIGHT's ask where it briefed one, else the item's text. */
export const questionOf = (item: AttentionItem): string => item.brief?.ask?.trim() || item.text;

/** The recommended option's label, when the brief names one. */
export function recommendedLabel(item: AttentionItem): string | null {
  const id = item.brief?.recommendedOptionId;
  return item.brief?.options.find((o) => o.id !== undefined && o.id === id)?.label ?? null;
}

function Age({ at }: { at: number }) {
  const now = useSecond();
  const tz = useTz();
  return <span className="s">{at > 0 && tz !== null ? rel(at, now, tz) : "—"}</span>;
}

/**
 * The band over the open item: what is asked, by whom and how long ago, and FLIGHT's pick. It sits
 * outside the scrolling columns, so the question stays on screen while the rest scrolls.
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
  const ticket = item.ticket?.match(/#\d+$/)?.[0] ?? item.ticket;
  const pick = recommendedLabel(item);
  return (
    <section className="needs-band" aria-label="The question">
      <div className="needs-band-meta">
        <Pill tone={item.kind === "decision" ? "warn" : "plain"}>{ATTENTION_LABEL[item.kind]}</Pill>
        <span className="needs-band-who">{row?.displayCallSign ?? item.agentId ?? "FLIGHT"}</span>
        {ticket && <span className="needs-band-ticket">{ticket}</span>}
        <Age at={item.at} />
        {actions}
        {pick && (
          <span className="needs-band-pick">
            FLIGHT recommends: <b>{pick}</b>
          </span>
        )}
      </div>
      <h2 className="needs-band-question">
        <MarkdownInline text={questionOf(item)} />
      </h2>
    </section>
  );
}
