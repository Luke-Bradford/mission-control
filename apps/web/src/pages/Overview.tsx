import { useRef } from "react";
import { ActivityPanel } from "../overview/ActivityPanel.tsx";
import { AgentsPanel } from "../overview/AgentsPanel.tsx";
import { KpiStrip } from "../overview/KpiStrip.tsx";
import { MachinePanel } from "../overview/MachinePanel.tsx";
import { NeedsBanner } from "../overview/NeedsBanner.tsx";
import {
  OverviewMeasuredPanel,
  OverviewTimelinePanel,
} from "../overview/OverviewAnalyticalPanels.tsx";
import { OverviewConstraints } from "../overview/OverviewConstraints.tsx";
import { type EvidenceReader, OverviewEvidence } from "../overview/OverviewEvidence.tsx";
import { OverviewHeader } from "../overview/OverviewHeader.tsx";
import {
  ContextSummaryPanel,
  OverviewHistoryComparison,
} from "../overview/OverviewInvestigation.tsx";
import { PipelinePanel } from "../overview/PipelinePanel.tsx";
import { QuotaPanel } from "../overview/QuotaPanel.tsx";
import { QuotaSummaryPanel } from "../overview/QuotaSummaryPanel.tsx";
import "../overview/overview.css";

/**
 * Overview (catalogue 2.1): what needs the operator, the crew, activity, the machine and quota.
 * The Crew Activity Map is its own page (`/map`); the Timeline links to it.
 */
export function Overview() {
  const allowance = useRef<EvidenceReader>(null),
    machine = useRef<EvidenceReader>(null);
  return (
    <section id="page-overview">
      <OverviewHeader />
      <OverviewConstraints />
      <NeedsBanner awayOnly />
      <div className="overview-grid">
        <div className="overview-metrics">
          <KpiStrip />
        </div>
        <div className="overview-workspace">
          <div className="overview-primary">
            <AgentsPanel />
            <ActivityPanel />
            <PipelinePanel />
            <OverviewEvidence
              ref={allowance}
              title="Complete provider allowance"
              inlineQuery="(min-width: 2200px) and (min-height: 1300px)"
              className="overview-allowance-reader"
            >
              <QuotaPanel />
            </OverviewEvidence>
          </div>
          <div className="overview-analytical">
            <div className="overview-signals">
              <QuotaSummaryPanel onInspect={() => allowance.current?.show()} />
              <OverviewTimelinePanel />
              <OverviewMeasuredPanel />
            </div>
            <div className="overview-resources">
              <MachinePanel compact onInspect={() => machine.current?.show()} />
              <ContextSummaryPanel />
            </div>
          </div>
        </div>
        <OverviewHistoryComparison />
        <OverviewEvidence ref={machine} title="Complete machine, transcripts and test lock">
          <MachinePanel />
        </OverviewEvidence>
      </div>
    </section>
  );
}
