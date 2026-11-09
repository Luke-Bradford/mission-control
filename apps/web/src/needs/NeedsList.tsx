import { ATTENTION_LABEL, type AttentionItem, type Crew } from "@mc/core";
import { useSecond, useTz } from "../clock.ts";
import { MarkdownInline } from "../components/Markdown.tsx";
import { RESOURCES, useResource } from "../data.ts";
import { raisedAt, rel } from "../fmt.ts";
import { Pill } from "../hud/Pill.tsx";
import { followLink, needsYouPath } from "../router.ts";
import { askerOf, questionOf, titleOf } from "./QuestionBand.tsx";

/** Times tick here, in the row's child, so the list is not rebuilt each second. */
function RowAge({ at }: { at: number }) {
  const now = useSecond();
  const tz = useTz();
  if (at <= 0 || tz === null) return <span className="s">—</span>;
  return (
    <time className="s" dateTime={new Date(at).toISOString()}>
      {`${raisedAt(at, tz)} · ${rel(at, now, tz)}`}
    </time>
  );
}

function Row({ item, current }: { item: AttentionItem; current: boolean }) {
  const to = needsYouPath(item.key);
  // the band's name for the asker, so the list and the open item agree
  const callSign = useResource<Crew>(RESOURCES.crew).data?.rows.find(
    (r) => r.id === item.agentId,
  )?.displayCallSign;
  return (
    <a
      className={current ? "needs-row on" : "needs-row"}
      href={to}
      aria-current={current ? "true" : undefined}
      onClick={(e) => followLink(e, to)}
    >
      <span className="needs-row-top">
        <Pill tone={item.kind === "decision" ? "warn" : "plain"}>{ATTENTION_LABEL[item.kind]}</Pill>
        <span className="spacer" />
        <RowAge at={item.at} />
      </span>
      <span className="needs-row-text">
        <MarkdownInline text={titleOf(item)} max={160} />
      </span>
      {questionOf(item) !== titleOf(item) && (
        <span className="needs-row-ask s">
          <MarkdownInline text={questionOf(item)} max={120} />
        </span>
      )}
      <span className="needs-row-who s">{`Asked by ${askerOf(item, callSign)}`}</span>
    </a>
  );
}

function Group({ title, n, children }: { title: string; n: number; children: React.ReactNode }) {
  if (n === 0) return null;
  return (
    <section className="needs-group" aria-label={title}>
      <h3 className="needs-group-title">{`${title} · ${n}`}</h3>
      {children}
    </section>
  );
}

/**
 * The left column: what waits on you, and what FLIGHT will do unless you object. Held items are not
 * here (#1543): a held item waits on a condition, not on the operator; FLIGHT's page lists them.
 * It lists the whole Needs you set, so its count is the tab's.
 */
export function NeedsList({
  asks,
  defaulted,
  selected,
  footer,
}: {
  asks: readonly AttentionItem[];
  defaulted: readonly AttentionItem[];
  selected: string | null;
  /** Under the groups: what was handled today. */
  footer?: React.ReactNode;
}) {
  return (
    <nav className="needs-list" aria-label="Waiting on you">
      <Group title="Waiting on you" n={asks.length}>
        {asks.map((i) => (
          <Row key={i.key} item={i} current={i.key === selected} />
        ))}
      </Group>
      <Group title="FLIGHT will do unless you object" n={defaulted.length}>
        {defaulted.map((i) => (
          <Row key={i.key} item={i} current={i.key === selected} />
        ))}
      </Group>
      {footer}
    </nav>
  );
}
