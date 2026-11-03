import { useRef } from "react";
import { ActivityPanel } from "../overview/ActivityPanel.tsx";
import { AgentsPanel } from "../overview/AgentsPanel.tsx";
import { KpiStrip } from "../overview/KpiStrip.tsx";
import { MachinePanel } from "../overview/MachinePanel.tsx";
import { NeedsBanner } from "../overview/NeedsBanner.tsx";
import {
  type MeasuredHistoryReader,
  OverviewMeasuredPanel,
  OverviewTimelinePanel,
} from "../overview/OverviewAnalyticalPanels.tsx";
import { OverviewConstraints } from "../overview/OverviewConstraints.tsx";
import { type EvidenceReader, OverviewEvidence } from "../overview/OverviewEvidence.tsx";
import { OverviewHeader } from "../overview/OverviewHeader.tsx";
import { ContextSummaryPanel } from "../overview/OverviewInvestigation.tsx";
import { OverviewCanvas } from "../overview/OverviewLayout.tsx";
import { OverviewProvider } from "../overview/OverviewProvider.tsx";
import { PipelinePanel } from "../overview/PipelinePanel.tsx";
import "../overview/overview.css";

/** Independent operational domains; existing resources and routes retain their ownership. */
export function Overview() {
  const machine = useRef<EvidenceReader>(null),
    history = useRef<MeasuredHistoryReader>(null);
  return (
    <section id="page-overview">
      <div className="overview-notices">
        <OverviewHeader />
        <OverviewConstraints />
      </div>
      <NeedsBanner awayOnly />
      <OverviewCanvas>
        <div className="overview-metrics">
          <KpiStrip onHistory={(measure) => history.current?.show(measure)} />
        </div>
        <div className="overview-workspace">
          <div className="overview-primary">
            <AgentsPanel />
            <ActivityPanel />
            <PipelinePanel />
          </div>
          <div className="overview-analytical">
            <div className="overview-provider-host">
              <OverviewProvider />
              <MachinePanel compact onInspect={() => machine.current?.show()} />
              <ContextSummaryPanel />
            </div>
            <div className="overview-observations">
              <OverviewTimelinePanel />
              <OverviewMeasuredPanel ref={history} />
            </div>
          </div>
        </div>
        <OverviewEvidence ref={machine} title="Complete machine, transcripts and test lock">
          <MachinePanel />
        </OverviewEvidence>
      </OverviewCanvas>
    </section>
  );
}
