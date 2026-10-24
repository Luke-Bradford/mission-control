import { ActivityPanel } from "../overview/ActivityPanel.tsx";
import { AgentsPanel } from "../overview/AgentsPanel.tsx";
import { KpiStrip } from "../overview/KpiStrip.tsx";
import { MachinePanel } from "../overview/MachinePanel.tsx";
import { NeedsBanner } from "../overview/NeedsBanner.tsx";
import { PipelinePanel } from "../overview/PipelinePanel.tsx";
import { QuotaPanel } from "../overview/QuotaPanel.tsx";
import { TimelinePanel } from "../overview/TimelinePanel.tsx";

/** Overview (catalogue 2.1): what needs the operator, the crew, activity, the machine and quota. */
export function Overview() {
  return (
    <section id="page-overview">
      <NeedsBanner />
      <div className="overview-grid">
        <div className="overview-metrics">
          <KpiStrip />
        </div>
        <AgentsPanel />
        <div className="overview-work">
          <TimelinePanel />
          <PipelinePanel />
        </div>
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
