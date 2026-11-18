import type { Telemetry } from "@mc/core";
import { useMemo } from "react";
import type { TelemetryTab } from "../router.ts";
import { CapacityGroup } from "./CapacityGroup.tsx";
import type { Scope } from "./common.ts";
import { FlowOfWork } from "./FlowOfWork.tsx";
import { InstrumentCharts } from "./InstrumentCharts.tsx";
import { Kpis } from "./Kpis.tsx";
import { VisiblePanels } from "./TPanel.tsx";

type UnbuiltTab = Exclude<TelemetryTab, "crew" | "cost" | "throughput">;

interface Coming {
  /** What the finished tab will hold, in one sentence. */
  holds: string;
  /** The panels of the page that predates the tabs that belong here (`TPanel` ids). */
  panels: readonly string[];
  /** Its KPI tiles that belong here (`Kpis` keys). */
  tiles: readonly string[];
}

/**
 * Where each panel of the earlier page lives until its tab is built, so no telemetry disappears.
 * tCrewState, tUtil, tLat, tSubs and tCapcom moved to the Crew tab; tTurn to the seat's Agent page;
 * the cost, token and quota panels to the Cost and tokens tab; tThru, tCycle, tFlow and tCycleControl to
 * the Throughput tab (tForecast is dropped).
 */
export const COMING: Record<UnbuiltTab, Coming> = {
  quality: {
    holds:
      "CI green on first push, first-pass review, rounds per PR, guard blocks by rule, and escaped defects.",
    panels: ["tQual", "tQualityTrend"],
    tiles: ["guard"],
  },
  machine: {
    holds:
      "CPU and memory with test-lock bands, memory pressure and swap, agent and test-run memory, and the test lock table.",
    panels: ["machP", "tMach", "tLock"],
    tiles: ["lock", "testlock"],
  },
};

/** Which group of the earlier page holds which panels. */
const GROUP_PANELS = {
  flow: ["tThru", "tCycle", "tQual", "tCapcom"],
  charts: ["tCrewState", "tFlow", "tCycleControl", "tQualityTrend", "tForecast"],
  capacity: ["machP", "tMach", "tLock"],
} as const;

/** A tab that is not built yet: a short note on what is coming, then the panels it will replace. */
export function ComingTab({
  tab,
  label,
  t,
  scope,
  live,
  filtered,
}: {
  tab: UnbuiltTab;
  label: string;
  t: Telemetry | undefined;
  scope: Scope;
  live: boolean;
  filtered: boolean;
}) {
  const { holds, panels, tiles } = COMING[tab];
  const visible = useMemo(() => new Set(panels), [panels]);
  const has = (group: keyof typeof GROUP_PANELS) =>
    GROUP_PANELS[group].some((id) => visible.has(id));
  return (
    <VisiblePanels.Provider value={visible}>
      <div className="coming">
        <section className="panel coming-note" aria-label={`${label} is coming`}>
          <div className="ph">
            <h2>{label} is coming</h2>
          </div>
          <div className="pb">
            <p>{holds}</p>
            <p className="note">
              Until then, the current panels for this tab stay below. Nothing is dropped.
            </p>
          </div>
        </section>
        <Kpis t={t} live={live} filtered={filtered} only={tiles} />
        {has("flow") && <FlowOfWork t={t} scope={scope} />}
        {has("charts") && (
          <InstrumentCharts scope={scope} series={t?.series} ticketCosts={t?.tokensByTicket} />
        )}
        {has("capacity") && <CapacityGroup t={t} scope={scope} />}
      </div>
    </VisiblePanels.Provider>
  );
}
