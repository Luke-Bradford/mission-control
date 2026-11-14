import { ATTENTION_LABEL, type AttentionItem, type Crew, type QuestionClosure } from "@mc/core";
import { useSecond, useTz } from "../clock.ts";
import { MarkdownInline } from "../components/Markdown.tsx";
import { callSign as callSignOf } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { Pending } from "../flight/Pending.tsx";
import { raisedAt, rel } from "../fmt.ts";
import { Pill } from "../hud/Pill.tsx";
import { followLink, needsYouPath } from "../router.ts";
import { askerIdOf, askerOf, questionOf, titleOf } from "./QuestionBand.tsx";

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
  const row = useResource<Crew>(RESOURCES.crew).data?.rows.find((r) => r.id === askerIdOf(item));
  const callSign = row ? callSignOf(row) : undefined;
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
      <span className="needs-row-who s">
        {`Asked by ${askerOf(item, callSign)}`}
        {item.ticket !== null && ` · ${item.ticket}`}
      </span>
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

function Answered({
  items,
  error,
}: {
  items: readonly QuestionClosure[] | undefined;
  error: Error | null;
}) {
  if (items === undefined)
    return (
      <section className="needs-group" aria-label="Answered">
        <h3 className="needs-group-title">Answered</h3>
        <Pending what="answered questions" error={error} resource={RESOURCES.answeredAttention} />
      </section>
    );
  if (items.length === 0)
    return (
      <section className="needs-group" aria-label="Answered">
        <h3 className="needs-group-title">Answered</h3>
        <p className="s note needs-answered">No questions have been answered or withdrawn.</p>
      </section>
    );
  const title = `Answered · ${items.length}`;
  return (
    <section className="needs-group" aria-label={title}>
      <details>
        <summary className="needs-group-title">{title}</summary>
        {items.map((item) => (
          <div className="needs-answered" key={`${item.key}:${item.askAt}`}>
            <MarkdownInline text={item.question} />
            <p className="s note">{item.kind === "cleared" ? "Cleared by you" : item.reason}</p>
          </div>
        ))}
      </details>
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
  alerts = [],
  controls,
  answered,
  answeredError,
  selected,
  footer,
}: {
  asks: readonly AttentionItem[];
  defaulted: readonly AttentionItem[];
  /** Hub alerts: not questions, so they are not in the question count. */
  alerts?: readonly AttentionItem[];
  /** Above the groups: the filters and order. */
  controls?: React.ReactNode;
  answered: readonly QuestionClosure[] | undefined;
  answeredError: Error | null;
  selected: string | null;
  /** Under the groups: what was handled today. */
  footer?: React.ReactNode;
}) {
  return (
    <nav className="needs-list" aria-label="Waiting on you">
      {controls}
      <Group title="Alerts" n={alerts.length}>
        {alerts.map((i) => (
          <Row key={i.key} item={i} current={i.key === selected} />
        ))}
      </Group>
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
      <Answered items={answered} error={answeredError} />
      {footer}
    </nav>
  );
}
