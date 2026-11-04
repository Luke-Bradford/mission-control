import { ActivityPanel } from "../overview/ActivityPanel.tsx";
import { AgentsPanel } from "../overview/AgentsPanel.tsx";
import { MacRow } from "../overview/MacRow.tsx";
import { NeedsBanner } from "../overview/NeedsBanner.tsx";
import { NextActionsPanel } from "../overview/NextActionsPanel.tsx";
import { OverviewHeader } from "../overview/OverviewHeader.tsx";
import { PipelinePanel } from "../overview/PipelinePanel.tsx";
import { TokensPanel } from "../overview/TokensPanel.tsx";
import "../overview/overview.css";

/**
 * Overview: what is running, how it is progressing, what is limiting us and what just happened.
 * Crew and Board take the wide column, because they carry the most fields. The other column is
 * sized by its Tokens plots. Board and Activity take spare height, so both columns end level.
 */
export function Overview() {
  return (
    <section id="page-overview">
      <OverviewHeader />
      <NeedsBanner awayOnly />
      <div className="overview-grid">
        <div className="overview-primary">
          <AgentsPanel />
          <PipelinePanel />
        </div>
        <div className="overview-secondary">
          <NextActionsPanel />
          <MacRow />
          <TokensPanel />
          <ActivityPanel />
        </div>
      </div>
    </section>
  );
}
