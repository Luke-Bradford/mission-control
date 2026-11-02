import { ActivityPanel } from "../overview/ActivityPanel.tsx";
import { AgentsPanel } from "../overview/AgentsPanel.tsx";
import { KpiStrip } from "../overview/KpiStrip.tsx";
import { MachinePanel } from "../overview/MachinePanel.tsx";
import { NeedsBanner } from "../overview/NeedsBanner.tsx";
import { NextActionsPanel } from "../overview/NextActionsPanel.tsx";
import { OverviewHeader } from "../overview/OverviewHeader.tsx";
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
      <OverviewHeader />
      <NeedsBanner awayOnly />
      <div className="overview-grid">
        <div className="overview-metrics">
          <KpiStrip />
        </div>
        <PipelinePanel />
        <div className="overview-work">
          <AgentsPanel />
          <div className="overview-side">
            <TimelinePanel />
            <MachinePanel />
          </div>
        </div>
        <div className="ov">
          <ActivityPanel />
          <NextActionsPanel />
          <div className="col">
            <QuotaPanel />
          </div>
        </div>
      </div>
    </section>
  );
}
