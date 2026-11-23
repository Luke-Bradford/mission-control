/** The hub-wide settings an operator edits on Setup › Hub, and when each one takes effect. */
export type SettingApplies = "now" | "restart";
export type HubSettingKind = "text" | "number" | "list" | "choice" | "bool" | "map";

export interface HubSettingDef {
  label: string;
  group: string;
  kind: HubSettingKind;
  unit?: string;
  choices?: readonly string[];
  applies: SettingApplies;
}

export const APPLIES_TEXT: Record<SettingApplies, string> = {
  now: "Applies now",
  restart: "Applies after a restart",
};

/** Operator-facing words for each choice value; requests carry the typed value. */
export const CHOICE_LABELS: Record<string, string> = {
  off: "Off",
  auto: "Automatic",
  between_runs: "Between runs",
  home: "Home",
  work: "Work",
  draft: "Open a draft PR",
  merge: "Merge when ready",
  standard: "Standard",
  superuser: "Superuser",
};

const def = (
  group: string,
  label: string,
  kind: HubSettingKind,
  applies: SettingApplies,
  extra: { unit?: string; choices?: readonly string[] } = {},
): HubSettingDef => ({ group, label, kind, applies, ...extra });

export const HUB_SETTINGS = {
  "operator.timezone": def("Operator", "Time zone", "text", "restart"),
  "operator.github_logins": def("Operator", "GitHub logins", "list", "restart"),
  "poll.usage_minutes": def("Polling", "Usage poll", "number", "restart", { unit: "minutes" }),
  "poll.github_seconds": def("Polling", "GitHub poll", "number", "restart", { unit: "seconds" }),
  "poll.board_minutes": def("Polling", "Board poll", "number", "restart", { unit: "minutes" }),
  "updates.hub": def("Updates", "Hub updates", "choice", "restart", { choices: ["off", "auto"] }),
  "updates.cli": def("Updates", "CLI updates", "choice", "restart", {
    choices: ["off", "between_runs"],
  }),
  "audit.question_wait_minutes": def("Audit", "Question wait", "number", "restart", {
    unit: "minutes",
  }),
  "audit.controller_wait_minutes": def("Audit", "Controller wait", "number", "restart", {
    unit: "minutes",
  }),
  "audit.ticket_text_factor": def("Audit", "Ticket text factor", "number", "restart", {
    unit: "×",
  }),
  "audit.notice_repeats": def("Audit", "Notice repeats", "number", "restart"),
  "crew.worktrees": def("Crew", "Crew folder", "text", "restart"),
  "crew.max_seats": def("Crew", "Maximum seats", "number", "now"),
  "crew.node": def("Crew", "Node path", "text", "restart"),
  "crew.deny_read": def("Crew", "Read deny list", "list", "restart"),
  "crew.allow_read": def("Crew", "Read allow list", "list", "restart"),
  "crew.run_token_budget": def("Crew", "Run token budget", "number", "restart", {
    unit: "tokens",
  }),
  "crew.max_open_runs_per_seat": def("Crew", "Open runs per seat", "number", "now"),
  "crew.lane": def("Crew", "Crew lane", "choice", "now", { choices: ["home", "work"] }),
  "crew.lane_default": def("Crew", "Default lane", "bool", "now"),
  "crew.machine_capacity.disk_free_gb": def("Machine limits", "Disk free", "number", "now", {
    unit: "GB",
  }),
  "crew.machine_capacity.disk_free_pct": def("Machine limits", "Disk free share", "number", "now", {
    unit: "%",
  }),
  "crew.machine_capacity.swap_used_pct": def("Machine limits", "Swap used", "number", "now", {
    unit: "%",
  }),
  "crew.machine_capacity.memory_free_pct": def("Machine limits", "Memory free", "number", "now", {
    unit: "%",
  }),
  "crew.machine_capacity.load_per_core": def("Machine limits", "Load per core", "number", "now"),
  "crew.machine_capacity.load_window_min": def("Machine limits", "Load window", "number", "now", {
    unit: "minutes",
  }),
  "crew.machine_capacity.clear_after_min": def("Machine limits", "Clear after", "number", "now", {
    unit: "minutes",
  }),
  "repo.status_map": def("Repo", "Status map", "map", "restart"),
  "repo.autonomy": def("Repo", "Autonomy", "choice", "restart", { choices: ["draft", "merge"] }),
  "repo.flight_powers": def("Repo", "FLIGHT powers", "choice", "now", {
    choices: ["standard", "superuser"],
  }),
} as const satisfies Record<string, HubSettingDef>;

export type HubSettingKey = keyof typeof HUB_SETTINGS;
export const HUB_SETTING_KEYS = Object.keys(HUB_SETTINGS) as HubSettingKey[];
export const isHubSettingKey = (key: string): key is HubSettingKey =>
  Object.hasOwn(HUB_SETTINGS, key);

/** What config.yaml holds now: `base` is its digest, and each key's raw value (absent when unset). */
export interface HubSettingsView {
  base: string;
  values: Partial<Record<HubSettingKey, unknown>>;
  repos: Record<string, Partial<Record<HubSettingKey, unknown>>>;
}
