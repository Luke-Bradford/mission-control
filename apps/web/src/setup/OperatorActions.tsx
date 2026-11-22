import { FLIGHT_APPROVAL_RULES, type PullRequestView } from "@mc/core";
import { useState } from "react";
import { apiPost } from "../api.ts";
import { ACTIONS, RESOURCES, useResource } from "../data.ts";

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
  const [repoId, setRepoId] = useState("");
  const [prNumber, setPrNumber] = useState("");
  const [prReason, setPrReason] = useState("");
  const [prNote, setPrNote] = useState("");
  const config = useResource<{ repos: { id: string }[] }>(RESOURCES.config).data;
  const prs = useResource<PullRequestView[]>(repoId ? RESOURCES.allPrs(repoId) : null).data;
  const open = (prs ?? []).filter((pr) => pr.state === "open" && pr.headSha !== null);
  const chosen = open.find((pr) => String(pr.number) === prNumber);
  const prAction = (path: string, body: Record<string, unknown>) => {
    if (!chosen?.headSha) {
      setMessage("Choose a repo and an open PR first.");
      return;
    }
    void post(path, { sha: chosen.headSha, ...body });
  };
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
          onClick={() => {
            const until = new Date(approval.until);
            if (Number.isNaN(until.getTime())) {
              setMessage("Choose when the approval ends.");
              return;
            }
            void post(ACTIONS.flightApprovals, { ...approval, until: until.toISOString() });
          }}
        >
          Grant approval
        </button>
      </fieldset>
      <fieldset className="fgroup">
        <legend>Hand-opened PR</legend>
        <label>
          Repo{" "}
          <select
            value={repoId}
            onChange={(e) => {
              setRepoId(e.target.value);
              setPrNumber("");
            }}
          >
            <option value="">Choose a repo</option>
            {config?.repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          Open PR{" "}
          <select value={prNumber} onChange={(e) => setPrNumber(e.target.value)}>
            <option value="">Choose a PR</option>
            {open.map((pr) => (
              <option key={pr.number} value={pr.number}>
                #{pr.number} {pr.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          PR reason <input value={prReason} onChange={(e) => setPrReason(e.target.value)} />
        </label>
        <label>
          PR note <input value={prNote} onChange={(e) => setPrNote(e.target.value)} />
        </label>
        <button
          type="button"
          onClick={() => prAction(ACTIONS.prReviewRequest(repoId, prNumber), { action: "ask" })}
        >
          Ask for review
        </button>
        <button
          type="button"
          onClick={() =>
            prAction(ACTIONS.prReviewRequest(repoId, prNumber), { action: "withdraw" })
          }
        >
          Withdraw ask
        </button>
        <button
          type="button"
          disabled={!prReason.trim()}
          onClick={() =>
            prAction(ACTIONS.prMergeHold(repoId, prNumber), { action: "hold", reason: prReason })
          }
        >
          Hold merge
        </button>
        <button
          type="button"
          onClick={() => prAction(ACTIONS.prMergeHold(repoId, prNumber), { action: "release" })}
        >
          Release hold
        </button>
        <button
          type="button"
          onClick={() => prAction(ACTIONS.prControllerCheck(repoId, prNumber), { verdict: "pass" })}
        >
          Pass controller check
        </button>
        <button
          type="button"
          disabled={!prNote.trim()}
          onClick={() =>
            prAction(ACTIONS.prControllerCheck(repoId, prNumber), {
              verdict: "fail",
              note: prNote,
            })
          }
        >
          Fail controller check
        </button>
      </fieldset>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
