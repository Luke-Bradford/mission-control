import type { AttentionItem, Crew } from "@mc/core";
import { useEffect, useRef, useState } from "react";
import { CommsGraph } from "../comms/CommsGraph.tsx";
import { CommsNav } from "../comms/CommsNav.tsx";
import { CommsConversation } from "../comms/Conversation.tsx";
import { Decisions } from "../comms/Decisions.tsx";
import type { ComposerPrefill } from "../comms/model.ts";
import { RESOURCES, useResource } from "../data.ts";
import type { FlightSeat } from "../flight/flightTypes.ts";
import {
  type CommsView,
  commsAgentPath,
  commsContactPath,
  commsCrewPath,
  commsFlightPath,
  commsTicketPath,
  navigate,
  PAGE_PATHS,
} from "../router.ts";
import { ITEM_GONE, openItem } from "../shell/overlays.ts";
import { toast } from "../shell/Toast.tsx";

/** Comms (catalogue §2.5): route-driven stored conversations and activity. */
export function Comms({ item, view }: { item: string | null; view: CommsView }) {
  const items = useResource<AttentionItem[]>(RESOURCES.attention).data;
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const [prefill, setPrefill] = useState<ComposerPrefill | undefined>();
  const [jump, setJump] = useState<string | null>(null);
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
  const rows = crew?.rows ?? [];
  const flightSeat = useResource<{ seat: FlightSeat | null }>(RESOURCES.flight).data?.seat ?? null;
  const flightId = flightSeat?.id;
  const agentId = "agentId" in view ? view.agentId : null;
  const selectedRow = agentId ? (rows.find((candidate) => candidate.id === agentId) ?? null) : null;
  return (
    <section id="page-comms" className="comms-page">
      <h1 className="sr-only">Comms</h1>
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
          jumpId={jump}
          onJumped={() => setJump(null)}
          onOpenMessage={(to, messageId) => {
            setJump(messageId);
            if (to.kind === "flight") navigate(commsFlightPath());
            else if (to.kind === "crew") navigate(commsCrewPath());
            else if (to.kind === "ticket") navigate(commsTicketPath(to.ref));
            else if (to.kind === "agent") navigate(commsAgentPath(to.agentId));
            else if (to.kind === "inbox")
              navigate(`/comms/agents/${encodeURIComponent(to.agentId)}/inbox`);
            else navigate(commsContactPath(to.agentId, to.contactId));
          }}
          onPrefillConsumed={(token) =>
            setPrefill((current) => (current?.token === token ? undefined : current))
          }
        />
        <CommsGraph rows={rows} flightId={flightId} view={view} />
      </div>
    </section>
  );
}
