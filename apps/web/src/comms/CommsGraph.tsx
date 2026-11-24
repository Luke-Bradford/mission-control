import { COMMS_MESSAGE_MAX, COMMS_METRICS, type CommsMetricsView, type CrewRow } from "@mc/core";
import { useEffect, useMemo, useRef } from "react";
import { callSign } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { percent } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import {
  type CommsView,
  commsAgentPath,
  commsContactPath,
  commsFlightPath,
  navigate,
} from "../router.ts";
import { type CrewMap, createCrewMap, type MapPins, type MapSelection } from "./crewMap.ts";
import { CAPCOM, crewMapSnapshot, type FeedMessage, type OpenItem } from "./crewMapSnapshot.ts";

/** Places the operator kept (Alt-drag), per view size; they outlive the map being remounted. */
let keptPins: MapPins = {};

/** Where a click on a seat or a link opens: the seat's conversations, or the pair's. */
export function mapSelectionPath(selection: MapSelection, flightId: string | undefined): string {
  const open = (id: string) => (id === CAPCOM || id === flightId ? commsFlightPath() : null);
  if (selection.type === "seat") return open(selection.id) ?? commsAgentPath(selection.id);
  const [a, b] = [selection.a, selection.b];
  if (open(a) === null && open(b) === null) return commsContactPath(a, b);
  return commsAgentPath(open(a) === null ? a : b);
}

/** The Comms right column: the living crew map, with the message lengths beneath it. */
export function CommsGraph({
  rows,
  flightId,
}: {
  rows: CrewRow[];
  flightId: string | undefined;
  view: CommsView;
}) {
  const feedResource = useResource<{ messages: FeedMessage[] }>(RESOURCES.commsFeed);
  const openResource = useResource<{ items: OpenItem[] }>(RESOURCES.commsOpen);
  const lengthsResource = useResource<CommsMetricsView>(RESOURCES.commsMetrics);
  const lengths = lengthsResource.data?.p95BySeat;
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<CrewMap | null>(null);
  const flight = useRef(flightId);
  flight.current = flightId;

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const made = createCrewMap(node, {
      pins: keptPins,
      onPinsChange: (pins) => {
        keptPins = pins;
      },
      onOpenConversation: (selection) => navigate(mapSelectionPath(selection, flight.current)),
    });
    map.current = made;
    return () => {
      made.destroy();
      map.current = null;
    };
  }, []);

  const feed = feedResource.data?.messages;
  const open = openResource.data?.items;
  const failed = feedResource.error !== null || openResource.error !== null;
  const snapshot = useMemo(
    () =>
      feed === undefined
        ? null
        : crewMapSnapshot({
            rows,
            flightId,
            feed,
            open: open ?? [],
            now: Date.now(),
            ok: !failed,
          }),
    [rows, flightId, feed, open, failed],
  );
  useEffect(() => {
    if (snapshot) map.current?.update(snapshot);
  }, [snapshot]);

  return (
    <aside className="comms-right" aria-label="Comms activity">
      <div className="comms-map panel" ref={host} />
      <Panel
        id="commsLength"
        className="comms-length-panel"
        title={COMMS_METRICS.messageLengthP95.label}
        sub={`per sender · ${COMMS_METRICS.messageLengthP95.window} · limit ${COMMS_MESSAGE_MAX.toLocaleString()} ${COMMS_METRICS.messageLengthP95.unit}`}
      >
        {lengths === undefined && lengthsResource.error !== null ? (
          <p className="comms-traffic-empty" role="alert">
            Couldn't load message lengths. Retrying.
          </p>
        ) : lengths === undefined ? (
          <p className="comms-traffic-empty">Loading message lengths…</p>
        ) : (
          <>
            {lengthsResource.error !== null && (
              <p className="comms-length-stale" role="status">
                <i aria-hidden="true" />
                Stale · couldn't refresh. Retrying.
              </p>
            )}
            {lengths.length === 0 ? (
              <p className="comms-traffic-empty">No messages in the last 24h.</p>
            ) : (
              <ul className="comms-length-list" title={COMMS_METRICS.messageLengthP95.definition}>
                {[...lengths]
                  .sort((a, b) => (b.p95 ?? -1) - (a.p95 ?? -1))
                  .map(({ seatId, p95, n }) => {
                    const row = rows.find((r) => r.id === seatId);
                    const level = lengthLevel(p95);
                    return (
                      <li key={seatId} className={level}>
                        <b>{row === undefined ? seatId : callSign(row)}</b>
                        <span className="comms-length-value">
                          {p95 === null ? "—" : Math.round(p95).toLocaleString()}
                          {level !== "" && (
                            <em>{level === "over" ? " over limit" : " near limit"}</em>
                          )}
                        </span>
                        <span className="comms-length-n">{n} msg</span>
                        <span className="comms-watch-bar" aria-hidden="true">
                          <i
                            style={{
                              width: percent(
                                Math.min(100, ((p95 ?? 0) / COMMS_MESSAGE_MAX) * 100),
                                0,
                              ),
                            }}
                          />
                        </span>
                      </li>
                    );
                  })}
              </ul>
            )}
          </>
        )}
      </Panel>
    </aside>
  );
}

/** Near the limit from 80% of it; over once the p95 passes it. */
const NEAR_LIMIT = 0.8;
function lengthLevel(p95: number | null): "" | "near" | "over" {
  if (p95 === null) return "";
  if (p95 > COMMS_MESSAGE_MAX) return "over";
  return p95 >= COMMS_MESSAGE_MAX * NEAR_LIMIT ? "near" : "";
}
