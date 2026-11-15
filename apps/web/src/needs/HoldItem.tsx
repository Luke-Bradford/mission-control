import type { AttentionItem, NeedsYouOffer } from "@mc/core";
import { useId, useState } from "react";
import { ApiError, apiPost } from "../api.ts";
import {
  ErrorSummary,
  FieldError,
  type FieldIssue,
  fieldProps,
  issueOf,
  isUncertain,
  UNCERTAIN_TEXT,
  useSubmitGuard,
} from "../components/formSupport.tsx";
import { ACTIONS, hub, RESOURCES } from "../data.ts";
import { writeFailure } from "../demo/mode.ts";

const ACTION_LABEL: Record<NeedsYouOffer, string> = {
  "not-now": "Not now",
  drop: "Drop",
};

type AttentionAction = NeedsYouOffer | "clear";

const actionPath = (offer: NeedsYouOffer, key: string): string =>
  offer === "not-now" ? ACTIONS.notNow(key) : ACTIONS.drop(key);

const pathFor = (action: AttentionAction, key: string): string =>
  action === "clear" ? ACTIONS.clear(key) : actionPath(action, key);

const labelFor = (action: AttentionAction): string =>
  action === "clear" ? "Clear" : ACTION_LABEL[action];

type HoldMode = "manual" | "date" | "ticket" | "crew";

const HOLD_MODES: readonly { mode: HoldMode; label: string }[] = [
  { mode: "manual", label: "Until you release it" },
  { mode: "date", label: "Until a date" },
  { mode: "ticket", label: "Until a ticket merges" },
  { mode: "crew", label: "Until the crew resumes" },
];

