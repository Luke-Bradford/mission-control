import { errorText } from "@mc/core";
import { useState } from "react";
import { apiPost } from "../api.ts";
import { ACTIONS, hub, RESOURCES, streamStatus, useResource } from "../data.ts";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";
import { PlanParts } from "../plans/PlanView.tsx";
import type { Plan, PlansView } from "../plans/types.ts";
import { followLink, useSearch } from "../router.ts";
import { useStore } from "../shell/store.ts";
import { toast } from "../shell/Toast.tsx";
import "../qa/qa-history.css";
import "../plans/plans.css";
import "./qa-readiness.css";

const NO_PLANS: Plan[] = [];
const PLANNER_PATH = "/planner";
export const SEND_BACK_NOTE_REQUIRED = "Say what to change before sending the plan back.";

/** Preserve the operator's repo scope while switching Planner views or plans. */
const plannerPath = (repo: string, history: boolean, plan?: string): string => {
  const q = new URLSearchParams();
  if (repo) q.set("repo", repo);
  if (history) q.set("view", "history");
  if (plan) q.set("plan", plan);
  const qs = q.toString();
  return PLANNER_PATH + (qs ? `?${qs}` : "");
};

function PlannerNavigation({ history, repo }: { history: boolean; repo: string }) {
  const waitingPath = plannerPath(repo, false);
  const historyPath = plannerPath(repo, true);
  return (
    <nav className="qa-navigation" aria-label="Planner views">
      <a
        href={waitingPath}
        onClick={(e) => followLink(e, waitingPath)}
        aria-current={!history ? "page" : undefined}
      >
        To plan and sign off
      </a>
      <a
        href={historyPath}
        onClick={(e) => followLink(e, historyPath)}
        aria-current={history ? "page" : undefined}
      >
        History
      </a>
    </nav>
  );
}

