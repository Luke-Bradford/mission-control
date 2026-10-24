import type { AttentionItem, AwaySettings } from "@mc/core";
import { operatorItems } from "../attention.ts";
import { needsLamp } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { untilLabel } from "../fmt.ts";
import { Lamp } from "../hud/Lamp.tsx";
import { navigate, PAGE_PATHS } from "../router.ts";
import { openAway } from "../shell/overlays.ts";

/** Count bits in the mockup's order: label, kinds counted, and whether the label pluralises. */
const BITS: { label: string; kinds: AttentionItem["kind"][]; plural: boolean }[] = [
  { label: "asked of you", kinds: ["person"], plural: false },
  { label: "decision", kinds: ["decision"], plural: true },
  { label: "approval", kinds: ["approval", "question"], plural: true },
  { label: "stall", kinds: ["stalled", "lock", "error"], plural: true },
  { label: "message", kinds: ["tag", "message"], plural: true },
  { label: "PR waiting on you", kinds: ["pr"], plural: false },
  { label: "parked", kinds: ["parked"], plural: false },
  { label: "stray change", kinds: ["stray"], plural: true },
];

/** The Overview's banner (catalogue 2.1.1): the away strip when on, then All clear or the count. */
export function NeedsBanner({ awayOnly = false }: { awayOnly?: boolean }) {
  const all = useResource<AttentionItem[]>(RESOURCES.attention).data;
  const items = all && operatorItems(all);
  const away = useResource<AwaySettings>(RESOURCES.away).data;
  const lamp = items
    ? needsLamp(
        items,
        items.some((i) => !i.acked),
      )
    : null;
  // Acknowledged items still count (catalogue §1.3: until the thing is acted on): say how many are not.
  const notAcked = items?.filter((i) => !i.acked).length ?? 0;
  if (awayOnly && !away?.on) return null;
  return (
    <div id="nbanner">
      {away?.on && (
        <div className="awaystrip">
          <b>Away mode is on {untilLabel(away.until)}.</b>
          <span className="fg2">
            Safe tickets only; anything else stays a draft, and comments wait for you.
          </span>
          <span className="spacer" />
          <button type="button" className="sm" onClick={openAway}>
            Settings
          </button>
        </div>
      )}
      {!awayOnly && items && items.length === 0 && (
        <div className="nbanner clear">
          <b>All clear</b>
          <span className="bits">Nothing is waiting on you.</span>
        </div>
      )}
      {!awayOnly && items && items.length > 0 && (
        <button type="button" className="nbanner" onClick={() => navigate(PAGE_PATHS.comms)}>
          {lamp && <Lamp {...lamp} />}
          <b className="num">{items.length}</b>
          <span>things need you</span>
          <span className="bits">
            {BITS.map(({ label, kinds, plural }) => {
              const n = items.filter((i) => kinds.includes(i.kind)).length;
              return n === 0 ? null : (
                <span key={label}>
                  <b className="num bit">{n}</b> {n > 1 && plural ? `${label}s` : label}
                </span>
              );
            })}
            {notAcked > 0 && <span>· {notAcked} not acknowledged</span>}
          </span>
          <span className="spacer" />
          <span className="s accent">Open Comms →</span>
        </button>
      )}
    </div>
  );
}
