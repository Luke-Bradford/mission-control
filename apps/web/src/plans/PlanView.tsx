import { PICTURE_NOT_STORED, Picture } from "../needs/Pictures.tsx";
import { pictureRoute } from "../needs/pictures.ts";
import "../needs/needs.css";
import type { QaPlan, TicketPlan } from "@mc/core";
import "./plans.css";

/** The plan's pictures, displayed on the page; one the hub does not serve is said so, not loaded. */
type DisplayPlan = TicketPlan | QaPlan;

export function PlanPictures({ plan }: { plan: DisplayPlan }) {
  if (plan.mockups.length === 0) return <p className="muted">No mockups or pictures.</p>;
  return (
    <section className="needs-pictures" aria-label="Mockups and pictures">
      {plan.mockups.map((p) => {
        const route = pictureRoute(p.url);
        return route ? (
          <Picture key={p.url} label={p.caption} route={route} />
        ) : (
          <p className="note" key={p.url}>
            <b>{p.caption}</b>: {PICTURE_NOT_STORED}
          </p>
        );
      })}
    </section>
  );
}

const Text = ({ text }: { text: string | null }) =>
  !text?.trim() ? (
    <p className="muted">Nothing written.</p>
  ) : (
    <p className="plan-text">{text}</p>
  );

/** The five parts of a plan, in the order the operator reads them. Text is shown as text. */
export function PlanParts({ plan }: { plan: DisplayPlan }) {
  const key = "state" in plan ? `${plan.repoId}-${plan.issue}` : plan.ref;
  return (
    <div className="plan-parts">
      <section aria-labelledby={`${key}-asks`}>
        <h3 id={`${key}-asks`}>What the ticket asks for</h3>
        <Text text={plan.asks} />
      </section>
      <section aria-labelledby={`${key}-proposed`}>
        <h3 id={`${key}-proposed`}>What is proposed</h3>
        <Text text={plan.proposal} />
      </section>
      <section className="plan-part-pictures" aria-labelledby={`${key}-pictures`}>
        <h3 id={`${key}-pictures`}>Mockups and pictures</h3>
        <PlanPictures plan={plan} />
      </section>
      <section aria-labelledby={`${key}-size`}>
        <h3 id={`${key}-size`}>Size estimate</h3>
        <Text text={plan.sizeEstimate} />
      </section>
      <section aria-labelledby={`${key}-risks`}>
        <h3 id={`${key}-risks`}>Complications and risks</h3>
        <Text text={plan.risks} />
      </section>
    </div>
  );
}
