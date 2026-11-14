import { type CommsMessagesResponse, type Crew, flightTurnText } from "@mc/core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNow, useTz } from "../clock.ts";
import { contextPct, doingLine } from "../crew.ts";
import { RESOURCES, useResource, useReviewPrs } from "../data.ts";
import { FlightThread } from "../flight/FlightThread.tsx";
import { FLIGHT_NO_SEAT, type FlightSeat, type FlightView } from "../flight/flightTypes.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { BuildChips } from "./buildStatus.tsx";
import { DockSummary } from "./DockSummary.tsx";
import {
  setDockCollapsed,
  setFlightUnread,
  toggleDock,
  trapTab,
  useDock,
  useOverlay,
  useReturnFocus,
} from "./overlays.ts";
import "./Dock.css";
import { percent } from "../fmt.ts";

/** The seat's state in words. */
export function stateWord(seat: FlightSeat): string {
  if (!seat.live) return "stopped";
  switch (seat.state) {
    case "idle":
      return "waiting for a wake";
    case "running":
    case "starting":
      return "working";
    case "parked":
      return "rate-limited";
    case "error":
      return "error";
    default:
      return "stopped";
  }
}

/** Clock-dependent metadata stays separate from the summary, rail and mounted composer. */
function DockMeta({ flight }: { flight: FlightView | undefined }) {
  const seat = flight?.seat ?? null;
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const row = crew?.rows.find((r) => r.id === seat?.id);
  const repoPrs = useReviewPrs(row);
  const ctx = row ? contextPct(row) : null;
  const now = useNow();
  const tz = useTz();
  return (
    <div className="meta">
      {flight === undefined
        ? "Loading…"
        : seat
          ? [
              row?.accountId,
              seat.model,
              seat.turns && flightTurnText(seat.turns.n, seat.turns.max),
              ctx !== null && `context ${percent(ctx)}`,
              row ? doingLine(row, now, tz, repoPrs) : stateWord(seat),
            ]
              .filter(Boolean)
              .join(" · ")
          : FLIGHT_NO_SEAT}
    </div>
  );
}

/**
 * FLIGHT's dock (catalogue §1.4): a 380px column on wide screens, a drawer with a scrim below
 * 1200px. With no FLIGHT seat configured the conversation is empty and the input is switched off.
 */
/** The widths with two columns and no room for FLIGHT beside them. Below, the Overview stacks. */
const OVERVIEW_COVER_QUERY = "(min-width: 1500px) and (max-width: 2199px)";

/** At those widths, FLIGHT on the Overview covers the side column so Crew keeps its width. */
export function useOverviewDockOverlay(overview: boolean, dock: ReturnType<typeof useDock>) {
  const [covers, setCovers] = useState(
    () => typeof matchMedia !== "undefined" && matchMedia(OVERVIEW_COVER_QUERY).matches,
  );
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const media = matchMedia(OVERVIEW_COVER_QUERY),
      update = () => setCovers(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return overview && dock.wide && dock.visible && !dock.collapsed && covers;
}

export function Dock({ coversPage = false }: { coversPage?: boolean } = {}) {
  const { visible, wide, collapsed, toggle } = useDock();
  // Esc folds the cover from anywhere on the page, and the page behind stays usable.
  useOverlay("overview-flight", coversPage, () => setDockCollapsed(true));
  const hide = useRef<HTMLButtonElement>(null);
  const rail = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const drawer = visible && !wide;
  const fold = () => setDockCollapsed(!collapsed);
  useReturnFocus(drawer);
  useEffect(() => {
    if (drawer) hide.current?.focus();
  }, [drawer]);
  const flight = useResource<FlightView>(RESOURCES.flight).data;
  const seat = flight?.seat ?? null;
  const flightMessages = useResource<CommsMessagesResponse>(RESOURCES.commsFlight).data?.messages;
  // The reply last seen with the dock shown; undefined until the thread first loads, so history is not "new".
  const replyIds = useMemo(
    () => (flightMessages ?? []).flatMap((m) => (m.operator ? [] : [m.id])),
    [flightMessages],
  );
  const lastReply = replyIds.at(-1) ?? null;
  const [seenReply, setSeenReply] = useState<string | null | undefined>(undefined);
  // A folded dock hides its replies, so they stay unread until it is expanded.
  const looking = visible && !collapsed;
  const wasLooking = useRef(looking);
  useLayoutEffect(() => {
    if (wide && looking && !wasLooking.current) heading.current?.focus();
    if (wide && visible && collapsed && wasLooking.current) rail.current?.focus();
    wasLooking.current = looking;
  }, [wide, visible, collapsed, looking]);
  useEffect(() => {
    if (flightMessages === undefined) return;
    if (seenReply === undefined || looking) setSeenReply(lastReply);
  }, [flightMessages, seenReply, looking, lastReply]);
  const unread =
    seenReply === undefined
      ? 0
      : seenReply === null || !replyIds.includes(seenReply)
        ? replyIds.length
        : replyIds.length - 1 - replyIds.indexOf(seenReply);
  useEffect(() => {
    setFlightUnread(unread);
    return () => setFlightUnread(0);
  }, [unread]);

  return (
    <>
      {drawer && (
        <div className="dockscrim" data-testid="dock-scrim" onClick={toggle} aria-hidden="true" />
      )}
      <aside
        className={collapsed ? "dock collapsed" : "dock"}
        id="dock"
        aria-label="FLIGHT"
        hidden={!visible}
        onKeyDown={drawer ? trapTab : undefined}
      >
        <div className="panel">
          <div className="dockrail" hidden={!collapsed}>
            <button
              type="button"
              ref={rail}
              aria-label="Expand FLIGHT"
              aria-expanded="false"
              aria-controls="dockBody"
              onClick={fold}
            >
              <span className="dockrail-name">FLIGHT</span>
            </button>
          </div>
          <div className="dh" id="dockHead">
            <h2 id="dockHeading" ref={heading} tabIndex={-1}>
              <AgentTag id="FLIGHT" index="flight" showRole />
            </h2>
            <BuildChips panel="dock" />
            <span className="spacer" />
            {wide && !collapsed && (
              <button
                type="button"
                className="sm"
                aria-expanded={!collapsed}
                aria-controls="dockBody"
                title="Collapse FLIGHT to its rail"
                onClick={fold}
              >
                Collapse
              </button>
            )}
            <button
              type="button"
              className="sm"
              ref={hide}
              title="Hide FLIGHT (f)"
              onClick={() => toggleDock(false)}
            >
              Hide
            </button>
            <DockMeta flight={flight} />
          </div>
          <div className="dockbody" id="dockBody">
            <DockSummary canMessage={seat !== null} />
            <FlightThread id="dockInput" />
          </div>
        </div>
      </aside>
    </>
  );
}
