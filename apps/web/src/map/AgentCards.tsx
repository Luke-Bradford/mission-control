import type { MapSnapshot } from "@mc/core";
import type { CSSProperties, Ref } from "react";
import { useNow } from "../clock.ts";
import { agentColor } from "../hud/AgentTag.tsx";
import { agentCard, type BadgeKind, badgeModels } from "./cards.ts";

export function AgentCards({
  snapshot,
  indices,
  selected,
  onSelect,
  onBadge,
  drawerId,
  headingRef,
}: {
  snapshot: MapSnapshot;
  indices: Record<string, number>;
  selected: string | null;
  onSelect: (seat: string | null) => void;
  onBadge: (seat: string, kind: BadgeKind, opener: HTMLButtonElement) => void;
  drawerId: string;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const now = useNow();
  return (
    <section className="map-agents" aria-label="Agents working in this repo">
      <h3 ref={headingRef} tabIndex={-1}>
        Agents · work in flight
      </h3>
      {!snapshot.seats.length && <p className="map-note">No crew activity on this repo.</p>}
      {snapshot.seats.map((seat, index) => {
        const card = agentCard(seat, now);
        const window = seat.context?.window;
        const context =
          seat.context && window != null && window > 0
            ? { total: seat.context.total, window }
            : null;
        const expanded = !card.docked || selected === seat.seat;
        return (
          <article
            key={seat.seat}
            aria-label={seat.seat}
            className={`map-agent${card.docked ? " docked" : ""}${selected && selected !== seat.seat ? " dim" : ""}`}
            style={
              {
                "--agent": agentColor(
                  seat.seat === "FLIGHT" ? "flight" : (indices[seat.seat] ?? index),
                ),
              } as CSSProperties
            }
          >
            <button
              type="button"
              className="map-agent-select"
              aria-pressed={selected === seat.seat}
              onClick={() => onSelect(selected === seat.seat ? null : seat.seat)}
            >
              <span className="map-agent-name">{seat.seat}</span>
              {!card.docked && seat.ticket !== null && <span>#{seat.ticket}</span>}
              <span className={card.stuck ? "map-agent-state stuck" : "map-agent-state"}>
                {card.stuck && "Stuck · "}
                {card.state}
              </span>
            </button>
            {expanded && (
              <>
                {seat.title && <p className="map-agent-title">{seat.title}</p>}
                {card.folder && <p className="map-note">Branch folder: {card.folder}</p>}
                <p className="map-note">
                  In scope {card.scope} · modified {card.modified} · accessing {card.accessing} now
                </p>
                {context && (
                  <div className="map-context">
                    <meter
                      aria-label={`${seat.seat} context`}
                      min={0}
                      max={context.window}
                      value={Math.min(context.total, context.window)}
                    />
                    <span>
                      Context {context.total.toLocaleString()} of {context.window.toLocaleString()}
                    </span>
                  </div>
                )}
                <div className="map-badges">
                  {badgeModels(seat, now).map((badge) => (
                    <button
                      type="button"
                      key={badge.kind}
                      className={`map-badge ${badge.tone}`}
                      aria-controls={drawerId}
                      aria-haspopup="dialog"
                      onClick={(e) => onBadge(seat.seat, badge.kind, e.currentTarget)}
                    >
                      {badge.text} <span>· {badge.age}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </article>
        );
      })}
    </section>
  );
}
