import { ATTENTION_LABEL, type AttentionHold, type AttentionItem } from "@mc/core";
import { useState } from "react";
import { ApiError, apiPost } from "../api.ts";
import { useSecond, useTz } from "../clock.ts";
import { NEED_TEXT_MAX, needText } from "../comms/needText.ts";
import { MarkdownInline } from "../components/Markdown.tsx";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { dayMonth, wkdTime } from "../fmt.ts";
import { Pill } from "../hud/Pill.tsx";

/** What releases a hold, in words (the Hold form's own wording for the four the operator can set). */
export function holdConditionText(
  condition: AttentionHold["condition"],
  tz: string | null,
): string {
  switch (condition.kind) {
    case "date":
      return tz === null
        ? "until a set date"
        : `until ${dayMonth(condition.at, tz)} ${wkdTime(condition.at, tz).slice(-5)}`;
    case "ticket":
      return `until ${condition.ticket} merges`;
    case "crew":
      return "until the crew resumes";
    case "manual":
      return "until you release it";
    case "ci":
      return `until ${condition.pr} CI is ${condition.state}`;
    case "item":
      return "until another item resolves";
  }
}

/**
 * Held (the Needs-you items put on hold): each with its reason, what releases it and a Release
 * button, so a held item is never invisible until its condition fires.
 */
export function HeldNeeds() {
  const held = useResource<AttentionItem[]>(RESOURCES.heldAttention).data;
  const now = useSecond();
  const tz = useTz();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (held === undefined || held.length === 0) return null;
  const release = async (key: string) => {
    setBusy(key);
    setError(null);
    try {
      await apiPost(ACTIONS.releaseHold(key), {});
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "server unreachable");
    } finally {
      hub.refetch(RESOURCES.heldAttention.path);
      hub.refetch(RESOURCES.attention.path);
      setBusy(null);
    }
  };
  return (
    <section aria-label="Held" data-testid="held-needs">
      <h3 className="pb">{`Held · ${held.length}`}</h3>
      {error && <p className="pb crit-t s">{error}</p>}
      {held.map((i) => (
        <div className="drow" key={i.key} data-testid="held-row">
          <div className="row">
            <Pill tone="plain">{ATTENTION_LABEL[i.kind]}</Pill>
            <span className="min0">
              <MarkdownInline text={needText(i, now)} max={NEED_TEXT_MAX} />
            </span>
            <span className="spacer" />
            <button
              type="button"
              className="sm"
              disabled={busy === i.key}
              onClick={() => void release(i.key)}
            >
              Release
            </button>
          </div>
          {i.hold && (
            <div className="s note">
              {i.hold.reason} · {holdConditionText(i.hold.condition, tz)}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
