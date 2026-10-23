import type { FlightBriefView } from "@mc/core";
import { useSecond, useTz } from "../clock.ts";
import { Markdown } from "../components/Markdown.tsx";
import { RESOURCES, useResource } from "../data.ts";
import { rel } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { FLIGHT_NO_SEAT } from "./flightTypes.ts";

const DASH = "—";
export const BRIEF_EMPTY = "Nothing here yet.";
export const SITUATION_EMPTY = "FLIGHT has not written its goals or what is in progress yet.";
export const WATCH_EMPTY = "FLIGHT is not watching anything yet.";

/** When a section was last changed: "never updated", "updated —" until the timezone is known. */
export function briefUpdated(at: number | null, now: number, tz: string | null): string {
  if (at === null) return "never updated";
  return tz === null ? `updated ${DASH}` : `updated ${rel(at, now, tz)}`;
}

/** Situation's paragraph: the brief's goals, then what is in progress, as FLIGHT wrote them. */
export function situationText(view: FlightBriefView): string {
  return ["goals", "in_progress"]
    .map((key) => view.sections.find((s) => s.section === key)?.text.trim() ?? "")
    .filter((t) => t !== "")
    .join("\n\n");
}

/** FLIGHT's brief as the hub holds it; undefined until it loads. */
export const useBrief = (): FlightBriefView | undefined =>
  useResource<FlightBriefView>(RESOURCES.flightBrief).data;

/** FLIGHT › FLIGHT's brief: its nine sections, each with when FLIGHT last changed it. */
export function BriefPanel() {
  const view = useBrief();
  const now = useSecond();
  const tz = useTz();
  return (
    <Panel
      id="briefP"
      title="FLIGHT's brief"
      sub="FLIGHT's working memory · each section says when FLIGHT last changed it"
    >
      {view === undefined ? (
        <p className="pb note">{DASH}</p>
      ) : view.session === null ? (
        <p className="pb note">{FLIGHT_NO_SEAT}</p>
      ) : (
        <div className="pb briefgrid">
          {view.sections.map((s) => (
            <section className="briefsec" key={s.section} data-testid="brief-section">
              <h3>{s.title}</h3>
              <span className="s fg2">{briefUpdated(s.updatedAt, now, tz)}</span>
              {s.text.trim() === "" ? (
                <p className="note">{BRIEF_EMPTY}</p>
              ) : (
                <div className="md-txt">
                  <Markdown text={s.text} />
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** Situation's paragraph, from the brief. */
export function SituationText() {
  const view = useBrief();
  if (view === undefined) return <p className="sittext note">{DASH}</p>;
  if (view.session === null) return <p className="sittext note">{FLIGHT_NO_SEAT}</p>;
  const text = situationText(view);
  if (text === "") return <p className="sittext note">{SITUATION_EMPTY}</p>;
  return (
    <div className="sittext">
      <Markdown text={text} />
    </div>
  );
}

/** Watch list: the brief's risks section. */
export function WatchList() {
  const view = useBrief();
  const now = useSecond();
  const tz = useTz();
  if (view === undefined) return <p className="pb note">{DASH}</p>;
  if (view.session === null) return <p className="pb note">{FLIGHT_NO_SEAT}</p>;
  const risks = view.sections.find((s) => s.section === "risks");
  if (!risks || risks.text.trim() === "") return <p className="pb note">{WATCH_EMPTY}</p>;
  return (
    <div className="pb">
      <span className="s fg2">{briefUpdated(risks.updatedAt, now, tz)}</span>
      <div className="md-txt">
        <Markdown text={risks.text} />
      </div>
    </div>
  );
}
