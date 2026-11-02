import { useLayoutEffect, useRef } from "react";
import { ActivityPanel } from "../overview/ActivityPanel.tsx";
import { AgentsPanel } from "../overview/AgentsPanel.tsx";
import { KpiStrip } from "../overview/KpiStrip.tsx";
import { MachinePanel } from "../overview/MachinePanel.tsx";
import { NeedsBanner } from "../overview/NeedsBanner.tsx";
import { NextActionsPanel } from "../overview/NextActionsPanel.tsx";
import { OverviewHeader } from "../overview/OverviewHeader.tsx";
import { OverviewHistoryPanel } from "../overview/OverviewHistoryPanel.tsx";
import { PipelinePanel } from "../overview/PipelinePanel.tsx";
import { QuotaPanel } from "../overview/QuotaPanel.tsx";
import { QuotaSummaryPanel } from "../overview/QuotaSummaryPanel.tsx";
import { TimelinePanel } from "../overview/TimelinePanel.tsx";
import "../overview/overview.css";

/**
 * Overview (catalogue 2.1): what needs the operator, the crew, activity, the machine and quota.
 * The Crew Activity Map is its own page (`/map`); the Timeline links to it.
 */
export function Overview() {
  const workspace = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const layout = workspace.current;
    if (!layout || typeof ResizeObserver === "undefined") return;
    // Keep the same mounted readers in every composition. Geometry variables position the
    // independent columns without conditional remounts, extra fetches or clock subscriptions.
    const targets = {
      "--crew-height": "#agentsP",
      "--primary-width": ".overview-primary",
      "--quota-summary-height": "#quotaSummaryP",
      "--timeline-height": "#timelineP",
    };
    const measure = () => {
      for (const [name, selector] of Object.entries(targets)) {
        const box = layout.querySelector(selector)?.getBoundingClientRect();
        if (!box) continue;
        const value = `${name === "--primary-width" ? box.width : box.height}px`;
        if (layout.style.getPropertyValue(name) !== value) layout.style.setProperty(name, value);
      }
    };
    const observer = new ResizeObserver(measure);
    for (const selector of Object.values(targets)) {
      const element = layout.querySelector(selector);
      if (element) observer.observe(element);
    }
    measure();
    return () => observer.disconnect();
  }, []);
  return (
    <section id="page-overview">
      <OverviewHeader />
      <NeedsBanner awayOnly />
      <div className="overview-grid">
        <div className="overview-metrics">
          <KpiStrip />
        </div>
        <div className="overview-workspace" ref={workspace}>
          <div className="overview-primary">
            <AgentsPanel />
            <ActivityPanel />
            <TimelinePanel footer={<NextActionsPanel compact />} />
            <QuotaPanel />
          </div>
          <div className="overview-secondary">
            <QuotaSummaryPanel />
            <OverviewHistoryPanel />
            <MachinePanel />
          </div>
        </div>
        <PipelinePanel />
      </div>
    </section>
  );
}
