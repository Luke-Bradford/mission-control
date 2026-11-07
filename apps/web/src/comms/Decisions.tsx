import type { AttentionItem, CrewRow } from "@mc/core";
import { needsYouItems } from "../attention.ts";
import { useSecond } from "../clock.ts";
import { mss } from "../fmt.ts";
import { followLink, NEEDS_YOU_PATH, needsYouPath } from "../router.ts";

export function DecisionCard({ item, row }: { item: AttentionItem; row: CrewRow | undefined }) {
  const now = useSecond();
  const option = item.brief?.options.find(
    (choice) => choice.id === item.brief?.recommendedOptionId,
  );
  const dueAt = item.defaultDueAt ?? item.triageDueAt;
  const countdown = dueAt === undefined ? null : Math.max(0, Math.ceil((dueAt - now) / 1000));
  const clock = countdown === null ? null : mss(countdown * 1000);
  const ticket = item.ticket?.match(/#\d+$/)?.[0] ?? item.ticket;
  return (
    <article className="decision-card">
      <div className="decision-meta">
        <span className="decision-from">{row?.displayCallSign ?? item.agentId ?? "FLIGHT"}</span>
        {ticket && <span className="decision-ticket">{ticket}</span>}
        {clock && <span className="decision-clock">{`default in ${clock}`}</span>}
      </div>
      <h3>{item.brief?.ask ?? item.text}</h3>
      {option && <p className="decision-recommendation">{`Recommends: ${option.label}`}</p>}
      <div className="acts">
        <a href={needsYouPath(item.key)} onClick={(e) => followLink(e, needsYouPath(item.key))}>
          Open in Needs you
        </a>
      </div>
    </article>
  );
}

export function Decisions({
  items,
  rows,
}: {
  items: AttentionItem[] | undefined;
  rows: CrewRow[];
}) {
  // Decisions and every operator item with an automatic default; the head counts the whole set.
  const needsYou = needsYouItems(items);
  const decisions = needsYou.filter(
    (item) => item.kind === "decision" || item.defaultDueAt !== undefined,
  );
  return (
    <section className="comms-decisions" aria-label="Decisions">
      <div className="comms-section-head">
        <h2>Decisions</h2>
        <span className="spacer" />
        <a
          className="comms-needs-link"
          href={NEEDS_YOU_PATH}
          onClick={(e) => followLink(e, NEEDS_YOU_PATH)}
        >{`Needs you ${needsYou.length}`}</a>
      </div>
      <div className="comms-decision-list">
        {decisions.length === 0 ? (
          <p className="note">No decisions need you.</p>
        ) : (
          decisions.map((item) => (
            <DecisionCard
              key={item.key}
              item={item}
              row={rows.find((row) => row.id === item.agentId)}
            />
          ))
        )}
      </div>
    </section>
  );
}
