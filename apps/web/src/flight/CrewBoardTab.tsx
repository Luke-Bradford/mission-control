import { Panel } from "../hud/Panel.tsx";
import { metricText, metricTitle, useMetrics } from "../metrics.ts";
import { WatchList } from "./Brief.tsx";
import { Summary } from "./Summary.tsx";
import { WorkInFlight } from "./WorkInFlight.tsx";

/** The registry In progress and Blocked figures, so this tab agrees with Overview. */
function CrewStats() {
  const metrics = useMetrics();
  return (
    <span className="flight-count">
      {(["inProgress", "blocked"] as const).map((id) => (
        <span key={id} title={metricTitle(metrics, id)}>
          {metricText(id).label} <b data-metric={id}>{metrics.readings[id]?.value ?? "—"}</b>{" "}
        </span>
      ))}
    </span>
  );
}

/** Crew & board: every seat's state against its ticket, then FLIGHT's queue. */
export function CrewBoardTab() {
  return (
    <>
      <Panel
        id="wifP"
        title="Seats"
        sub="LIVE · ticket, stage, what stops each seat and FLIGHT's next action"
        actions={<CrewStats />}
      >
        <div className="flight-panel-scroll">
          <WorkInFlight />
        </div>
      </Panel>
      <Panel
        id="ledgerP"
        title="FLIGHT's queue"
        sub="what is waiting, what comes next, why, and when it must be revisited"
      >
        <div className="flight-panel-scroll">
          <Summary mode="queue" />
        </div>
      </Panel>
      <Panel
        id="watchP"
        title="Revisit triggers"
        sub="structured follow-ups with an exact action when one is available"
      >
        <div className="flight-panel-scroll">
          <WatchList />
        </div>
      </Panel>
    </>
  );
}
