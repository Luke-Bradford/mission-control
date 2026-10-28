import { Panel } from "../hud/Panel.tsx";
import type { Scope } from "./common.ts";

/**
 * The chart frame is deliberately separate from the telemetry adapter.  Some v2 charts need raw
 * history which the current aggregate endpoint does not report; showing an empty frame is more
 * truthful than reverse-engineering a series from a current status or a median.
 */
function AwaitingHistory({ what, range }: { what: string; range: string }) {
  return (
    <p className="pb s muted">
      {what} data is not available for the last {range} yet.
    </p>
  );
}

export function InstrumentCharts({ scope }: { scope: Scope }) {
  return (
    <div className="tgrid">
      <Panel id="tCrewState" title="Crew state" sub="running, waiting, parked and idle">
        <AwaitingHistory what="Timestamped crew-state history" range={scope.range} />
      </Panel>
      <Panel id="tFlow" title="Cumulative flow" sub="work by board stage">
        <AwaitingHistory what="Board-stage history" range={scope.range} />
      </Panel>
      <Panel id="tCycleControl" title="Cycle-time control chart" sub="p50 and p85 hours">
        <AwaitingHistory what="Per-ticket cycle-time history" range={scope.range} />
      </Panel>
      <Panel id="tQualityTrend" title="Quality trends" sub="daily small multiples">
        <AwaitingHistory what="Daily quality history" range={scope.range} />
      </Panel>
      <Panel id="tCostMerged" title="Cost per merged ticket" sub="API-equivalent estimate">
        <AwaitingHistory what="Merged-ticket cost history" range={scope.range} />
      </Panel>
    </div>
  );
}
