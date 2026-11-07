import { dur } from "../../fmt.ts";
import type { Blocker } from "./blockers.ts";

export const NOTHING_BLOCKING = "Nothing is blocking FLIGHT";

/** The blockers table; with none, the panel says so at the top. */
export function BlockersList({ rows }: { rows: Blocker[] }) {
  if (rows.length === 0) {
    return (
      <div className="fp-empty" id="blockers">
        <b className="fp-ok">{NOTHING_BLOCKING}</b>
        <span>If something stalls, it appears here with its owner and how long it has waited.</span>
      </div>
    );
  }
  return (
    <div className="fp-blockers" id="blockers">
      <div className="fp-bhead">
        <span>Blocker</span>
        <span>Owner</span>
        <span className="fp-r">Waited ↓</span>
        <span>What FLIGHT is doing</span>
      </div>
      <div className="fp-brows">
        {rows.map((b) => (
          <div className="fp-brow" key={b.key}>
            <div className="fp-what">
              <b title={b.what}>{b.what}</b>
              {b.detail && <span title={b.detail}>{b.detail}</span>}
            </div>
            <span className={`fp-owner ${b.tone}`}>{b.owner}</span>
            <span className="fp-wait">{b.waitedMs === null ? "—" : dur(b.waitedMs)}</span>
            <span className="fp-act" title={b.doing}>
              {b.doing}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
