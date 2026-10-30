import { useTz } from "../clock.ts";
import { RESOURCES, useResource } from "../data.ts";
import { hhmm, plural } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { followLink, PAGE_PATHS } from "../router.ts";
import { decisionAnchor, isForTheController } from "./conversation.ts";
import { FLIGHT_NO_SEAT, type FlightView } from "./flightTypes.ts";
import { Pending } from "./Pending.tsx";

export const NO_POWER_REQUESTS = "No open requests for the controller";
const DASH = "—";

/** Missing powers: what FLIGHT asked the controller for in the last day, newest first. */
export function PowerRequests() {
  const flight = useResource<FlightView>(RESOURCES.flight);
  const view = flight.data;
  const tz = useTz();
  // The hub's metrics scan is not capped; fall back to the capped list for an older hub.
  const asks = [
    ...(view?.controllerDecisions ?? view?.decisions.filter(isForTheController) ?? []),
  ].sort((a, b) => b.at - a.at || b.id - a.id);
  return (
    <Panel
      id="powersP"
      title="Missing powers"
      sub={
        view === undefined ? "what FLIGHT could not do" : `${plural(asks.length, "request")} open`
      }
    >
      <div className="flight-panel-scroll">
        {view === undefined ? (
          <Pending what="requests" error={flight.error} resource={RESOURCES.flight} />
        ) : !view.seat ? (
          <p className="pb note">{FLIGHT_NO_SEAT}</p>
        ) : asks.length === 0 ? (
          <p className="pb note">{NO_POWER_REQUESTS}</p>
        ) : (
          asks.map((d) => {
            const to = `${PAGE_PATHS.flight}#${decisionAnchor(d.id)}`;
            return (
              <div className="drow" key={d.id} data-testid="power-request">
                <div className="row">
                  <span className="s">{tz === null ? DASH : hhmm(d.at, tz)}</span>
                  <span className="min0">{d.about}</span>
                  <span className="spacer" />
                  <a href={to} className="sm" onClick={(e) => followLink(e, to)}>
                    Decision
                  </a>
                </div>
              </div>
            );
          })
        )}
      </div>
    </Panel>
  );
}
