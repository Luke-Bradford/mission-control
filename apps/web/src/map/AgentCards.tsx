import { type MapSeat, type MapSnapshot, seatCallSign } from "@mc/core";
import type { CSSProperties, Ref } from "react";
import { useNow } from "../clock.ts";
import { agentColor } from "../hud/AgentTag.tsx";
import {
  agentCard,
  type BadgeKind,
  badgeModels,
  changeTotals,
  isWorking,
  uncheckedNotes,
} from "./cards.ts";

interface RowProps {
  snapshot: MapSnapshot;
  indices: Record<string, number>;
  names: Record<string, string>;
  selected: string | null;
  onSelect: (seat: string | null) => void;
  onZoom: (seat: string) => void;
  onBadge: (seat: string, kind: BadgeKind, opener: HTMLButtonElement) => void;
  drawerId: string;
}

/**
 * The rail: one row per working agent (ticket, files changed, +/−, last activity; a click selects
 * it and brings the camera to its work), then everyone idle or stopped folded into one muted line.
 */
export function AgentCards({
  headingRef,
  ...props
}: RowProps & { headingRef: Ref<HTMLHeadingElement> }) {
  const now = useNow();
  const { snapshot, names, selected } = props;
  const working = snapshot.seats.filter((seat) => isWorking(seat, now));
  const resting = snapshot.seats.filter((seat) => !isWorking(seat, now));
  const name = (seat: MapSeat) => names[seat.seat] ?? seatCallSign(seat.seat);
  return (
    <section className="map-agents" aria-label="Agents working in this repo">
      <h3 ref={headingRef} tabIndex={-1}>
        Agents · work in flight
      </h3>
      {!working.length && (
        <p className="map-empty">
          {snapshot.seats.length
            ? "No agent is working in this repo right now: the map shows the whole tree."
            : "No crew seats on this repo."}
        </p>
      )}
      {working.map((seat) => (
        <AgentRow key={seat.seat} seat={seat} name={name(seat)} now={now} {...props} />
      ))}
      {resting.length > 0 && (
        <details
          className="map-resting"
          open={resting.some((seat) => seat.seat === selected) || undefined}
        >
          <summary>
            {resting.length} idle or stopped · {resting.map(name).join(", ")}
          </summary>
          {resting.map((seat) => (
            <AgentRow key={seat.seat} seat={seat} name={name(seat)} now={now} rest {...props} />
          ))}
        </details>
      )}
    </section>
  );
}

function AgentRow({
  seat,
  name,
  now,
  rest = false,
  snapshot,
  indices,
  selected,
  onSelect,
  onZoom,
  onBadge,
  drawerId,
}: RowProps & { seat: MapSeat; name: string; now: number; rest?: boolean }) {
  const card = agentCard(seat, now);
  const totals = changeTotals(seat);
  const open = selected === seat.seat;
  const window = seat.context?.window;
  const context =
    seat.context && window != null && window > 0 ? { total: seat.context.total, window } : null;
  const unchecked = uncheckedNotes(seat, snapshot);
  const badges = badgeModels(seat, now);
  return (
    <article
      aria-label={seat.seat}
      className={`map-agent${rest ? " docked" : ""}${selected && !open ? " dim" : ""}`}
      style={
        {
          "--agent": agentColor(
            seat.seat === "FLIGHT"
              ? "flight"
              : (indices[seat.seat] ?? snapshot.seats.indexOf(seat)),
          ),
        } as CSSProperties
      }
    >
      <button
        type="button"
        className="map-agent-select"
        aria-pressed={open}
        title={rest ? undefined : "Show where this agent is working"}
        onClick={() => {
          onSelect(open ? null : seat.seat);
          if (!open && !rest) onZoom(seat.seat);
        }}
      >
        <span className="map-agent-name">{name}</span>
        {!rest && seat.ticket !== null && <span className="map-agent-ticket">#{seat.ticket}</span>}
        {!rest && (
          <span className="map-agent-changes">
            {totals.files ? (
              <>
                {totals.files} file{totals.files === 1 ? "" : "s"} ·{" "}
                <b className="add">+{totals.add}</b> <b className="rem">−{totals.rem}</b>
              </>
            ) : (
              "no changes yet"
            )}
          </span>
        )}
        <span className={card.stuck ? "map-agent-state stuck" : "map-agent-state"}>
          {card.stuck && "Stuck · "}
          {card.state}
        </span>
      </button>
      <button
        type="button"
        className="map-agent-zoom"
        aria-label={`Zoom to ${seat.seat}`}
        title={`Zoom to ${name}`}
        onClick={() => onZoom(seat.seat)}
      >
        ⌖
      </button>
      {(!rest || open) && seat.title && <p className="map-agent-title">{seat.title}</p>}
      {/* questions, refusals, review, tests, CI and waits: one click away, not standing notes */}
      {open && badges.length > 0 && (
        <div className="map-badges">
          {badges.map((badge) => (
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
      )}
      {open && (
        <div className="map-agent-more">
          {card.folder && (
            <p className="map-note">
              Branch folder: {card.folder === "." ? "repo root" : card.folder}
            </p>
          )}
          <p className="map-note">
            In scope {card.scope} · modified {card.modified} · accessing {card.accessing} now
          </p>
          {unchecked.map((note) => (
            <p className="map-unchecked" key={note}>
              {note}
            </p>
          ))}
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
        </div>
      )}
    </article>
  );
}
