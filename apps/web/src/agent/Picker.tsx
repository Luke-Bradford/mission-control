import type { AttentionItem, CrewRow } from "@mc/core";
import { useRef } from "react";
import { needsLamp, seatStatus } from "../crew.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Lamp } from "../hud/Lamp.tsx";
import { Pill } from "../hud/Pill.tsx";
import { agentPath, navigate } from "../router.ts";
import { setSelectedAgent } from "../shell/selection.ts";
import { ListScrollCue } from "./ListScrollCue.tsx";

/**
 * One button per agent in view (catalogue 2.4.1): its needs lamp (still, not a state lamp), tag
 * and state pill; the shown agent is `.on`.
 */
export function Picker({
  rows,
  items,
  current,
}: {
  rows: CrewRow[];
  items: AttentionItem[];
  current: string | null;
}) {
  const picker = useRef<HTMLDivElement>(null);
  return (
    <div className="agent-picker-wrap">
      <ListScrollCue region={picker} label="agents" count={rows.length} />
      {/* biome-ignore lint/a11y/useSemanticElements: this selector is a row of buttons, not a form. */}
      <div
        className="picker"
        id="picker"
        ref={picker}
        role="group"
        aria-label="Pick an agent"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the bounded picker supports native keyboard scrolling.
        tabIndex={0}
      >
        {rows.map((r) => {
          const lamp = needsLamp(
            items.filter((i) => i.agentId === r.id),
            false,
          );
          return (
            <button
              key={r.id}
              type="button"
              className={r.id === current ? "sm on" : "sm"}
              aria-pressed={r.id === current}
              onClick={() => {
                setSelectedAgent(r.id);
                navigate(agentPath(r.id));
              }}
            >
              {lamp && <Lamp {...lamp} />}
              <AgentTag id={r.id} index={r.index} sm />
              <span title={seatStatus(r).reason ?? seatStatus(r).label}>
                <Pill tone={seatStatus(r).tone}>{seatStatus(r).label}</Pill>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
