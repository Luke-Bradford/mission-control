import { ATTENTION_LABEL, type AttentionItem } from "@mc/core";
import { needsYouItems, openNeed, sortNeeds } from "../attention.ts";
import { useNow } from "../clock.ts";
import { RESOURCES, useResource } from "../data.ts";
import { elapsed } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { followLink, NEEDS_YOU_PATH } from "../router.ts";

/** Rows shown before the rest move behind a link, so this panel never pushes the others away. */
const SHOWN = 4;

/** What is waiting on the operator, in FLIGHT's attention order. Each row opens its item. */
export function NextActionsPanel() {
  const source = useResource<AttentionItem[]>(RESOURCES.attention);
  const now = useNow();
  const items = sortNeeds(needsYouItems(source.data));
  return (
    <Panel
      id="overviewNextP"
      title={
        <a href={NEEDS_YOU_PATH} onClick={(e) => followLink(e, NEEDS_YOU_PATH)}>
          Needs you
        </a>
      }
      sub={source.data ? `${items.length} waiting on you` : undefined}
    >
      {source.error && (
        <p role="status" className="pb s warn-t">
          {source.data ? "Refresh failed. Showing the last items." : "Could not load your items."}
        </p>
      )}
      {!source.data && !source.error && <p className="pb s muted">Loading your items…</p>}
      {source.data && items.length === 0 && (
        <p className="pb s muted">Nothing is waiting for your decision.</p>
      )}
      {items.length > 0 && (
        <ul className="next-list">
          {items.slice(0, SHOWN).map((item) => (
            <li key={item.key}>
              <button type="button" className="next-row" onClick={() => openNeed(item)}>
                <span className="next-kind">{ATTENTION_LABEL[item.kind].toLowerCase()}</span>
                <span className="next-text" title={item.text}>
                  {item.text}
                </span>
                <span className="next-age num">{elapsed(now - item.at)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {items.length > SHOWN && (
        <p className="next-more s">
          <a href={NEEDS_YOU_PATH} onClick={(e) => followLink(e, NEEDS_YOU_PATH)}>
            {items.length - SHOWN} more waiting on you
          </a>
        </p>
      )}
    </Panel>
  );
}
