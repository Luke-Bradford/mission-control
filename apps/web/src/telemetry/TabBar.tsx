import { type KeyboardEvent, useRef } from "react";
import type { TelemetryTab } from "../router.ts";
import { TAB_DEFS } from "./tabs.ts";

export const tabId = (id: TelemetryTab): string => `telemetry-tab-${id}`;
export const TAB_PANEL_ID = "telemetry-tabpanel";

/** The five tabs. Arrow keys, Home and End move between them and open the one they land on. */
export function TabBar({
  value,
  onChange,
}: {
  value: TelemetryTab;
  onChange: (tab: TelemetryTab) => void;
}) {
  const refs = useRef(new Map<TelemetryTab, HTMLButtonElement>());
  const move = (e: KeyboardEvent, from: number) => {
    const last = TAB_DEFS.length - 1;
    const to =
      e.key === "ArrowRight"
        ? from === last
          ? 0
          : from + 1
        : e.key === "ArrowLeft"
          ? from === 0
            ? last
            : from - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : null;
    if (to === null) return;
    e.preventDefault();
    const next = (TAB_DEFS[to] as (typeof TAB_DEFS)[number]).id;
    onChange(next);
    refs.current.get(next)?.focus();
  };
  return (
    <div className="tablist" role="tablist" aria-label="Telemetry tabs">
      {TAB_DEFS.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            if (el) refs.current.set(t.id, el);
            else refs.current.delete(t.id);
          }}
          type="button"
          role="tab"
          id={tabId(t.id)}
          aria-selected={t.id === value}
          aria-controls={TAB_PANEL_ID}
          tabIndex={t.id === value ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => move(e, i)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
