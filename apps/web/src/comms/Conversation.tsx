import {
  type ActivityRow,
  ATTENTION_LABEL,
  COMMS_CAPCOM,
  COMMS_MC,
  type CrewRow,
  type FlightView,
} from "@mc/core";
import { useLayoutEffect, useRef } from "react";
import { SeatComposer } from "../agent/StreamPanel.tsx";
import { useTz } from "../clock.ts";
import { callSign, seatStatus, seatTurn } from "../crew.ts";
import { hub, RESOURCES, useResource } from "../data.ts";
import { FLIGHT_NO_SEAT } from "../flight/flightTypes.ts";
import { hhmm } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";
import { agentPath, followLink } from "../router.ts";
import { FlightChat } from "../shell/Dock.tsx";
import { agentComms, CAPCOM_TAG, CommsEnd, commsKeys, MentionText } from "./messages.tsx";

/** Comms › Conversation (catalogue 2.5.3): FLIGHT's chat, or the selected agent's thread. */
export function Conversation({ row }: { row: CrewRow | null }) {
  const flightSeat = useResource<FlightView>(RESOURCES.flight).data?.seat ?? null;
  const activity = useResource<ActivityRow[]>(RESOURCES.activity);
  const tz = useTz();
  const box = useRef<HTMLDivElement>(null);
  const msgs = row ? agentComms(activity.data ?? [], row.id) : [];
  const id = row?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the newest message when the thread or its length changes
  useLayoutEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [id, msgs.length]);

  if (row === null) {
    return (
      <Panel
        id="chatP"
        title="FLIGHT"
        sub="decisions and questions come to you here, tagged @CAPCOM"
      >
        {flightSeat === null ? (
          <p className="pb note">{FLIGHT_NO_SEAT}</p>
        ) : (
          <FlightChat where="comms" />
        )}
      </Panel>
    );
  }
  const empty =
    activity.error && !activity.data
      ? "Could not load activity."
      : !activity.data
        ? "Loading…"
        : "No messages yet.";
  const keys = commsKeys(msgs);
  return (
    <Panel
      id="chatP"
      sub={`everything ${row.id} sent or received: you, FLIGHT and other agents`}
      title={
        <>
          Thread · <AgentTag id={row.id} index={row.index} sm /> ·{" "}
          <Pill tone={seatStatus(row).tone}>{seatStatus(row).label}</Pill>
        </>
      }
      actions={
        <a href={agentPath(row.id)} onClick={(e) => followLink(e, agentPath(row.id))}>
          See its activity
        </a>
      }
    >
      {msgs.length === 0 ? (
        <p className="pb note">{empty}</p>
      ) : (
        <div className="scroll" id="convo" ref={box}>
          {msgs.map((m, i) => {
            const tagged = m.text.includes(CAPCOM_TAG);
            const cls = [
              "msg",
              m.who === COMMS_CAPCOM && "mine",
              m.who === COMMS_MC && "sys",
              m.who !== COMMS_CAPCOM && m.who !== COMMS_MC && "peer",
              tagged && "tagged",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div key={keys[i]} className={cls}>
                <div className="from">
                  <span className="num">{tz ? hhmm(m.at, tz) : "—"}</span>
                  <CommsEnd id={m.who} />
                  <span>→</span>
                  <CommsEnd id={m.to} />
                  {tagged && <Pill tone="warn">{ATTENTION_LABEL.tag}</Pill>}
                </div>
                <div className="body">
                  <MentionText text={m.text} />
                </div>
              </div>
            );
          })}
        </div>
      )}
      {row.kind === "crew" && (
        <SeatComposer
          row={row}
          placeholder={
            seatTurn(row) === "running"
              ? `Message ${callSign(row)} (reaches it mid-turn)…`
              : `Message ${callSign(row)} (queued until its next turn)…`
          }
          onSent={() => hub.refetch(RESOURCES.activity.path)}
        />
      )}
    </Panel>
  );
}
