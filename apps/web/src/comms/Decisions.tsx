import type { AttentionItem, CrewRow } from "@mc/core";
import { useState } from "react";
import { apiPost } from "../api.ts";
import { ACTIONS } from "../data.ts";

export function DecisionCard({
  item,
  row,
  onDiscuss,
}: {
  item: AttentionItem;
  row: CrewRow | undefined;
  onDiscuss: (item: AttentionItem) => void;
}) {
  const [held, setHeld] = useState(false);
  const option = item.brief?.options.find(
    (choice) => choice.id === item.brief?.recommendedOptionId,
  );
  const accept = async () => {
    if (!option || item.agentId === null) return;
    await apiPost(ACTIONS.seatMessage(item.agentId), { text: option.answer });
  };
  const hold = async () => {
    await apiPost(ACTIONS.hold(item.key), {});
    setHeld(true);
  };
  return (
    <article className="decision-card">
      <p>{row?.id ?? item.agentId ?? "FLIGHT"}</p>
      {item.ticket && <p>{item.ticket}</p>}
      <h3>{item.brief?.ask ?? item.text}</h3>
      {option && <p>{`Recommended: ${option.label}`}</p>}
      <div className="acts">
        {option && (
          <button type="button" onClick={() => void accept()}>
            Accept default
          </button>
        )}
        <button type="button" onClick={() => onDiscuss(item)}>
          Discuss
        </button>
        <button type="button" disabled={held} onClick={() => void hold()}>
          Held
        </button>
      </div>
    </article>
  );
}

export function Decisions({
  items,
  rows,
  onDiscuss,
}: {
  items: AttentionItem[] | undefined;
  rows: CrewRow[];
  flightId: string | undefined;
  onDiscuss: (item: AttentionItem) => void;
}) {
  const decisions = (items ?? []).filter(
    (item) => item.kind === "decision" && item.owner !== "flight",
  );
  return (
    <section className="comms-decisions" aria-label="Decisions">
      <h2>Decisions</h2>
      {decisions.length === 0 ? (
        <p className="note">No decisions need you.</p>
      ) : (
        decisions.map((item) => (
          <DecisionCard
            key={item.key}
            item={item}
            row={rows.find((row) => row.id === item.agentId)}
            onDiscuss={onDiscuss}
          />
        ))
      )}
    </section>
  );
}
