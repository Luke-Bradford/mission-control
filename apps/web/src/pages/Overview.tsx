import { ActivityPanel } from "../overview/ActivityPanel.tsx";
import { AgentsPanel } from "../overview/AgentsPanel.tsx";
import { KpiStrip } from "../overview/KpiStrip.tsx";
import { MachinePanel } from "../overview/MachinePanel.tsx";
import { NeedsBanner } from "../overview/NeedsBanner.tsx";
import { PipelinePanel } from "../overview/PipelinePanel.tsx";
import { QuotaPanel } from "../overview/QuotaPanel.tsx";
import { TimelinePanel } from "../overview/TimelinePanel.tsx";
import "../overview/overview.css";

/**
 * Overview (catalogue 2.1): what needs the operator, the crew, activity, the machine and quota.
 * The Crew Activity Map is its own page (`/map`); the Timeline links to it.
 */
export function Overview() {
  return (
    <section id="page-overview">
      <h1 className="sr-only">Overview</h1>
      <NeedsBanner awayOnly />
      <div className="overview-grid">
        <div className="overview-metrics">
          <KpiStrip />
        </div>
        <div className="overview-work">
          <AgentsPanel />
          <TimelinePanel />
        </div>
        <PipelinePanel />
        <div className="ov">
          <ActivityPanel />
          <div className="col">
            <MachinePanel />
            <QuotaPanel />
          </div>
        </div>
      </div>
    </section>
  );
}
