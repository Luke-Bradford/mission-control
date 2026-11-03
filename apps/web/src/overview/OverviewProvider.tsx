import { useLayoutEffect, useRef, useState } from "react";
import { type EvidenceReader, OverviewEvidence } from "./OverviewEvidence.tsx";
import { QuotaPanel } from "./QuotaPanel.tsx";
import { QuotaSummaryPanel } from "./QuotaSummaryPanel.tsx";

/** One complete table/reader, responsive to its own column; never a second quota collection. */
export function OverviewProvider() {
  const reader = useRef<EvidenceReader>(null),
    region = useRef<HTMLDivElement>(null);
  const [inline, setInline] = useState(false);
  useLayoutEffect(() => {
    const element = region.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const grid = element.closest<HTMLElement>(".overview-grid");
    const update = () => setInline(element.clientWidth >= 900 && (grid?.clientWidth ?? 0) >= 2076);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (grid) observer.observe(grid);
    update();
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={region} className="overview-provider">
      {!inline && <QuotaSummaryPanel onInspect={() => reader.current?.show()} />}
      <OverviewEvidence
        ref={reader}
        title="Complete provider allowance"
        inline={inline}
        className="overview-allowance-reader"
      >
        <QuotaPanel />
      </OverviewEvidence>
    </div>
  );
}
