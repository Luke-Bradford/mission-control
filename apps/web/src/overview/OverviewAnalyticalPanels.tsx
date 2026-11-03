import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { NextActionsPanel } from "./NextActionsPanel.tsx";
import { type EvidenceReader, OverviewEvidence } from "./OverviewEvidence.tsx";
import { type History, OverviewHistoryPanel } from "./OverviewHistoryPanel.tsx";
import { useOverviewLayout } from "./OverviewLayout.tsx";
import { TimelinePanel } from "./TimelinePanel.tsx";

const MEASURES: History[] = ["tokens", "spend", "inflight", "ci", "needs"];
export interface MeasuredHistoryReader {
  show: (measure: History) => void;
}
/** One canonical dashboard surface per measure. Complete readers retain the same cached readings. */
export const OverviewMeasuredPanel = forwardRef<MeasuredHistoryReader>(
  function OverviewMeasuredPanel(_, ref) {
    const reader = useRef<EvidenceReader>(null),
      region = useRef<HTMLElement>(null);
    const [selected, setSelected] = useState<History>("tokens"),
      [inspected, setInspected] = useState<History>("tokens");
    const { allHistories } = useOverviewLayout();
    useImperativeHandle(
      ref,
      () => ({
        show(measure) {
          setSelected(measure);
          requestAnimationFrame(() => {
            const panel = region.current?.querySelector<HTMLElement>(
              allHistories ? `#overviewHistory-${measure}` : "#overviewHistoryP",
            );
            panel?.scrollIntoView({ block: "nearest" });
            panel?.querySelector<HTMLElement>("select, button")?.focus({ preventScroll: true });
          });
        },
      }),
      [allHistories],
    );
    const inspect = (measure: History) => {
      setInspected(measure);
      reader.current?.show();
    };
    return (
      <section ref={region} className="overview-history-domain" aria-label="Measured histories">
        {allHistories ? (
          MEASURES.map((measure) => (
            <OverviewHistoryPanel
              key={measure}
              measure={measure}
              compact
              recent
              onInspect={inspect}
            />
          ))
        ) : (
          <OverviewHistoryPanel
            compact
            selectedHistory={selected}
            onSelectHistory={setSelected}
            onInspect={inspect}
          />
        )}
        <OverviewEvidence ref={reader} title="Complete measured history">
          <OverviewHistoryPanel measure={inspected} id="overviewHistoryDetailP" />
        </OverviewEvidence>
      </section>
    );
  },
);

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
