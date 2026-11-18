import type { ReactNode } from "react";
import { hub, RESOURCES, useResource } from "../data.ts";
import { Panel } from "../hud/Panel.tsx";
import { PlanPictures } from "./PlanView.tsx";
import { type PlansView, ticketNumberOf } from "./types.ts";
import "./plans.css";

/** The newest approved plan and its read state for one ticket. */
export function useSignedOffPlan(repoId: string, number: number | null) {
  const res = useResource<PlansView>(number === null ? null : RESOURCES.plans(repoId));
  const plan = res.data?.history
    .filter(
      (p) => p.status === "approved" && p.repoId === repoId && ticketNumberOf(p.ticket) === number,
    )
    .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0))[0];
  return { plan, ...res };
}

/**
 * The plan the operator signed off, beside what was built: the proposal against the result, the
 * mockups above the screenshots. Nothing shows for a ticket with no signed-off plan.
 */
export function SignedOffPlan({
  repoId,
  number,
  built,
  className,
}: {
  repoId: string;
  number: number | null;
  /** What was built, in the words of the page it sits on. */
  built: ReactNode;
  className?: string;
}) {
  const { plan, loading, error } = useSignedOffPlan(repoId, number);
  if (number === null) return null;
  if (loading && !plan)
    return (
      <Panel
        title="Signed-off plan"
        className={className ? `plan-beside ${className}` : "plan-beside"}
      >
        <p className="pb" role="status">
          Loading the signed-off plan…
        </p>
      </Panel>
    );
  if (error)
    return (
      <Panel
        title="Signed-off plan"
        className={className ? `plan-beside ${className}` : "plan-beside"}
      >
        <p className="pb crit-t" role="alert">
          Could not load the signed-off plan. {error.message}{" "}
          <button type="button" onClick={() => hub.refetch(RESOURCES.plans(repoId).path)}>
            Try again
          </button>
        </p>
      </Panel>
    );
  if (!plan) return null;
  return (
    <Panel
      title="Signed-off plan"
      sub={`${plan.ticket} · size ${plan.size}`}
      className={className ? `plan-beside ${className}` : "plan-beside"}
    >
      <div className="pb plan-beside-grid">
        <section aria-label="What was proposed">
          <h3>Proposed</h3>
          <p className="plan-text">{plan.proposed}</p>
          {plan.risks.trim() !== "" && (
            <>
              <h3>Risks the plan named</h3>
              <p className="plan-text">{plan.risks}</p>
            </>
          )}
          <h3>Mockups</h3>
          <PlanPictures plan={plan} />
        </section>
        <section aria-label="What was built">
          <h3>Built</h3>
          {built}
        </section>
      </div>
    </Panel>
  );
}
