import type { AttentionHoldCondition, AttentionItem, CrewRow } from "@mc/core";
import { useState } from "react";
import { apiPost } from "../api.ts";
import { isOperatorItem } from "../attention.ts";
import { ACTIONS } from "../data.ts";
import type { FlightSeat } from "../flight/flightTypes.ts";
import { answerTarget, sendAnswer } from "./answer.ts";
import { HoldForm } from "./NeedsList.tsx";

export function DecisionCard({
  item,
  row,
  rows,
  flightSeat,
  onDiscuss,
}: {
  item: AttentionItem;
  row: CrewRow | undefined;
  rows: CrewRow[];
  flightSeat: FlightSeat | null;
  onDiscuss: (item: AttentionItem) => void;
}) {
  const [held, setHeld] = useState(false);
  const [holding, setHolding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const option = item.brief?.options.find(
    (choice) => choice.id === item.brief?.recommendedOptionId,
  );
  const accept = async () => {
    if (!option) return;
    setError(
      await sendAnswer(
        answerTarget(item, rows, flightSeat),
        flightSeat,
        item,
        item.brief?.ask ?? item.text,
        option.answer,
      ),
    );
  };
  const hold = async (reason: string, condition: AttentionHoldCondition) => {
    setError(null);
    try {
      await apiPost(ACTIONS.hold(item.key), { reason, condition });
      setHeld(true);
      setHolding(false);
    } catch {
      setError("Could not hold this decision.");
    }
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
        <button type="button" disabled={held} onClick={() => setHolding(true)}>
          Held
        </button>
      </div>
      {error && <p className="crit-t s">{error}</p>}
      {holding && (
        <HoldForm
          busy={false}
          onCancel={() => setHolding(false)}
          onHold={(reason, condition) => void hold(reason, condition)}
        />
      )}
    </article>
  );
}

export function Decisions({
  items,
  rows,
  flightSeat,
  onDiscuss,
}: {
  items: AttentionItem[] | undefined;
  rows: CrewRow[];
  flightSeat: FlightSeat | null;
  onDiscuss: (item: AttentionItem) => void;
}) {
  const decisions = (items ?? []).filter(
    (item) => item.kind === "decision" && isOperatorItem(item),
  );
  return (
    <section className="comms-decisions" aria-label="Decisions">
      <h2>Decisions</h2>
      <div className="comms-decision-list">
        {decisions.length === 0 ? (
          <p className="note">No decisions need you.</p>
        ) : (
          decisions.map((item) => (
            <DecisionCard
              key={item.key}
              item={item}
              row={rows.find((row) => row.id === item.agentId)}
              rows={rows}
              flightSeat={flightSeat}
              onDiscuss={onDiscuss}
            />
          ))
        )}
      </div>
    </section>
  );
}
