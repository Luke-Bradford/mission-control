import { ATTENTION_LABEL } from "@mc/core";
import { useEffect, useId, useRef } from "react";
import { ExternalLink } from "../components/ExternalLink.tsx";
import { hhmm } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { whereOf, whoOf } from "../notifications.ts";
import { BuildChips } from "./buildStatus.tsx";
import { ItemDetail, useItemDetail } from "./ItemDetail.tsx";
import { closeItem, trapTab, useItem, useOverlay, useReturnFocus } from "./overlays.ts";
import "./ItemPanel.css";

/**
 * A 540px fly-out for one thing that needs the operator. Every item uses the same brief sections;
 * escalations retain their GitHub reply link. Item discussion uses its own persisted history.
 * The body is `ItemDetail`, which the Needs you page shows at full width.
 */
export function ItemPanel() {
  const key = useItem();
  useOverlay("item", key !== null, () => closeItem());
  const detail = useItemDetail(key);
  const { item, holding, thread, agentId, agentIndex, esc, tz, busy, dismiss, when } = detail;
  const head = useId();
  const close = useRef<HTMLButtonElement>(null);
  useReturnFocus(key !== null);
  useEffect(() => {
    if (key !== null) close.current?.focus();
  }, [key]);
  if (key === null) return null;
  return (
    <aside
      className={item?.kind === "person" ? "flyout person-item" : "flyout decision-item"}
      id="discuss"
      aria-labelledby={head}
      onKeyDown={trapTab}
    >
      <div className="panel">
        <div className="ph" id="dsHead">
          <h2 id={head}>{item ? ATTENTION_LABEL[item.kind] : "Item"}</h2>
          {thread && <b>{whoOf(thread)}</b>}
          {agentId !== null && <AgentTag id={agentId} index={agentIndex} sm />}
          {item && !holding && (
            <span className="sub">
              {thread
                ? `${whereOf(thread)} · ${when(thread.updatedAt)}`
                : item.kind !== "person" && item.brief
                  ? `raised by FLIGHT at ${tz ? hhmm(item.brief.at, tz) : "—"}`
                  : esc
                    ? `opened ${when(esc.openedAt)}`
                    : when(item.at)}
            </span>
          )}
          <BuildChips panel="discuss" />
          <span className="act">
            {thread && item?.brief?.person && (
              <ExternalLink
                url={thread.message?.url ?? thread.url}
                allowedOrigin={
                  item.brief.person.source.kind === "teams"
                    ? "https://teams.microsoft.com"
                    : "https://github.com"
                }
              >
                Open in {item.brief.person.source.kind === "teams" ? "Teams" : "GitHub"} ↗
              </ExternalLink>
            )}
            {item && (
              <button
                type="button"
                className="sm ghost"
                disabled={busy}
                onClick={() => dismiss(closeItem)}
              >
                Dismiss
              </button>
            )}
            <button type="button" className="sm" ref={close} onClick={() => closeItem()}>
              Close
            </button>
          </span>
        </div>
        <div className="item-body">
          <ItemDetail detail={detail} layout="panel" />
        </div>
      </div>
    </aside>
  );
}
