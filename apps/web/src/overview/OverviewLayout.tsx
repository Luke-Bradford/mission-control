import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

interface OverviewLayout {
  hostEvidence: boolean;
  wideDetails: boolean;
  allHistories: boolean;
}
const COMPACT: OverviewLayout = { hostEvidence: false, wideDetails: false, allHistories: false };
const Layout = createContext<OverviewLayout>(COMPACT);
export const useOverviewLayout = () => useContext(Layout);

/** Observe actual space after chrome, notices and KPIs. Only breakpoint changes update React;
 * source clocks/data never drive this provider or rebuild the roster. CSS owns column sizing.
 */
export function OverviewCanvas({ children }: { children: ReactNode }) {
  const element = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState(COMPACT);
  useLayoutEffect(() => {
    const grid = element.current;
    if (!grid || typeof ResizeObserver === "undefined") return;
    const metrics = grid.querySelector<HTMLElement>(".overview-metrics");
    const update = () => {
      const workspace = grid.querySelector<HTMLElement>(".overview-workspace");
      if (!workspace) return;
      const available =
        grid.clientHeight -
        (workspace.getBoundingClientRect().top - grid.getBoundingClientRect().top + grid.scrollTop);
      const width = grid.clientWidth;
      const next = {
        hostEvidence: width >= 2076 && available >= 1120,
        wideDetails: width >= 3164 && available >= 1152,
        allHistories: width >= 3164 && available >= 1672,
      };
      setLayout((previous) =>
        previous.hostEvidence === next.hostEvidence &&
        previous.wideDetails === next.wideDetails &&
        previous.allHistories === next.allHistories
          ? previous
          : next,
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(grid);
    if (metrics) observer.observe(metrics);
    update();
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={element}
      className="overview-grid"
      data-host-evidence={layout.hostEvidence}
      data-wide-details={layout.wideDetails}
      data-all-histories={layout.allHistories}
    >
      <Layout.Provider value={layout}>{children}</Layout.Provider>
    </div>
  );
}
