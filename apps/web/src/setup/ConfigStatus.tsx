import type { CrewChanges } from "@mc/core";
import { useState } from "react";
import { apiPost } from "../api.ts";
import { ACTIONS, RESOURCES, useResource } from "../data.ts";
import { toast } from "../shell/Toast.tsx";

export function ConfigStatus() {
  const { data } = useResource<CrewChanges>(RESOURCES.crewChanges);
  const [busy, setBusy] = useState(false);
  const restart = async () => {
    if (!window.confirm("Restart the hub now? Crew runs resume after the restart.")) return;
    setBusy(true);
    try {
      await apiPost(ACTIONS.restartHub, {});
      toast("Restarting… the HUD reconnects when the hub is back.");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <div className="setup-config-status" role={data?.error ? "alert" : undefined}>
      {data?.error && (
        <span className="crit-t">
          {data.error.startsWith("config.yaml does not load:")
            ? data.error
            : `config.yaml does not load: ${data.error}. The hub runs on the last good copy.`}
        </span>
      )}
      {data?.restartNeeded?.length ? (
        <span>Restart needed: {data.restartNeeded.join(", ")}.</span>
      ) : (
        <span className="muted">Configuration is current.</span>
      )}
      <button type="button" className="sm" disabled={busy} onClick={() => void restart()}>
        {busy ? "Restarting…" : "Restart hub"}
      </button>
    </div>
  );
}