/** The server's reference shape: `repo#number`, no spaces. */
const TICKET_REF = /^[^#\s]+#[1-9]\d*$/;
const REASON_MAX = 1000;

/**
 * Hold this item until a condition. Only the chosen condition's fields are checked, so an old
 * value typed for another condition cannot block this one. Entries stay after any failure.
 */
function HoldForm({ item, onClose }: { item: AttentionItem; onClose: () => void }) {
  const id = useId();
  const guard = useSubmitGuard();
  const [mode, setMode] = useState<HoldMode>("manual");
  const [reason, setReason] = useState("");
  const [date, setDate] = useState("");
  const [ticket, setTicket] = useState("");
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [focusKey, setFocusKey] = useState(0);
  const reasonId = `${id}-reason`;
  const dateId = `${id}-date`;
  const ticketId = `${id}-ticket`;
  const submit = async () => {
    if (!guard.take()) return;
    const found: FieldIssue[] = [];
    const trimmed = reason.trim();
    if (trimmed === "") found.push({ id: reasonId, message: "Say why you are holding this." });
    else if (trimmed.length > REASON_MAX)
      found.push({ id: reasonId, message: `Keep the reason under ${REASON_MAX} characters.` });
    let condition: Record<string, unknown> = { kind: mode };
    if (mode === "date") {
      const at = new Date(date).getTime();
      if (date === "" || Number.isNaN(at))
        found.push({ id: dateId, message: "Choose the date and time to release this." });
      else condition = { kind: "date", at };
    }
    if (mode === "ticket") {
      const ref = ticket.trim();
      if (!TICKET_REF.test(ref))
        found.push({ id: ticketId, message: "Write the ticket as repo#number, e.g. mc#42." });
      else condition = { kind: "ticket", ticket: ref };
    }
    setIssues(found);
    setMessage(null);
    setUncertain(false);
    if (found.length > 0) {
      setFocusKey((k) => k + 1);
      guard.release();
      return;
    }
    setBusy(true);
    try {
      await apiPost(ACTIONS.hold(item.key), { reason: trimmed, condition });
      hub.refetch(RESOURCES.attention.path);
      hub.refetch(RESOURCES.heldAttention.path);
      onClose();
    } catch (e) {
      const status = e instanceof ApiError ? e.status : undefined;
      setMessage(
        e instanceof ApiError && !isUncertain(status)
          ? e.message
          : writeFailure(e, "Could not hold this item."),
      );
      if (isUncertain(status)) {
        setUncertain(true);
        hub.refetch(RESOURCES.attention.path);
        hub.refetch(RESOURCES.heldAttention.path);
      }
      setFocusKey((k) => k + 1);
    } finally {
      guard.release();
      setBusy(false);
    }
  };
  return (
    <form
      className="fform fform-640"
      noValidate
      aria-label="Hold this item"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <fieldset className="fgroup">
        <legend>Release condition</legend>
        {HOLD_MODES.map((m) => (
          <label className="ffield ffield-check" key={m.mode}>
            <input
              type="radio"
              name={`${id}-mode`}
              checked={mode === m.mode}
              disabled={busy}
              onChange={() => {
                setMode(m.mode);
                setIssues((all) => all.filter((i) => i.id === reasonId));
              }}
            />
            <span>{m.label}</span>
          </label>
        ))}
        {mode === "date" && (
          <div className="ffield">
            <label htmlFor={dateId}>Date and time</label>
            <input
              {...fieldProps(dateId, issueOf(issues, dateId))}
              type="datetime-local"
              value={date}
              disabled={busy}
              onChange={(e) => setDate(e.target.value)}
            />
            <FieldError id={dateId} error={issueOf(issues, dateId)} />
          </div>
        )}
        {mode === "ticket" && (
          <div className="ffield">
            <label htmlFor={ticketId}>Ticket</label>
            <input
              {...fieldProps(ticketId, issueOf(issues, ticketId), `${ticketId}-hint`)}
              value={ticket}
              disabled={busy}
              onChange={(e) => setTicket(e.target.value)}
            />
            <span id={`${ticketId}-hint`} className="fhint muted xs">
              Released when this ticket merges, e.g. mc#42.
            </span>
            <FieldError id={ticketId} error={issueOf(issues, ticketId)} />
          </div>
        )}
      </fieldset>
      <fieldset className="fgroup">
        <legend>Why</legend>
        <div className="ffield">
          <label htmlFor={reasonId}>Reason</label>
          <textarea
            {...fieldProps(reasonId, issueOf(issues, reasonId))}
            rows={3}
            value={reason}
            disabled={busy}
            onChange={(e) => setReason(e.target.value)}
          />
          <FieldError id={reasonId} error={issueOf(issues, reasonId)} />
        </div>
      </fieldset>
      <ErrorSummary
        title={uncertain ? "Result unknown" : "Hold not saved"}
        issues={issues}
        message={message}
        focusKey={focusKey}
      >
        {uncertain && <p className="s">{UNCERTAIN_TEXT}</p>}
      </ErrorSummary>
      {busy && (
        <p role="status" className="fstatus s">
          Saving hold…
        </p>
      )}
      <div className="fact">
        <button type="submit" className="primary" disabled={busy}>
          Save hold
        </button>
        <button type="button" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Set aside or close only the actions the server has offered for this open question. */
export function HoldItem({ item }: { item: AttentionItem }) {
  const [busy, setBusy] = useState<AttentionAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [holding, setHolding] = useState(false);
  const offers = item.offers ?? [];
  const actions: readonly AttentionAction[] = [...offers, "clear"];
  const act = async (action: AttentionAction) => {
    setBusy(action);
    setError(null);
    try {
      await apiPost(pathFor(action, item.key), {});
      hub.refetch(RESOURCES.attention.path);
      hub.refetch(RESOURCES.answeredAttention.path);
    } catch (e) {
      setError(
        e instanceof ApiError && [404, 409, 422, 502].includes(e.status)
          ? e.message
          : writeFailure(e, `Could not ${labelFor(action).toLowerCase()} this item.`),
      );
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="needs-actions">
      {!holding && (
        <button
          type="button"
          className="sm"
          disabled={busy !== null}
          onClick={() => setHolding(true)}
        >
          Hold
        </button>
      )}
      {actions.map((action) => (
        <button
          type="button"
          className="sm"
          disabled={busy !== null}
          key={action}
          onClick={() => void act(action)}
        >
          {labelFor(action)}
        </button>
      ))}
      {holding && <HoldForm item={item} onClose={() => setHolding(false)} />}
      {error && (
        <p className="note err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
