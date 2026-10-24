import {
  ATTENTION_LABEL,
  COMMS_CAPCOM,
  COMMS_MC,
  type CommsThreadMessage,
  type CrewRow,
  type FlightView,
} from "@mc/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SeatComposer } from "../agent/StreamPanel.tsx";
import { apiPost } from "../api.ts";
import { useTz } from "../clock.ts";
import { Expandable } from "../components/Expandable.tsx";
import { callSign, seatStatus, seatTurn } from "../crew.ts";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { FLIGHT_NO_SEAT } from "../flight/flightTypes.ts";
import { hhmm } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";
import { agentPath, followLink } from "../router.ts";
import { FlightChat } from "../shell/Dock.tsx";
import { BRIEF_FOLD_AFTER, BRIEF_LINES } from "./ItemBrief.tsx";
import { CommsEnd, MentionText } from "./messages.tsx";

/** Comms › Conversation (catalogue 2.5.3): FLIGHT's chat, or the selected agent's thread. */
export function Conversation({ row }: { row: CrewRow | null }) {
  const flightSeat = useResource<FlightView>(RESOURCES.flight).data?.seat ?? null;
  const activity = useResource<{ messages: CommsThreadMessage[] }>(
    row ? RESOURCES.comms(row.id) : null,
  );
  const [readError, setReadError] = useState<string | null>(null);
  const pending = useRef(new Set<string>());
  const completed = useRef(new Set<string>());
  const tz = useTz();
  const box = useRef<HTMLDivElement>(null);
  const msgs = activity.data?.messages ?? [];
  const id = row?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear a previous thread's read error on selection
  useEffect(() => {
    setReadError(null);
  }, [id]);
  useEffect(() => {
    if (!id) return;
    const unread = msgs.filter(
      (m) =>
        !m.seen && !pending.current.has(`${id}:${m.id}`) && !completed.current.has(`${id}:${m.id}`),
    );
    if (unread.length === 0) return;
    const keys = unread.map((m) => `${id}:${m.id}`);
    for (const key of keys) pending.current.add(key);
    let active = true;
    void apiPost(ACTIONS.commsRead(id), { messageIds: unread.map((m) => m.id) })
      .then(() => {
        for (const key of keys) completed.current.add(key);
        if (active) setReadError(null);
        hub.refetch(RESOURCES.attention.path);
      })
      .catch(() => {
        if (active) setReadError("Could not mark thread read.");
      })
      .finally(() => {
        for (const key of keys) pending.current.delete(key);
      });
    return () => {
      active = false;
    };
  }, [id, msgs]);
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
      {readError && <p className="pb crit-t s">{readError}</p>}
      {msgs.length === 0 ? (
        <p className="pb note">{empty}</p>
      ) : (
        <div className="scroll" id="convo" ref={box}>
          {msgs.map((m) => {
            const tagged = m.tagged;
            const cls = [
              "msg",
              m.from === COMMS_CAPCOM && "mine",
              m.from === COMMS_MC && "sys",
              m.from !== COMMS_CAPCOM && m.from !== COMMS_MC && "peer",
              tagged && "tagged",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div key={m.id} className={cls}>
                <div className="from">
                  <span className="num">{tz && m.at !== null ? hhmm(m.at, tz) : "—"}</span>
                  <CommsEnd id={m.from} />
                  <span>→</span>
                  <CommsEnd id={m.to} />
                  {tagged && <Pill tone="warn">{ATTENTION_LABEL.tag}</Pill>}
                </div>
                <div className="body">
                  <Expandable lines={BRIEF_LINES} foldAfter={BRIEF_FOLD_AFTER}>
                    <MentionText text={m.text} />
                  </Expandable>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {row.kind === "crew" && (
        <SeatComposer
          key={row.id}
          row={row}
          placeholder={
            seatTurn(row) === "running"
              ? `Message ${callSign(row)} (reaches it mid-turn)…`
              : `Message ${callSign(row)} (queued until its next turn)…`
          }
          onSent={() => {
            hub.refetch(RESOURCES.activity.path);
            hub.refetch(RESOURCES.comms(row.id).path);
          }}
        />
      )}
    </Panel>
  );
}
