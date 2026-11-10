import type { AttentionItem, NeedsYouOffer } from "@mc/core";
import { useState } from "react";
import { ApiError, apiPost } from "../api.ts";
import { ACTIONS, hub, RESOURCES } from "../data.ts";
import { writeFailure } from "../demo/mode.ts";

const ACTION_LABEL: Record<NeedsYouOffer, string> = {
  "not-now": "Not now",
  drop: "Drop",
};

const actionPath = (offer: NeedsYouOffer, key: string): string =>
  offer === "not-now" ? ACTIONS.notNow(key) : ACTIONS.drop(key);

/** Set aside or close only the actions the server has offered for this open question. */
export function HoldItem({ item }: { item: AttentionItem }) {
  const [busy, setBusy] = useState<NeedsYouOffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const offers = item.offers ?? [];
  if (offers.length === 0) return null;
  const act = async (offer: NeedsYouOffer) => {
    setBusy(offer);
    setError(null);
    try {
      await apiPost(actionPath(offer, item.key), {});
      hub.refetch(RESOURCES.attention.path);
      hub.refetch(RESOURCES.answeredAttention.path);
    } catch (e) {
      setError(
        e instanceof ApiError && [409, 422, 502].includes(e.status)
          ? e.message
          : writeFailure(e, `Could not ${ACTION_LABEL[offer].toLowerCase()} this item.`),
      );
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="needs-actions">
      {offers.map((offer) => (
        <button
          type="button"
          className="sm"
          disabled={busy !== null}
          key={offer}
          onClick={() => void act(offer)}
        >
          {ACTION_LABEL[offer]}
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
