import type { MachineView } from "@mc/core";
import { RESOURCES, useResource } from "../data.ts";
import { Pill } from "../hud/Pill.tsx";
import { DASH } from "./common.ts";

const GIB = 2 ** 30;
const gb = (bytes: number | null | undefined): string =>
  bytes == null ? DASH : String(Math.round((bytes / GIB) * 10) / 10);

/** The latest swap and disk reading beside the load chart, and the reason while the hub holds new work. */
export function MachineReadout() {
  const view = useResource<MachineView>(RESOURCES.machine).data;
  const m = view?.latest ?? null;
  return (
    <div className="s machine-readout">
      <span className="num">
        Swap {gb(m?.swapUsedBytes)} <span className="muted">of {gb(m?.swapTotalBytes)} GB</span>
      </span>{" "}
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
    </div>
  );
}
