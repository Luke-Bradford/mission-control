import type { QaPlan, TicketPlan } from "@mc/core";
import type { ReactNode } from "react";
import { Panel } from "../hud/Panel.tsx";
import { PlanPictures } from "./PlanView.tsx";
import "./plans.css";

/**
 * The signed-off plan retained with a ticket or QA report, beside the result it describes.
 */
export function SignedOffPlan({
  plan,
  built,
  className,
}: {
  plan: TicketPlan | QaPlan | null | undefined;
  built: ReactNode;
  className?: string;
}) {
  if (!plan || ("state" in plan && plan.state !== "signed-off")) return null;
  const panelClass = className ? `plan-beside ${className}` : "plan-beside";
  return (
    <Panel title="Signed-off plan" sub={`${plan.ref} · size ${plan.sizeEstimate ?? "—"}`} className={panelClass}>
      <div className="pb plan-beside-grid">
        <section aria-label="What was proposed">
          <h3>Proposed</h3>
          <p className="plan-text">{plan.proposal ?? "Nothing written."}</p>
          {plan.risks && (
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
