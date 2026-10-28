import { type MapSeat, type MapSnapshot, seatCallSign } from "@mc/core";
import type { CSSProperties } from "react";
import { agentColor } from "../hud/AgentTag.tsx";
import { stateLabel } from "./agents.ts";
import { type ChangeCount, changeTotals, nodeWork, readCount, workLine } from "./cards.ts";

/** What the rail is showing: a node (a file, or a collapsed folder), or a seat. */
export type Selection = { kind: "node"; path: string } | { kind: "seat"; seat: string } | null;

interface SeatNames {
  snapshot: MapSnapshot;
  indices: Record<string, number>;
  names: Record<string, string>;
}

/** A seat's light colour, the one its light and path have on the stage. */
const lightStyle = (seat: string, { snapshot, indices }: SeatNames): CSSProperties =>
  ({
    "--light": agentColor(
      seat === "FLIGHT"
        ? "flight"
        : (indices[seat] ??
            Math.max(
              0,
              snapshot.seats.findIndex((s) => s.seat === seat),
            )),
    ),
  }) as CSSProperties;
const callSign = (seat: string, names: Record<string, string>) => names[seat] ?? seatCallSign(seat);

function Light({ seat, ...props }: SeatNames & { seat: string }) {
  return <i className="map-light" style={lightStyle(seat, props)} aria-hidden="true" />;
}

/**
 * The rail's selector: one row per working seat, its light, call sign and what it is on. A click
 * selects the seat and the stage follows its light; a second click lets it go.
 */
export function SeatSelector({
  seats,
  selected,
  onSelect,
  prs,
  ...props
}: SeatNames & {
  seats: MapSeat[];
  selected: string | null;
  onSelect: (seat: string | null) => void;
  prs: Record<string, number>;
}) {
  if (!seats.length)
    return (
      <p className="map-empty">
        {props.snapshot.seats.length
          ? "No seat is working in this repo right now."
          : "No crew seats on this repo."}
      </p>
    );
  return (
    <ul className="map-seats" aria-label="Seats working in this repo">
      {seats.map((seat) => {
        const on = workLine(seat, prs[seat.seat]);
        const pressed = selected === seat.seat;
        return (
          <li key={seat.seat}>
            <button
              type="button"
              className="map-seat"
              aria-pressed={pressed}
              title={on ?? undefined}
              onClick={() => onSelect(pressed ? null : seat.seat)}
            >
              <Light seat={seat.seat} {...props} />
              <span className="map-seat-name" style={lightStyle(seat.seat, props)}>
                {callSign(seat.seat, props.names)}
              </span>
              <span className={on ? "map-seat-on" : "map-seat-on none"}>{on ?? "no ticket"}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Lines({ count, files }: { count: ChangeCount; files?: number }) {
  return (
    <>
      {files !== undefined && `${files} file${files === 1 ? "" : "s"} · `}
      <b className="add">+{count.add}</b> <b className="rem">−{count.rem}</b>
      {count.churn && <span className="map-note"> edit churn</span>}
    </>
  );
}

/** A seat's card: what it is on, what it is doing, what it changed and what it read. */
export function SeatDetail({
  seat,
  now,
  pr,
  ...props
}: SeatNames & { seat: MapSeat; now: number; pr: number | undefined }) {
  const totals = changeTotals(seat);
  const read = readCount(seat);
  return (
    <>
      <h3 className="map-detail-head">
        <Light seat={seat.seat} {...props} />
        {callSign(seat.seat, props.names)}
      </h3>
      <p className="map-detail-on">{workLine(seat, pr) ?? "No ticket"}</p>
      <dl className="map-facts">
        <dt>Now</dt>
        <dd>{stateLabel(seat, now)}</dd>
        <dt>Changed</dt>
        <dd>{totals.files ? <Lines count={totals} files={totals.files} /> : "nothing yet"}</dd>
        <dt>Read</dt>
        <dd>
          {read} file{read === 1 ? "" : "s"}
        </dd>
      </dl>
    </>
  );
}

/** A node's card: each seat that touched it, in seat order: changed (+/− each), read, or both. */
export function NodeDetail({
  path,
  files,
  ...props
}: SeatNames & { path: string; files: string[] }) {
  const work = nodeWork(props.snapshot, files.length ? files : [path]);
  return (
    <>
      <h3 className="map-detail-path">{path}</h3>
      {files.length > 1 && <p className="map-note">{files.length} files</p>}
      {work.length ? (
        <ul className="map-who" aria-label="Seats that touched it">
          {work.map(({ seat, changed, read }) => (
            <li key={seat}>
              <Light seat={seat} {...props} />
              <span>{callSign(seat, props.names)}</span>
              <span className="map-who-count">
                {changed && (
                  <>
                    changed <Lines count={changed} />
                  </>
                )}
                {changed && read && " · "}
                {read && "read"}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="map-note">No seat has changed or read this.</p>
      )}
    </>
  );
}
