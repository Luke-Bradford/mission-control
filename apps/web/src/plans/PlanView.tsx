import { PICTURE_NOT_STORED, Picture } from "../needs/Pictures.tsx";
import { pictureRoute } from "../needs/pictures.ts";
import "../needs/needs.css";
import type { Plan } from "./types.ts";
import "./plans.css";

/** The plan's pictures, displayed on the page; one the hub does not serve is said so, not loaded. */
export function PlanPictures({ plan }: { plan: Plan }) {
  if (plan.pictures.length === 0) return <p className="muted">No mockups or pictures.</p>;
  return (
    <section className="needs-pictures" aria-label="Mockups and pictures">
      {plan.pictures.map((p) => {
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

const Text = ({ text }: { text: string }) =>
  text.trim() === "" ? (
    <p className="muted">Nothing written.</p>
  ) : (
    <p className="plan-text">{text}</p>
  );

/** The five parts of a plan, in the order the operator reads them. Text is shown as text. */
export function PlanParts({ plan }: { plan: Plan }) {
  return (
    <div className="plan-parts">
      <section aria-labelledby={`${plan.id}-asks`}>
        <h3 id={`${plan.id}-asks`}>What the ticket asks for</h3>
        <Text text={plan.asks} />
      </section>
      <section aria-labelledby={`${plan.id}-proposed`}>
        <h3 id={`${plan.id}-proposed`}>What is proposed</h3>
        <Text text={plan.proposed} />
      </section>
      <section aria-labelledby={`${plan.id}-pictures`}>
        <h3 id={`${plan.id}-pictures`}>Mockups and pictures</h3>
        <PlanPictures plan={plan} />
      </section>
      <section aria-labelledby={`${plan.id}-size`}>
        <h3 id={`${plan.id}-size`}>Size estimate</h3>
        <Text text={plan.size} />
      </section>
      <section aria-labelledby={`${plan.id}-risks`}>
        <h3 id={`${plan.id}-risks`}>Complications and risks</h3>
        <Text text={plan.risks} />
      </section>
    </div>
  );
}
