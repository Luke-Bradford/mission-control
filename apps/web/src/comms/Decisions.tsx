import type { AttentionHoldCondition, AttentionItem, CrewRow } from "@mc/core";
import { useState } from "react";
import { apiPost } from "../api.ts";
import { needsYouItems } from "../attention.ts";
import { useSecond } from "../clock.ts";
import { ACTIONS } from "../data.ts";
import type { FlightSeat } from "../flight/flightTypes.ts";
import { followLink, NEEDS_YOU_PATH } from "../router.ts";
import { answerTarget, sendAnswer } from "./answer.ts";

function HoldForm({
  busy,
  onCancel,
  onHold,
}: {
  busy: boolean;
  onCancel: () => void;
  onHold: (reason: string, condition: AttentionHoldCondition) => void;
}) {
  const [reason, setReason] = useState("");
  const [kind, setKind] = useState<AttentionHoldCondition["kind"]>("manual");
  const [date, setDate] = useState("");
  const [ticket, setTicket] = useState("");
  return (
    <form
      className="hold-form"
      onSubmit={(event) => {
        event.preventDefault();
        const condition: AttentionHoldCondition =
          kind === "date"
            ? { kind, at: new Date(date).getTime() }
            : kind === "ticket"
              ? { kind, ticket: ticket.trim() }
              : { kind };
        onHold(reason.trim(), condition);
      }}
    >
      <label>
        Reason
        <input
          required
          maxLength={1000}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <label>
        Release condition
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as AttentionHoldCondition["kind"])}
        >
          <option value="manual">until I release it</option>
          <option value="date">a date</option>
          <option value="ticket">until a ticket merges</option>
          <option value="crew">until the crew resumes</option>
        </select>
      </label>
      {kind === "date" && (
        <label>
          Date
          <input
            required
            type="datetime-local"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
      )}
      {kind === "ticket" && (
        <label>
          Ticket
          <input
            required
            pattern="[^#\\s]+#[1-9][0-9]*"
            placeholder="repo#123"
            value={ticket}
            onChange={(e) => setTicket(e.target.value)}
          />
        </label>
      )}
      <div className="row">
        <button type="submit" className="sm" disabled={busy || !reason.trim()}>
          Hold item
        </button>
        <button type="button" className="sm ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

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
  const now = useSecond();
  const [held, setHeld] = useState(false);
  const [holding, setHolding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const option = item.brief?.options.find(
    (choice) => choice.id === item.brief?.recommendedOptionId,
  );
  const dueAt = item.defaultDueAt ?? item.triageDueAt;
  const countdown = dueAt === undefined ? null : Math.max(0, Math.ceil((dueAt - now) / 1000));
  const clock =
    countdown === null
      ? null
      : `${String(Math.floor(countdown / 60)).padStart(2, "0")}:${String(countdown % 60).padStart(2, "0")}`;
  const ticket = item.ticket?.match(/#\d+$/)?.[0] ?? item.ticket;
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
      <div className="decision-meta">
        <span className="decision-from">{row?.displayCallSign ?? item.agentId ?? "FLIGHT"}</span>
        {ticket && <span className="decision-ticket">{ticket}</span>}
        {clock && <span className="decision-clock">{`default in ${clock}`}</span>}
      </div>
      <h3>{item.brief?.ask ?? item.text}</h3>
      {option && <p className="decision-recommendation">{`Recommends: ${option.label}`}</p>}
      <div className="acts">
        {option && (
          <button className="primary" type="button" onClick={() => void accept()}>
            {`Accept · ${option.label}`}
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
