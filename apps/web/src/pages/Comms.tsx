import type { AttentionItem, Crew } from "@mc/core";
import { useEffect, useRef, useState } from "react";
import { CommsGraph } from "../comms/CommsGraph.tsx";
import { CommsNav } from "../comms/CommsNav.tsx";
import { CommsConversation, Conversation } from "../comms/Conversation.tsx";
import { Decisions } from "../comms/Decisions.tsx";
import type { ComposerPrefill } from "../comms/model.ts";
import { NeedsList } from "../comms/NeedsList.tsx";
import { FLIGHT_THREAD, Threads } from "../comms/Threads.tsx";
import { RESOURCES, useResource } from "../data.ts";
import type { FlightSeat } from "../flight/flightTypes.ts";
import {
  type CommsView,
  commsAgentPath,
  commsFlightPath,
  navigate,
  PAGE_PATHS,
} from "../router.ts";
import { ITEM_GONE, openItem } from "../shell/overlays.ts";
import { useSessionScope } from "../shell/session.ts";
import { toast } from "../shell/Toast.tsx";

const STACKED_QUERY = "(max-width: 999px)";

/** Comms (catalogue §2.5): what needs you, and one thread per agent. */
export function Comms({ item, view }: { item: string | null; view?: CommsView }) {
  const items = useResource<AttentionItem[]>(RESOURCES.attention).data;
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const { inView: matchesSession } = useSessionScope();
  const [selected, setSelected] = useState({ id: FLIGHT_THREAD, fromNeeds: false });
  const [prefill, setPrefill] = useState<ComposerPrefill | undefined>();
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (item === null) {
      handled.current = null;
      return;
    }
    if (items === undefined || handled.current === item) return;
    handled.current = item;
    navigate(PAGE_PATHS.comms, { replace: true });
    if (items.some((i) => i.key === item)) openItem(item);
    else toast(ITEM_GONE);
  }, [item, items]);
  const select = (id: string, fromNeeds = false) => {
    setSelected({ id, fromNeeds });
    if (window.matchMedia?.(STACKED_QUERY).matches)
      document.getElementById("chatP")?.scrollIntoView?.({ block: "start" });
  };
  const rows = crew?.rows ?? [];
  const inView = rows.filter((r) => matchesSession(r));
  const row = (selected.fromNeeds ? rows : inView).find((r) => r.id === selected.id) ?? null;
  const flightSeat = useResource<{ seat: FlightSeat | null }>(RESOURCES.flight).data?.seat ?? null;
  const flightId = flightSeat?.id;
  if (view) {
    const agentId = "agentId" in view ? view.agentId : null;
    const selectedRow = agentId
      ? (rows.find((candidate) => candidate.id === agentId) ?? null)
      : null;
    return (
      <section id="page-comms" className="comms-page">
        <div className="comms-grid">
          <div className="comms-left">
            <Decisions
              items={items}
              rows={rows}
              flightSeat={flightSeat}
              onDiscuss={(decision) => {
                const ticket = decision.ticket?.match(/#(\d+)$/)?.[1];
                setPrefill({
                  token: (prefill?.token ?? 0) + 1,
                  text: ticket ? `Re #${ticket}: ` : "Re: ",
                });
                navigate(
                  decision.agentId === null || decision.agentId === flightSeat?.id
                    ? commsFlightPath()
                    : commsAgentPath(decision.agentId),
                );
              }}
            />
            <CommsNav rows={rows} flightId={flightId} view={view} onNavigate={navigate} />
          </div>
          <CommsConversation
            view={view}
            row={selectedRow}
            prefill={prefill}
            onPrefillConsumed={(token) =>
              setPrefill((current) => (current?.token === token ? undefined : current))
            }
          />
          <CommsGraph rows={rows} flightId={flightId} view={view} />
        </div>
      </section>
    );
  }
  return (
    <section id="page-comms">
      <div className="cgrid">
        <div className="col">
          <NeedsList
            items={items}
            rows={rows}
            onAskFlight={() => select(FLIGHT_THREAD)}
            onRead={(id) => select(id, true)}
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
