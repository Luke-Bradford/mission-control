import { useBuildStatus } from "./overlays.ts";

/** Build-status toggle and legend, then the key hints (catalogue §1.2; `s Setup` added, §7.6). */
export function Footer() {
  const [on, setOn] = useBuildStatus();
  return (
    <footer className="keys">
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
      <span>
        <kbd>g</kbd> then <kbd>o</kbd> <kbd>f</kbd> <kbd>b</kbd> <kbd>a</kbd> <kbd>m</kbd>{" "}
        <kbd>c</kbd> <kbd>t</kbd> pages · <kbd>s</kbd> Setup
      </span>
      <span>
        <kbd>f</kbd> FLIGHT
      </span>
      <span>
        <kbd>j</kbd>
        <kbd>k</kbd> next agent
      </span>
      <span>
        <kbd>/</kbd> message agent
      </span>
      <span>
        <kbd>i</kbd> interrupt
      </span>
      <span>
        <kbd>?</kbd> help
      </span>
    </footer>
  );
}
