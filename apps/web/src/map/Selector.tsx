import { type MapSeat, type MapSnapshot, seatCallSign } from "@mc/core";
import type { CSSProperties } from "react";
import { stateLabel } from "./agents.ts";
import {
  type ChangeCount,
  changeTotals,
  nodeWork,
  readCount,
  type SeatWork,
  seatToken,
  workLine,
} from "./cards.ts";

/** What the rail is showing: a node (a file, or a collapsed folder), or a seat. */
export type Selection = { kind: "node"; path: string } | { kind: "seat"; seat: string } | null;

interface SeatNames {
  snapshot: MapSnapshot;
  /** Every seat's colour place (CrewMapView fills in the ones the crew doesn't list). */
  indices: Record<string, number>;
  names: Record<string, string>;
}

/** A seat's light colour, the one its light and path have on the stage. */
const lightStyle = (seat: string, { indices }: SeatNames): CSSProperties =>
  ({ "--light": `var(${seatToken(seat, indices[seat] ?? 0)})` }) as CSSProperties;
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
  work,
  ...props
}: SeatNames & {
  seats: MapSeat[];
  selected: string | null;
  onSelect: (seat: string | null) => void;
  /** What each seat is on: ticket, title and PR from one source. */
  work: (seat: MapSeat) => SeatWork;
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
        const on = workLine(work(seat));
        const pressed = selected === seat.seat;
        const name = callSign(seat.seat, props.names);
        return (
          <li key={seat.seat}>
            <button
              type="button"
              className="map-seat"
              aria-pressed={pressed}
              aria-label={`${name}: ${on ?? "no ticket"}`}
              title={on ?? undefined}
              onClick={() => onSelect(pressed ? null : seat.seat)}
            >
              <Light seat={seat.seat} {...props} />
              <span className="map-seat-name" style={lightStyle(seat.seat, props)}>
                {name}
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
  work,
  ...props
}: SeatNames & { seat: MapSeat; now: number; work: SeatWork }) {
  const totals = changeTotals(seat);
  const read = readCount(seat);
  return (
    <>
      <h3 className="map-detail-head">
        <Light seat={seat.seat} {...props} />
        {callSign(seat.seat, props.names)}
      </h3>
      <p className="map-detail-on">{workLine(work) ?? "No ticket"}</p>
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
