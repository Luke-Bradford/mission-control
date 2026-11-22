import type { TelemetryTab } from "../router.ts";

/** Which of the toolbar's filters reach a tab's figures. */
export type TelemetryFilter = "agent" | "account" | "ticket";

export interface TabDef {
  id: TelemetryTab;
  label: string;
  /** A window the tab's figures are fixed to; the Range buttons are hidden while it shows. */
  fixed: string | null;
  filters: readonly TelemetryFilter[];
}

/** The five tabs, in the order the tab bar shows them (the router owns the ids and their order). */
export const TAB_DEFS: readonly TabDef[] = [
  { id: "crew", label: "Crew", fixed: null, filters: ["agent"] },
  {
    id: "cost",
    label: "Cost and tokens",
    fixed: null,
    filters: ["agent", "account", "ticket"],
  },
  { id: "throughput", label: "Throughput", fixed: "Last 14 days", filters: [] },
  { id: "quality", label: "Quality", fixed: "Last 14 days", filters: [] },
  { id: "machine", label: "Machine", fixed: null, filters: [] },
];

export const tabDef = (id: TelemetryTab): TabDef => TAB_DEFS.find((t) => t.id === id) as TabDef;
