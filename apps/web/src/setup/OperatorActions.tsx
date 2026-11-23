import { FLIGHT_APPROVAL_RULES, type FlightApprovalRule, type PullRequestView } from "@mc/core";
import { useState } from "react";
import { apiPost } from "../api.ts";
import { ACTIONS, RESOURCES, useResource } from "../data.ts";

type ActionGroup = "pace" | "approval" | "pr";

/** A result line inside its own group; `alert` announces a refusal and keeps it next to the button. */
function GroupMessage({ id, text }: { id: string; text?: string }) {
  if (!text) return null;
  return (
    <p
      id={id}
      role={text === "Saved." ? "status" : "alert"}
      className={text === "Saved." ? "muted s" : "crit-t s"}
    >
      {text}
    </p>
  );
}

/** Operator-facing words for each approval rule; the typed value is what the request carries. */
export const APPROVAL_RULE_LABELS: Record<FlightApprovalRule, string> = {
  "merge-floor": "Merge floor (a PR that touches CLAUDE.md or .github)",
  "repo-rules": "Repo rules (one command the guard refused)",
  "merge-push": "Merge push (one push the guard refused)",
};

/** Epoch ms of a `YYYY-MM-DDTHH:mm` wall-clock time in an IANA zone; null when it does not parse. */
export function zonedToEpoch(local: string, timeZone: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const offsetAt = (t: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
        .formatToParts(new Date(t))
        .map((p) => [p.type, p.value]),
    );
    return (
      Date.UTC(
        +parts.year,
        +parts.month - 1,
        +parts.day,
        +parts.hour,
        +parts.minute,
        +parts.second,
      ) -
      Math.floor(t / 1000) * 1000
    );
  };
  const first = wall - offsetAt(wall);
  return wall - offsetAt(first);
}

/** Operator-only safety controls. The server checks authority and validates every request. */
export function OperatorActions() {
  // Each action group keeps its own result, beside its own fields and button.
  const [messages, setMessages] = useState<Partial<Record<ActionGroup, string>>>({});
  const say = (group: ActionGroup, text: string | null) =>
    setMessages((all) => ({ ...all, [group]: text ?? undefined }));
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
  const config = useResource<{ repos: { id: string }[]; operator?: { timezone: string } }>(
    RESOURCES.config,
  ).data;
  const zone = config?.operator?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const prs = useResource<PullRequestView[]>(repoId ? RESOURCES.allPrs(repoId) : null).data;
  const open = (prs ?? []).filter((pr) => pr.state === "open" && pr.headSha !== null);
  const chosen = open.find((pr) => String(pr.number) === prNumber);
  const prAction = (path: string, body: Record<string, unknown>) => {
    if (!chosen?.headSha) {
      say("pr", "Choose a repo and an open PR first.");
      return;
    }
    void post("pr", path, { sha: chosen.headSha, ...body });
  };
  const post = async (group: ActionGroup, path: string, body: unknown) => {
    try {
      await apiPost(path, body);
      say(group, "Saved.");
    } catch (e) {
      say(group, e instanceof Error ? e.message : String(e));
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
            aria-invalid={messages.pace?.startsWith("Slow pace must") ? true : undefined}
            aria-describedby={messages.pace ? "pace-message" : undefined}
            type="datetime-local"
            value={pace.until}
            onChange={(e) => setPace({ ...pace, until: e.target.value })}
          />{" "}
          <span className="muted xs">Time in {zone}; empty means no end.</span>
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
          onClick={() => {
            const until = pace.until === "" ? null : zonedToEpoch(pace.until, zone);
            if (pace.until !== "" && (until === null || until <= Date.now())) {
              say("pace", "Slow pace must end in the future: choose a later date and time.");
              return;
            }
            void post("pace", ACTIONS.pace, {
              on: pace.on,
              until,
              labels: pace.labels
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean),
              maxStarts: Number(pace.maxStarts) || null,
              note: pace.note,
            });
          }}
        >
          Save slow pace
        </button>
        <GroupMessage id="pace-message" text={messages.pace} />
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
              <option key={rule} value={rule}>
                {APPROVAL_RULE_LABELS[rule]}
              </option>
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
              say("approval", "Choose when the approval ends.");
              return;
            }
            void post("approval", ACTIONS.flightApprovals, {
              ...approval,
              until: until.toISOString(),
            });
          }}
        >
          Grant approval
        </button>
        <GroupMessage id="approval-message" text={messages.approval} />
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
        <GroupMessage id="pr-message" text={messages.pr} />
      </fieldset>
    </section>
  );
}
