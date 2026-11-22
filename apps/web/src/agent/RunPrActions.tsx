import { useState } from "react";
import { apiPost } from "../api.ts";
import { ACTIONS } from "../data.ts";

export function RunPrActions({ runId, sha }: { runId: string; sha: string }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const post = async (path: string, body: unknown) => {
    try {
      await apiPost(path, body);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="vhold">
      <label>
        Merge hold reason <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <button
        type="button"
        onClick={() => void post(ACTIONS.runMergeHold(runId), { action: "hold", reason })}
      >
        Hold merge
      </button>
      <button
        type="button"
        onClick={() => void post(ACTIONS.runMergeHold(runId), { action: "release" })}
      >
        Release hold
      </button>
      <button
        type="button"
        onClick={() => void post(ACTIONS.runControllerCheck(runId), { verdict: "pass", sha })}
      >
        Pass controller check
      </button>
      <button
        type="button"
        disabled={!reason}
        onClick={() =>
          void post(ACTIONS.runControllerCheck(runId), { verdict: "fail", sha, note: reason })
        }
      >
        Fail controller check
      </button>
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
