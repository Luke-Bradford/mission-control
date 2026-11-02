import { ATTENTION_LABEL, type AttentionItem } from "@mc/core";
import { needsYouItems, openNeedsYou, sortNeeds } from "../attention.ts";
import { RESOURCES, useResource } from "../data.ts";
import { Panel } from "../hud/Panel.tsx";
import { openItem } from "../shell/overlays.ts";

/** Existing operator actions, in the same attention order as FLIGHT; never inferred proposals. */
export function NextActionsPanel({ compact = false }: { compact?: boolean } = {}) {
  const source = useResource<AttentionItem[]>(RESOURCES.attention);
  const items = sortNeeds(needsYouItems(source.data));
  if (compact)
    return (
      <section
        id="overviewNextP"
        className="overview-next-compact"
        aria-label="Next operator actions"
      >
        {source.error && (
          <p role="status" className="s warn-t">
            {source.data
              ? "Attention refresh failed; showing last items."
              : "Operator actions could not load."}
          </p>
        )}
        {!source.data && !source.error && <p className="s muted">Loading operator actions…</p>}
        {source.data && !items.length && (
          <p className="s muted">Nothing is waiting for your decision.</p>
        )}
        {items[0] && (
          <div className="overview-next-first">
            <p>
              <b>Next action</b> · {items[0].text}
            </p>
            <button
              type="button"
              className="sm"
              aria-label={`Inspect: ${items[0].text}`}
              onClick={() => (items[0].notTriaging ? openNeedsYou() : openItem(items[0].key))}
            >
              Inspect evidence
            </button>
          </div>
        )}
        {items.length > 1 && (
          <details>
            <summary>{items.length - 1} more recorded operator actions</summary>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: this named bounded region supports keyboard scrolling. */}
            <section className="scroll" tabIndex={0} aria-label="Other operator actions">
              {items.slice(1, 3).map((item) => (
                <article key={item.key}>
                  <p>
                    {ATTENTION_LABEL[item.kind]} · {item.agentId ?? item.ticket ?? item.repoId} ·{" "}
                    {item.text}
                  </p>
                  <button
                    type="button"
                    className="sm"
                    aria-label={`Inspect: ${item.text}`}
                    onClick={() => (item.notTriaging ? openNeedsYou() : openItem(item.key))}
                  >
                    Inspect evidence
                  </button>
                </article>
              ))}
              {items.length > 3 && (
                <button type="button" className="sm" onClick={openNeedsYou}>
                  View all {items.length} operator actions
                </button>
              )}
            </section>
          </details>
        )}
      </section>
    );
  return (
    <Panel id="overviewNextP" title="Next actions" sub="Operator inbox · highest priority first">
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users can scroll the bounded action list. */}
      <section className="overview-next scroll" tabIndex={0} aria-label="Next operator actions">
        {source.error && (
          <p role="status" className="s warn-t">
            {source.data
              ? "Attention refresh failed. Showing the last received items."
              : "Operator actions could not load."}
          </p>
        )}
        {!source.data && !source.error && <p className="s muted">Loading operator actions…</p>}
        {source.data && !items.length && (
          <p className="s muted">Nothing is waiting for your decision.</p>
        )}
        {items.slice(0, 3).map((item) => (
          <article className="overview-next-item" key={item.key}>
            <h3>
              {[ATTENTION_LABEL[item.kind], item.agentId ?? item.ticket ?? item.repoId]
                .filter(Boolean)
                .join(" · ")}
            </h3>
            <p title={item.text}>{item.text}</p>
            <button
              type="button"
              className="sm"
              aria-label={`Inspect: ${item.text}`}
              onClick={() => (item.notTriaging ? openNeedsYou() : openItem(item.key))}
            >
              Inspect evidence
            </button>
          </article>
        ))}
        {items.length > 3 && (
          <button type="button" className="sm" onClick={openNeedsYou}>
            View all {items.length} operator actions
          </button>
        )}
      </section>
    </Panel>
  );
}
