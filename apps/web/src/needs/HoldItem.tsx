import type { AttentionItem, NeedsYouOffer } from "@mc/core";
import { useState } from "react";
import { ApiError, apiPost } from "../api.ts";
import { ACTIONS, hub, RESOURCES } from "../data.ts";
import { writeFailure } from "../demo/mode.ts";

const ACTION_LABEL: Record<NeedsYouOffer, string> = {
  "not-now": "Not now",
  drop: "Drop",
};

type AttentionAction = NeedsYouOffer | "clear";

const actionPath = (offer: NeedsYouOffer, key: string): string =>
  offer === "not-now" ? ACTIONS.notNow(key) : ACTIONS.drop(key);

const pathFor = (action: AttentionAction, key: string): string =>
  action === "clear" ? ACTIONS.clear(key) : actionPath(action, key);

const labelFor = (action: AttentionAction): string =>
  action === "clear" ? "Clear" : ACTION_LABEL[action];

/** Set aside or close only the actions the server has offered for this open question. */
export function HoldItem({ item }: { item: AttentionItem }) {
  const [busy, setBusy] = useState<AttentionAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const offers = item.offers ?? [];
  const actions: readonly AttentionAction[] = [...offers, "clear"];
  const act = async (action: AttentionAction) => {
    setBusy(action);
    setError(null);
    try {
      await apiPost(pathFor(action, item.key), {});
      hub.refetch(RESOURCES.attention.path);
      hub.refetch(RESOURCES.answeredAttention.path);
    } catch (e) {
      setError(
        e instanceof ApiError && [404, 409, 422, 502].includes(e.status)
          ? e.message
          : writeFailure(e, `Could not ${labelFor(action).toLowerCase()} this item.`),
      );
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="needs-actions">
      {actions.map((action) => (
        <button
          type="button"
          className="sm"
          disabled={busy !== null}
          key={action}
          onClick={() => void act(action)}
        >
          {labelFor(action)}
        </button>
      ))}
      {error && (
        <p className="note err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
