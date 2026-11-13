import { DemoSwitch } from "./DemoSwitch.tsx";
import { useBuildStatus } from "./overlays.ts";

/** Demo data and build annotations change the display, so they live with other setup controls. */
export function DisplayControls() {
  const [on, setOn] = useBuildStatus();
  return (
    <fieldset className="display-controls">
      <legend className="sr-only">Display controls</legend>
      <DemoSwitch />
      <button
        type="button"
        className="sm"
        title="Mark every panel with how buildable it is today"
        aria-pressed={on}
        onClick={() => setOn(!on)}
      >
        {on ? "Hide build status" : "Show build status"}
      </button>
      <span className="bslegend" hidden={!on}>
        <span className="bs bs-proven">Proven</span>tested against the real thing
        <span className="bs bs-build">Buildable</span>standard work
        <span className="bs bs-later">P2</span>waits on an engine not built yet
        <span className="bs bs-check">Check first</span>a small test before relying on it · hover a
        chip for detail
      </span>
    </fieldset>
  );
}
