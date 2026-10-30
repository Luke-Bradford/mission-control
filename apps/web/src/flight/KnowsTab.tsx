import { Panel } from "../hud/Panel.tsx";
import { BriefPanel } from "./Brief.tsx";
import { MemoryPanel } from "./Memory.tsx";

export const STANDING_ORDERS_PENDING =
  "Standing orders: not available yet. The hub does not store operator orders for FLIGHT.";
export const SEAT_INSTRUCTIONS_PENDING =
  "Per-seat instructions: not available yet. The hub does not store instructions per seat.";

/** What FLIGHT knows: the orders it works under, then repo memory, then its dated working context. */
export function KnowsTab() {
  return (
    <>
      <div className="flight-knows-orders">
        <Panel id="ordersP" title="Standing orders" sub="yours, for FLIGHT">
          <p className="pb note">{STANDING_ORDERS_PENDING}</p>
        </Panel>
        <Panel
          id="instructionsP"
          title="Seat instructions"
          sub="what each seat has been told to keep"
        >
          <p className="pb note">{SEAT_INSTRUCTIONS_PENDING}</p>
        </Panel>
      </div>
      <MemoryPanel expanded />
      <BriefPanel />
    </>
  );
}
