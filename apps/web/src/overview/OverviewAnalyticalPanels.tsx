import { useRef, useState } from "react";
import { NextActionsPanel } from "./NextActionsPanel.tsx";
import { type EvidenceReader, OverviewEvidence } from "./OverviewEvidence.tsx";
import { type History, OverviewHistoryPanel } from "./OverviewHistoryPanel.tsx";
import { TimelinePanel } from "./TimelinePanel.tsx";

/** User-selected investigation belongs to these readers, never the clock-free page/roster. */
export function OverviewMeasuredPanel() {
  const reader = useRef<EvidenceReader>(null),
    [measure, setMeasure] = useState<History>("tokens");
  return (
    <>
      <OverviewHistoryPanel
        compact
        onInspect={(selected) => {
          setMeasure(selected);
          reader.current?.show();
        }}
      />
      <OverviewEvidence ref={reader} title="Complete measured history">
        <OverviewHistoryPanel measure={measure} id="overviewHistoryDetailP" />
      </OverviewEvidence>
    </>
  );
}

export function OverviewTimelinePanel() {
  const reader = useRef<EvidenceReader>(null);
  return (
    <>
      <TimelinePanel
        compact
        onInspect={() => reader.current?.show()}
        footer={<NextActionsPanel compact />}
      />
      <OverviewEvidence ref={reader} title="Complete measured timeline">
        <TimelinePanel id="timelineDetailP" />
      </OverviewEvidence>
    </>
  );
}
