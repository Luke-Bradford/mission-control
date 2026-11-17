import type { TelemetryTab } from "../router.ts";

/** Which of the toolbar's filters reach a tab's figures. */
export type TelemetryFilter = "agent" | "account" | "ticket";

export interface TabDef {
  id: TelemetryTab;
  label: string;
  /** A window the tab's figures are fixed to; the Range buttons are hidden while it shows. */
  fixed: string | null;
  filters: readonly TelemetryFilter[];
  /** The tab's own panels are built; false shows the "coming" note over the earlier panels. */
  built: boolean;
}

/** The five tabs, in the order the tab bar shows them (the router owns the ids and their order). */
export const TAB_DEFS: readonly TabDef[] = [
  { id: "crew", label: "Crew", fixed: null, filters: ["agent"], built: true },
  {
    id: "cost",
    label: "Cost and tokens",
    fixed: null,
    filters: ["agent", "account", "ticket"],
    built: false,
  },
  { id: "throughput", label: "Throughput", fixed: "Last 14 days", filters: [], built: false },
  { id: "quality", label: "Quality", fixed: "Last 14 days", filters: [], built: true },
  { id: "machine", label: "Machine", fixed: null, filters: [], built: false },
];

export const tabDef = (id: TelemetryTab): TabDef => TAB_DEFS.find((t) => t.id === id) as TabDef;
