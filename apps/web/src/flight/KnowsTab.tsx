import { Panel } from "../hud/Panel.tsx";
import { GlobalOrdersPanel, SeatInstructionIndexPanel } from "../instructions/Instructions.tsx";
import { BriefPanel } from "./Brief.tsx";
import { MemoryPanel } from "./Memory.tsx";

/** What FLIGHT knows: the orders it works under, then repo memory, then its dated working context. */
export function KnowsTab() {
  return (
    <>
      <div className="flight-knows-orders">
        <GlobalOrdersPanel />
        <Panel
          id="instructionsP"
          title="Seat instructions"
          sub="what each seat has been told to keep"
        >
          <SeatInstructionIndexPanel />
        </Panel>
      </div>
      <MemoryPanel expanded />
      <BriefPanel />
    </>
  );
}
