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
      <KpiStrip />
      <div className="overview-crew">
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
    </section>
  );
}
