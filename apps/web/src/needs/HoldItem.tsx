import type { AttentionHoldCondition } from "@mc/core";
import { useState } from "react";
import { apiPost } from "../api.ts";
import { HoldForm } from "../comms/HoldForm.tsx";
import { ACTIONS, hub, RESOURCES } from "../data.ts";
import { writeFailure } from "../demo/mode.ts";

/**
 * Put the open item on hold with a reason and a release condition (the Hold action Comms' decision
 * rows had before the item moved to this page). The server decides who may hold what.
 */
export function HoldItem({ itemKey }: { itemKey: string }) {
  const [holding, setHolding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hold = async (reason: string, condition: AttentionHoldCondition) => {
    setBusy(true);
    setError(null);
    try {
      await apiPost(ACTIONS.hold(itemKey), { reason, condition });
      setHolding(false);
      hub.refetch(RESOURCES.attention.path);
      hub.refetch(RESOURCES.heldAttention.path);
    } catch (e) {
      setError(writeFailure(e, "Could not hold this item."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="needs-hold">
      <button
        type="button"
        className="sm"
        disabled={busy || holding}
        onClick={() => setHolding(true)}
      >
        Hold
      </button>
      {error && (
        <p className="note err" role="alert">
          {error}
        </p>
      )}
      {holding && (
        <HoldForm
          busy={busy}
          onCancel={() => setHolding(false)}
          onHold={(r, c) => void hold(r, c)}
        />
      )}
    </div>
  );
}
