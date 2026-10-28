import type {
  ActivityRow,
  AgentStream,
  AttentionItem,
  CommsEvent,
  CrewRow,
  FlightView,
} from "@mc/core";
import { useMemo } from "react";
import { isOperatorItem, needsYouItems } from "../attention.ts";
import { useSecond, useTz } from "../clock.ts";
import { crewOrder, doingLine, needsLamp, seatStatus } from "../crew.ts";
import { RESOURCES, useResource, useReviewPrs } from "../data.ts";
import { chatRows, dockRows } from "../flight/conversation.ts";
import { FLIGHT_NO_SEAT } from "../flight/flightTypes.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Lamp } from "../hud/Lamp.tsx";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";
import { useSeatName } from "../seatName.ts";
import { stateWord } from "../shell/Dock.tsx";
import { agentComms, commsLine } from "./messages.tsx";

export const FLIGHT_THREAD = "flight";

const DASH = "—";

/** The FLIGHT entry: a lamp and "{n} for you" while anything needs you, then FLIGHT's last message. */
function FlightEntry({
  items,
  selected,
  onSelect,
}: {
  items: AttentionItem[];
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const flight = useResource<FlightView>(RESOURCES.flight).data;
  const seat = flight?.seat ?? null;
  const stream = useResource<AgentStream>(seat ? RESOURCES.stream(seat.id) : null).data;
  const asks = useMemo(() => needsYouItems(items), [items]);
  const lamp = needsLamp(
    asks,
    asks.some((a) => !a.acked),
  );
  const last = useMemo(
    () =>
      chatRows(dockRows(stream, []))
        .filter((r) => r.kind === "flight")
        .at(-1),
    [stream],
  );
  const line =
    flight === undefined
      ? DASH
      : seat === null
        ? FLIGHT_NO_SEAT
        : (last?.text ?? `${seat.call} · ${stateWord(seat)}`);
  return (
    <button
      type="button"
      className={`nrow thread${selected ? " sel" : ""}`}
      aria-pressed={selected}
      onClick={() => onSelect(FLIGHT_THREAD)}
    >
      {lamp ? <Lamp {...lamp} /> : <span />}
      <div className="tbody">
        <AgentTag id="FLIGHT" index="flight" sm />
        {asks.length > 0 && <Pill tone="warn">{asks.length} for you</Pill>}
        <Pill tone="neutral">Head</Pill>
        <span className="s fg2 doing" title={line}>
          {line}
        </span>
      </div>
    </button>
  );
}

/** Comms › Threads (catalogue 2.5.2): FLIGHT, then one entry per agent in view. */
export function Threads({
  rows,
  items,
  selected,
  onSelect,
}: {
  /** The rows in the current session. */
  rows: CrewRow[];
  items: AttentionItem[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  const now = useSecond();
  const tz = useTz();
  const activity = useResource<ActivityRow[]>(RESOURCES.activity).data;
  // FLIGHT's own seat has the entry above, so it is not listed again.
  const flightId = useResource<FlightView>(RESOURCES.flight).data?.seat?.id;
  return (
    <Panel id="cThreadsP" title="Threads" sub="FLIGHT and each agent">
      <div className="scroll" id="chanList">
        <FlightEntry items={items} selected={selected === FLIGHT_THREAD} onSelect={onSelect} />
        {crewOrder(
          rows.filter((r) => r.id !== flightId),
          items,
        ).map((r) => (
          <Thread
            key={r.id}
            row={r}
            items={items}
            selected={selected === r.id}
            onSelect={onSelect}
            last={agentComms(activity ?? [], r.id).at(-1) ?? null}
            now={now}
            tz={tz}
          />
        ))}
      </div>
    </Panel>
  );
}

function Thread({
  row: r,
  items,
  selected,
  onSelect,
  last,
  now,
  tz,
}: {
  row: CrewRow;
  items: AttentionItem[];
  selected: boolean;
  onSelect: (id: string) => void;
  /** The seat's latest message, shown in place of its doing line. */
  last: CommsEvent | null;
  now: number;
  tz: string | null;
}) {
  const nameOf = useSeatName();
  const mine = items.filter((i) => i.agentId === r.id);
  // only a tag the operator owns tags them; a seat's @CAPCOM goes to FLIGHT first
  const tagged = mine.some((i) => i.kind === "tag" && isOperatorItem(i));
  const lamp = needsLamp(
    mine,
    mine.some((i) => !i.acked),
  );
  // text only: the row is a button, and a link inside one is invalid
  const doing = doingLine(r, now, tz, useReviewPrs(r));
  const line = last ? commsLine(last, r.id, nameOf) : doing;
  const status = seatStatus(r);
  return (
    <button
      type="button"
      className={`nrow thread${selected ? " sel" : ""}${tagged ? " tagged" : ""}`}
      aria-pressed={selected}
      onClick={() => onSelect(r.id)}
    >
      {lamp ? <Lamp {...lamp} /> : <span />}
      <div className="tbody">
        <AgentTag id={r.id} index={r.index} sm />
        {tagged && <Pill tone="warn">Tagged you</Pill>}
        <span title={status.reason ?? status.label}>
          <Pill tone={status.tone}>{status.label}</Pill>
        </span>
        <span className="s fg2 doing" title={line}>
          {line}
        </span>
      </div>
    </button>
  );
}
