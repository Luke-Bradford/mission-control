import { type AttentionItem, type CrewRow, FLIGHT_NOT_RUNNING } from "@mc/core";
import { useSecond, useTz } from "../clock.ts";
import { crewOrder, doingLine, needsLamp, seatStatus } from "../crew.ts";
import { useReviewPrs } from "../data.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Lamp } from "../hud/Lamp.tsx";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";

export const FLIGHT_THREAD = "flight";

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
  return (
    <Panel id="cThreadsP" title="Threads" sub="FLIGHT and each agent" phase="P2">
      <div className="scroll" id="chanList">
        <button
          type="button"
          className={`nrow thread${selected === FLIGHT_THREAD ? " sel" : ""}`}
          aria-pressed={selected === FLIGHT_THREAD}
          onClick={() => onSelect(FLIGHT_THREAD)}
        >
          <AgentTag id="FLIGHT" index="flight" sm />
          <div className="tbody">
            <Pill tone="neutral">Head</Pill>
            <span className="s fg2 doing" title={FLIGHT_NOT_RUNNING}>
              {FLIGHT_NOT_RUNNING}
            </span>
          </div>
        </button>
        {crewOrder(rows, items).map((r) => (
          <Thread
            key={r.id}
            row={r}
            items={items}
            selected={selected === r.id}
            onSelect={onSelect}
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
  now,
  tz,
}: {
  row: CrewRow;
  items: AttentionItem[];
  selected: boolean;
  onSelect: (id: string) => void;
  now: number;
  tz: string | null;
}) {
  const mine = items.filter((i) => i.agentId === r.id);
  const lamp = needsLamp(
    mine,
    mine.some((i) => !i.acked),
  );
  // text only: the row is a button, and a link inside one is invalid
  const doing = doingLine(r, now, tz, useReviewPrs(r));
  return (
    <button
      type="button"
      className={`nrow thread${selected ? " sel" : ""}`}
      aria-pressed={selected}
      onClick={() => onSelect(r.id)}
    >
      {lamp ? <Lamp {...lamp} /> : <span />}
      <div className="tbody">
        <AgentTag id={r.id} index={r.index} sm />
        <Pill tone={seatStatus(r).tone}>{seatStatus(r).label}</Pill>
        <span className="s fg2 doing" title={doing}>
          {doing}
        </span>
      </div>
    </button>
  );
}
