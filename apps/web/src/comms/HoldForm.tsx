import type { AttentionHoldCondition } from "@mc/core";
import { useState } from "react";

/** The Hold form: a reason and a release condition. */
export function HoldForm({
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
            pattern="[^#\s]+#[1-9][0-9]*"
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
