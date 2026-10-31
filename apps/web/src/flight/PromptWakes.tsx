import type { PromptWakeCost } from "@mc/core";
import { useTz } from "../clock.ts";
import { RESOURCES, useResource } from "../data.ts";
import { hhmm, plural } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { NO_SECTION_DATA, PromptCostBar } from "../hud/PromptCost.tsx";
import { FLIGHT_NO_SEAT, type FlightView } from "./flightTypes.ts";
import { Pending } from "./Pending.tsx";

export const NO_WAKE_SECTION_DATA = NO_SECTION_DATA.replace("this run", "FLIGHT's wakes");

const newestFirst = (a: PromptWakeCost, b: PromptWakeCost): number =>
  b.at - a.at || b.wake - a.wake;

/** What each of FLIGHT's wakes in the last day cost, by prompt section, newest first. */
export function PromptWakes() {
  const flight = useResource<FlightView>(RESOURCES.flight);
  const view = flight.data;
  const tz = useTz();
  const wakes = [...(view?.promptWakes ?? [])].sort(newestFirst);
  return (
    <Panel
      id="promptP"
      title="Prompt cost"
      sub="estimated tokens by section for each wake in the last 24 hours, newest first"
      actions={
        view?.seat ? (
          <span className="flight-count">{plural(wakes.length, "wake")}</span>
        ) : undefined
      }
    >
      {view === undefined ? (
        <Pending what="prompt cost" error={flight.error} resource={RESOURCES.flight} />
      ) : !view.seat ? (
        <p className="pb note">{FLIGHT_NO_SEAT}</p>
      ) : (
        <div className="flight-panel-scroll">
          {flight.error && (
            <p className="pb note" role="status">
              ▲ Stale · could not refresh: {flight.error.message}
            </p>
          )}
          {wakes.length === 0 ? (
            <p className="pb note">{NO_WAKE_SECTION_DATA}</p>
          ) : (
            <ul className="flight-prompt-wakes" aria-label="Prompt cost by wake, newest first">
              {wakes.map((w) => (
                <li key={`${w.runId}:${w.wake}`} data-testid="prompt-wake">
                  <h3 className="s">
                    Wake {w.wake}
                    {tz !== null && <span className="muted"> · {hhmm(w.at, tz)}</span>}
                  </h3>
                  <PromptCostBar cost={w} empty="No tokens recorded for this wake" />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Panel>
  );
}
