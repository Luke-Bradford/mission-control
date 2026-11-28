import type { MachineView } from "@mc/core";
import { RESOURCES, useResource } from "../data.ts";
import { swapOfRam } from "../fmt.ts";
import { Pill } from "../hud/Pill.tsx";
import { DASH } from "./common.ts";

const GIB = 2 ** 30;
const gb = (bytes: number | null | undefined): string =>
  bytes == null ? DASH : String(Math.round((bytes / GIB) * 10) / 10);

/** The latest swap and disk reading beside the load chart, and the reason while the hub holds new work. */
export function MachineReadout() {
  const view = useResource<MachineView>(RESOURCES.machine).data;
  const m = view?.latest ?? null;
  const leftovers = view?.leftovers;
  return (
    <div className="s machine-readout">
      <span className="num">Swap {swapOfRam(m?.swapUsedBytes, m?.memTotalBytes)}</span>{" "}
      <span className="num">
        Disk {gb(m?.diskFreeBytes)} <span className="muted">GB free</span>
      </span>
      {view?.warning && (
        <>
          {" "}
          <Pill tone="warn" title={view.warning}>
            Holding new work
          </Pill>{" "}
          <span className="muted">{view.warning}</span>
        </>
      )}
      {leftovers && (
        <div className="machine-cleanup-footprint" data-testid="cleanup-footprint">
          <span className="muted">Cleanup stores · </span>
          <span>Claude projects {gb(leftovers.claudeProjectsBytes)} GB · </span>
          <span>Codex sessions {gb(leftovers.codexSessionsBytes)} GB · </span>
          <span>Browser profiles {gb(leftovers.browserProfilesBytes)} GB · </span>
          <span>Chrome temp {gb(leftovers.chromeTempBytes)} GB · </span>
          <span>Seat worktrees {gb(leftovers.worktreesBytes)} GB · </span>
          <span>Preview clones {gb(leftovers.previewsBytes)} GB</span>
        </div>
      )}
    </div>
  );
}
