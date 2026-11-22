import { FLIGHT_APPROVAL_RULES } from "@mc/core";
import { useState } from "react";
import { apiPost } from "../api.ts";
import { ACTIONS } from "../data.ts";

/** Operator-only safety controls. The server checks authority and validates every request. */
export function OperatorActions() {
  const [message, setMessage] = useState<string | null>(null);
  const [pace, setPace] = useState({ on: false, until: "", labels: "", maxStarts: "", note: "" });
  const [approval, setApproval] = useState({
    rule: FLIGHT_APPROVAL_RULES[0],
    scope: "",
    until: "",
    reason: "",
  });
  const post = async (path: string, body: unknown) => {
    try {
      await apiPost(path, body);
      setMessage("Saved.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section aria-label="Operator actions">
      <h3>Operator controls</h3>
      <fieldset className="fgroup">
        <legend>Slow pace</legend>
        <label>
          <input
            type="checkbox"
            checked={pace.on}
            onChange={(e) => setPace({ ...pace, on: e.target.checked })}
          />{" "}
          On
        </label>
        <label>
          Until{" "}
          <input
            aria-label="Slow pace until"
            type="number"
            value={pace.until}
            onChange={(e) => setPace({ ...pace, until: e.target.value })}
          />
        </label>
        <label>
          Labels{" "}
          <input
            value={pace.labels}
            onChange={(e) => setPace({ ...pace, labels: e.target.value })}
          />
        </label>
        <label>
          Max starts{" "}
          <input
            type="number"
            value={pace.maxStarts}
            onChange={(e) => setPace({ ...pace, maxStarts: e.target.value })}
          />
        </label>
        <label>
          Note{" "}
          <input value={pace.note} onChange={(e) => setPace({ ...pace, note: e.target.value })} />
        </label>
        <button
          type="button"
          onClick={() =>
            void post(ACTIONS.pace, {
              on: pace.on,
              until: Number(pace.until) || null,
              labels: pace.labels
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean),
              maxStarts: Number(pace.maxStarts) || null,
              note: pace.note,
            })
          }
        >
          Save slow pace
        </button>
      </fieldset>
      <fieldset className="fgroup">
        <legend>FLIGHT approval</legend>
        <label>
          Rule{" "}
          <select
            value={approval.rule}
            onChange={(e) =>
              setApproval({ ...approval, rule: e.target.value as typeof approval.rule })
            }
          >
            {FLIGHT_APPROVAL_RULES.map((rule) => (
              <option key={rule}>{rule}</option>
            ))}
          </select>
        </label>
        <label>
          Scope{" "}
          <input
            value={approval.scope}
            onChange={(e) => setApproval({ ...approval, scope: e.target.value })}
          />
        </label>
        <label>
          Until{" "}
          <input
            aria-label="Approval until"
            type="datetime-local"
            value={approval.until}
            onChange={(e) => setApproval({ ...approval, until: e.target.value })}
          />
        </label>
        <label>
          Reason{" "}
          <input
            value={approval.reason}
            onChange={(e) => setApproval({ ...approval, reason: e.target.value })}
          />
        </label>
        <button
          type="button"
          onClick={() =>
            void post(ACTIONS.flightApprovals, {
              ...approval,
              until: new Date(approval.until).toISOString(),
            })
          }
        >
          Grant approval
        </button>
      </fieldset>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
