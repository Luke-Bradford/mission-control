import { type CrewRow, FLIGHT_NOT_RUNNING } from "@mc/core";
import { seatStatus } from "../crew.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";
import { agentPath, followLink } from "../router.ts";
import { useDock } from "../shell/overlays.ts";

export const FLIGHT_IN_DOCK = "FLIGHT's chat is in the dock.";

/** Comms › Conversation (catalogue 2.5.3): the selected thread. Both are placeholders until phases 2 and 3. */
export function Conversation({ row }: { row: CrewRow | null }) {
  const dock = useDock().visible;
  if (row === null) {
    return (
      <Panel
        id="chatP"
        title="FLIGHT"
        sub="decisions and questions come to you here, tagged @CAPCOM"
      >
        <p className="pb note">{dock ? FLIGHT_IN_DOCK : FLIGHT_NOT_RUNNING}</p>
      </Panel>
    );
  }
  return (
    <Panel
      id="chatP"
      sub={`everything ${row.id} sent or received: you, FLIGHT and other agents`}
      title={
        <>
          Thread · <AgentTag id={row.id} index={row.index} sm /> ·{" "}
          <Pill tone={seatStatus(row).tone}>{seatStatus(row).label}</Pill>
        </>
      }
      actions={
        <a href={agentPath(row.id)} onClick={(e) => followLink(e, agentPath(row.id))}>
          See its activity
        </a>
      }
    >
      <p className="pb note">Threads arrive with the mailbox (phase 2).</p>
    </Panel>
  );
}
