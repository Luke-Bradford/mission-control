import { type ReactNode, useId } from "react";
import { BuildChips, OWN_CHIPS } from "../shell/buildStatus.tsx";
import { useBuildStatus } from "../shell/overlays.ts";
import "./Panel.css";
import "./shared.css";

/**
 * A panel: header (title, subtitle, build-status chips, actions, the `P2` badge the chips replace)
 * and body. `id` is the mockup's element id wherever it has one (build-status chips key on it); a
 * panel without one renders no chips, and neither does one whose page places them itself
 * (`OWN_CHIPS`). Children bring their own body (`.pb`, `.scroll`).
 */
export function Panel({
  id,
  title,
  sub,
  phase,
  actions,
  className,
  children,
}: {
  id?: string;
  title: ReactNode;
  sub?: ReactNode;
  phase?: "P2";
  actions?: ReactNode;
  /** Extra classes beside `panel`, e.g. `wide` in the telemetry grid. */
  className?: string;
  children?: ReactNode;
}) {
  const head = useId();
  const [buildOn] = useBuildStatus();
  const badge = phase && !buildOn;
  return (
    <section className={className ? `panel ${className}` : "panel"} id={id} aria-labelledby={head}>
      <div className="ph">
        <h2 id={head}>{title}</h2>
        {sub !== undefined && <span className="sub">{sub}</span>}
        {id !== undefined && !OWN_CHIPS.has(id) && <BuildChips panel={id} />}
        {(actions !== undefined || badge) && (
          <span className="act">
            {actions}
            {badge && <span className="phase">{phase}</span>}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}
