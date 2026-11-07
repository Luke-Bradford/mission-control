import type { AttentionItem, Crew } from "@mc/core";
import { RESOURCES, streamStatus, useResource } from "../data.ts";
import { isNotTriaging, NotTriagingRow } from "../flight/NotTriaging.tsx";
import { needsGroups, openNeedsKey } from "../flight/needsGroups.ts";
import { Pending } from "../flight/Pending.tsx";
import { HoldItem } from "../needs/HoldItem.tsx";
import { NeedsList } from "../needs/NeedsList.tsx";
import { QuestionBand } from "../needs/QuestionBand.tsx";
import { handledLine, type NotificationsView } from "../notifications.ts";
import { followLink, NEEDS_YOU_PATH, needsYouPath } from "../router.ts";
import { ItemDetail, useItemDetail } from "../shell/ItemDetail.tsx";
import { useSessionScope } from "../shell/session.ts";
import { useStore } from "../shell/store.ts";
import "../needs/needs.css";

export const NOBODY_WAITING = "Nobody is waiting on you.";
export const ITEM_CLOSED = "This item is no longer open.";
export const DISCONNECTED = "Disconnected. Showing the last list received.";

/** The open item: the band over the page-layout detail. */
function Open({ item, items }: { item: AttentionItem; items: readonly AttentionItem[] }) {
  const detail = useItemDetail(item.key);
  const rows = useResource<Crew>(RESOURCES.crew).data?.rows;
  const row = rows?.find((r) => r.id === item.agentId);
  return (
    <>
      <QuestionBand
        item={item}
        row={row}
        actions={isNotTriaging(item) ? undefined : <HoldItem itemKey={item.key} />}
      />
      {isNotTriaging(item) ? (
        <div className="needs-body">
          <div className="needs-main">
            <NotTriagingRow item={item} items={items} open />
          </div>
        </div>
      ) : (
        <ItemDetail detail={detail} layout="page" />
      )}
    </>
  );
}

/**
 * Needs you: what waits for your decision, and what you need to decide it. A list on the left, the
 * open item on the right at full width: the question in a band, the picture, links and brief in
 * the main column, your answer and the conversation beside it.
 */
export function Needs({ item }: { item: string | null }) {
  const attentionRes = useResource<AttentionItem[]>(RESOURCES.attention);
  const attention = attentionRes.data;
  const heldRes = useResource<AttentionItem[]>(RESOURCES.heldAttention);
  const notes = useResource<NotificationsView>(RESOURCES.notifications);
  const { inRepo } = useSessionScope();
  const connection = useStore(streamStatus);
  const { asks, defaulted } = needsGroups(attention);
  const list = [...asks, ...defaulted];
  const first = openNeedsKey(attention);
  const open = item === null ? first : item;
  const current = attention === undefined ? undefined : list.find((i) => i.key === open);
  // the first item opens without changing the URL; a named key that has gone does not jump
  const gone = attention !== undefined && item !== null && current === undefined;
  const handled = (notes.data?.handledToday ?? []).filter((h) => inRepo(h.repoId));
  return (
    <section id="page-needs" className="needs-page">
      <h1 className="sr-only">Needs you</h1>
      {!connection.connected && connection.reconnecting && (
        <p className="note needs-banner" role="status">
          {DISCONNECTED}
        </p>
      )}
      {notes.data === undefined && notes.error !== null && (
        <Pending
          what="your GitHub threads"
          error={notes.error}
          resource={RESOURCES.notifications}
        />
      )}
      {attention === undefined ? (
        <Pending what="what needs you" error={attentionRes.error} resource={RESOURCES.attention} />
      ) : (
        <div className="needs-grid">
          <NeedsList
            asks={asks}
            defaulted={defaulted}
            held={heldRes.data ?? []}
            selected={current?.key ?? null}
            footer={
              handled.length > 0 && (
                <p className="s note needs-handled" data-testid="handled-today">
                  {handledLine(handled)}
                </p>
              )
            }
          />
          <div className="needs-detail" id="needs-detail">
            <div className="needs-pane">
              {list.length === 0 && !gone ? (
                <p className="pb note">{NOBODY_WAITING}</p>
              ) : gone ? (
                <p className="pb note" role="status">
                  {ITEM_CLOSED}{" "}
                  <a
                    href={first === null ? NEEDS_YOU_PATH : needsYouPath(first)}
                    onClick={(e) =>
                      followLink(e, first === null ? NEEDS_YOU_PATH : needsYouPath(first))
                    }
                  >
                    Next waiting item
                  </a>
                </p>
              ) : current ? (
                <Open key={current.key} item={current} items={attention} />
              ) : null}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