/** The decision on a plan: approve it, or send it back with a note. */
function Decide({ plan, repo, disabled }: { plan: Plan; repo: string; disabled: boolean }) {
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const decide = async (path: string, body: unknown, said: string) => {
    setBusy(true);
    setProblem(null);
    try {
      await apiPost(path, body);
      toast(said);
      hub.refetchTopic("boards");
      hub.refetchTopic("flight");
      hub.refetch(RESOURCES.plans(repo).path);
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const sendBack = () => {
    if (note.trim() === "") {
      setProblem(SEND_BACK_NOTE_REQUIRED);
      return;
    }
    void decide(ACTIONS.sendBackPlan(plan.id), { note: note.trim() }, `Sent ${plan.ticket} back.`);
  };
  return (
    <div className="plan-decide">
      {sending && (
        <label>
          Note for the planner
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-invalid={problem === SEND_BACK_NOTE_REQUIRED ? true : undefined}
          />
        </label>
      )}
      {problem && (
        <p className="crit-t s" role="alert">
          {problem}
        </p>
      )}
      <div className="plan-decide-buttons">
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => void decide(ACTIONS.approvePlan(plan.id), {}, `Approved ${plan.ticket}.`)}
        >
          Approve
        </button>
        {sending ? (
          <>
            <button type="button" disabled={disabled || busy} onClick={sendBack}>
              Send back
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => {
                setSending(false);
                setProblem(null);
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <button type="button" disabled={disabled || busy} onClick={() => setSending(true)}>
            Send back
          </button>
        )}
      </div>
    </div>
  );
}

const statusTone = (p: Plan) => (p.status === "approved" ? "ok" : "warn");
const statusWord = (p: Plan) =>
  p.status === "approved" ? "Approved" : p.status === "sent-back" ? "Sent back" : "Waiting";

function PlanRow({
  plan,
  selected,
  history,
  repo,
}: {
  plan: Plan;
  selected: boolean;
  history: boolean;
  repo: string;
}) {
  const to = plannerPath(repo, history, plan.id);
  return (
    <li>
      <a
        className="uat-queue-row"
        href={to}
        aria-current={selected ? "true" : undefined}
        onClick={(e) => followLink(e, to)}
      >
        <span className="uat-queue-title" title={plan.title}>
          {plan.title}
        </span>
        <span className="uat-age plan-history-status">
          {history ? statusWord(plan) : `Size ${plan.size}`}
        </span>
        <span className="uat-queue-meta">{plan.ticket}</span>
      </a>
    </li>
  );
}

function Detail({ plan, repo, enabled }: { plan: Plan; repo: string; enabled: boolean }) {
  const history = plan.status !== "pending";
  return (
    <div className="uat-detail">
      <Panel title={plan.title} sub={plan.ticket}>
        <div className="pb uat-stack">
          {history && (
            <p>
              <Pill tone={statusTone(plan)}>{statusWord(plan)}</Pill>
              {plan.decidedAt !== undefined && (
                <span className="muted"> {new Date(plan.decidedAt).toLocaleString()}</span>
              )}
            </p>
          )}
          {plan.status === "sent-back" && plan.note && (
            <p className="plan-note">
              <strong>Sent back:</strong> {plan.note}
            </p>
          )}
          <PlanParts plan={plan} />
          {plan.status === "pending" && <Decide plan={plan} repo={repo} disabled={!enabled} />}
        </div>
      </Panel>
    </div>
  );
}

/**
 * The Planner tab: the plans waiting for the operator's sign-off, and past ones. Question: which
 * plans do I still have to approve or send back?
 */
export function Planner() {
  const params = new URLSearchParams(useSearch());
  const history = params.get("view") === "history";
  const repo = params.get("repo") ?? "";
  const res = useResource<PlansView>(RESOURCES.plans(repo));
  const connected = useStore(streamStatus).connected;
  const list = (history ? res.data?.history : res.data?.pending) ?? NO_PLANS;
  const wanted = params.get("plan");
  const selected = list.find((p) => p.id === wanted) ?? list[0];
  const title = history ? "History" : "To plan and sign off";
  return (
    <>
      <PlannerNavigation history={history} repo={repo} />
      <section id="page-planner" className="uat-page">
        <header className="uat-title">
          <h1>Planner</h1>
          <p>
            {history
              ? "Plans you approved or sent back, newest first."
              : "Each plan to approve, or send back with a note, before its ticket goes to Ready."}
          </p>
        </header>
        {!connected && (
          <p className="uat-banner" role="status">
            Disconnected from the hub. Decisions are disabled until it reconnects.
          </p>
        )}
        {res.error && (
          <p className="uat-banner crit-t" role="alert">
            {res.data ? "Showing the last plans. " : "The plans did not load. "}
            {res.error.message}{" "}
            <button type="button" onClick={() => hub.refetch(RESOURCES.plans(repo).path)}>
              Try again
            </button>
          </p>
        )}
        <div className="uat-layout">
          <Panel
            title={title}
            sub={`${list.length} ${history ? "decided" : "waiting"}`}
            className="uat-queue"
          >
            {res.loading && !res.data && (
              <p className="pb" role="status">
                Loading the plans…
              </p>
            )}
            {res.data && list.length === 0 && (
              <div className="pb uat-empty">
                <h3>{history ? "No plan has been decided yet" : "No plan is waiting for you"}</h3>
                <p>
                  {history
                    ? "Plans you approve or send back will be listed here."
                    : "The next plan to need your sign-off will appear here."}
                </p>
              </div>
            )}
            {list.length > 0 && (
              <section className="uat-queue-group">
                <ul aria-label={history ? "Decided plans" : "Plans waiting for sign-off"}>
                  {list.map((p) => (
                    <PlanRow
                      key={p.id}
                      plan={p}
                      selected={selected?.id === p.id}
                      history={history}
                      repo={repo}
                    />
                  ))}
                </ul>
              </section>
            )}
          </Panel>
          {selected ? (
            <Detail
              key={selected.id}
              plan={selected}
              repo={repo}
              enabled={connected && !res.error}
            />
          ) : null}
        </div>
      </section>
    </>
  );
}
