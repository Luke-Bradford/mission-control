import type { AttentionItem, Crew } from "@mc/core";
import { useEffect, useRef, useState } from "react";
import { Conversation } from "../comms/Conversation.tsx";
import { NeedsList } from "../comms/NeedsList.tsx";
import { FLIGHT_THREAD, Threads } from "../comms/Threads.tsx";
import { RESOURCES, useResource } from "../data.ts";
import { navigate, PAGE_PATHS } from "../router.ts";
import { openItem } from "../shell/overlays.ts";
import { inSession, setSession, useSession } from "../shell/session.ts";
import { toast } from "../shell/Toast.tsx";

/** Where `.cgrid` stacks to one column (hud.css). */
const STACKED_QUERY = "(max-width: 999px)";

export const ITEM_GONE = "That item is no longer waiting.";

/** Comms (catalogue §2.5): what needs you, and one thread per agent. `item` is `/comms/:itemKey`. */
export function Comms({ item }: { item: string | null }) {
  const items = useResource<AttentionItem[]>(RESOURCES.attention).data;
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const [session] = useSession();
  const [selected, setSelected] = useState(FLIGHT_THREAD);

  // A link to one item opens its panel once the list is known; a key that has gone opens nothing.
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (item === null) {
      handled.current = null;
      return;
    }
    if (items === undefined || handled.current === item) return;
    handled.current = item;
    // the link's path gives way to the page first, so the open item's ?item= lands on /comms
    navigate(PAGE_PATHS.comms, { replace: true });
    if (items.some((i) => i.key === item)) openItem(item);
    else toast(ITEM_GONE);
  }, [item, items]);

  // Below 1000 px the conversation stacks under the list: bring it into view.
  const select = (id: string) => {
    const target = crew?.rows.find((r) => r.id === id);
    if (target && !inSession(session, target.repoId)) setSession(target.repoId);
    setSelected(id);
    if (window.matchMedia?.(STACKED_QUERY).matches) {
      document.getElementById("chatP")?.scrollIntoView?.({ block: "start" });
    }
  };

  const rows = crew?.rows ?? [];
  const inView = rows.filter((r) => inSession(session, r.repoId));
  const row = inView.find((r) => r.id === selected) ?? null;

  return (
    <section id="page-comms">
      <div className="cgrid">
        <div className="col">
          <NeedsList
            items={items}
            rows={rows}
            onAskFlight={() => select(FLIGHT_THREAD)}
            onRead={select}
          />
          <Threads
            rows={inView}
            items={items ?? []}
            selected={row?.id ?? FLIGHT_THREAD}
            onSelect={select}
          />
        </div>
        <Conversation row={row} />
      </div>
    </section>
  );
}
