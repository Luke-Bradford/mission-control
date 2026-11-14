import type { AttentionItem, BriefOption, FlightView } from "@mc/core";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useSecond } from "../clock.ts";
import { Markdown } from "../components/Markdown.tsx";
import { RESOURCES, streamStatus, useResource } from "../data.ts";
import { mss } from "../fmt.ts";
import { Pill } from "../hud/Pill.tsx";
import { useStore } from "../shell/store.ts";
import {
  type Availability,
  type ChoiceInput,
  choiceAvailability,
  dismissAttempt,
  inputFormOf,
  preparedFor,
  REFRESH_NEEDED,
  receiptLine,
  submitChoice,
  useChoiceAttempt,
} from "./briefChoice.ts";
import { clearDraft, getDraft, setDraft } from "./drafts.ts";
import { ItemDiscussion } from "./ItemDiscussion.tsx";
import "./BriefChoice.css";

const REVERSIBILITY_WORDS = {
  reversible: "Reversible",
  "partly-reversible": "Partly reversible",
  irreversible: "Not reversible",
} as const;

/** The server's FYI deadline, counting down. Only this child re-renders each second. */
function FyiCountdown({ dueAt, effect }: { dueAt: number; effect: string | undefined }) {
  const now = useSecond();
  const left = Math.max(0, Math.ceil((dueAt - now) / 1000));
  return (
    <p className="bc-timing" data-testid="fyi-countdown">
      <Pill tone="warn">FYI</Pill> {effect ? `Planned: ${effect}. ` : ""}Applies on its own in{" "}
      <b>{mss(left * 1000)}</b> unless you choose first.
    </p>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="bc-field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * One complete operator decision: every required field, the option comparison, the bound Accept
 * and an inline Discuss. Used on Needs you, in Comms and in the item panel.
 */
export function BriefChoice({
  item,
  heading,
  pictures,
}: {
  item: AttentionItem;
  heading?: ReactNode;
  /** Pictures attached to an option, when the page has loaded its materials. */
  pictures?: (option: BriefOption) => ReactNode;
}) {
  const brief = item.brief;
  const stream = useStore(streamStatus);
  const attention = useResource<AttentionItem[]>(RESOURCES.attention);
  const flight = useResource<FlightView>(RESOURCES.flight).data;
  const recorded = useChoiceAttempt(item.key);
  // A result belongs to the brief revision it was sent for; a rebrief starts clean.
  const attempt =
    recorded?.briefId === brief?.id && recorded?.sourceRevision === brief?.binding?.sourceRevision
      ? recorded
      : undefined;
  const [discussing, setDiscussing] = useState(false);
  const [, bump] = useState(0);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const errorRef = useRef<HTMLDivElement>(null);
  const headId = useId();
  const discussOpener = useRef<HTMLButtonElement>(null);
  const gone = attention.data !== undefined && !attention.data.some((i) => i.key === item.key);
  const refreshFailed = attention.error !== null;
  const disconnected = !stream.connected && stream.reconnecting;
  const failed = attempt?.status === "error" && attempt.error !== undefined;
  useEffect(() => {
    if (failed) errorRef.current?.focus();
  }, [failed]);
  if (!brief) return null;
  const options = brief.options;
  const decision = brief.decision;
  const recommended: BriefOption | undefined = options.find(
    (o) => o.id !== undefined && o.id === brief.recommendedOptionId,
  );
  const sending = attempt?.status === "sending";
  const settled = attempt?.status === "receipt" ? attempt.receipt : undefined;
  const receipt = settled ?? brief.choice;
  const availability = (id: string | undefined): Availability => {
    const base = choiceAvailability(item, id, { connected: !disconnected, gone });
    if (base.ok && refreshFailed)
      return { ok: false, reason: "The latest state could not be loaded, so nothing is sent." };
    if (base.ok && sending) return { ok: false, reason: "Sending." };
    if (
      base.ok &&
      attempt?.status === "receipt" &&
      attempt.receipt &&
      attempt.receipt.state !== "refused" &&
      attempt.receipt.state !== "stale"
    )
      return { ok: false, reason: "This choice already has a result below." };
    return base;
  };
  const activeId = picked ?? recommended?.id;
  const active = options.find((o) => o.id === activeId) ?? recommended;
  const prepared = preparedFor(item, active?.id);
  const form = inputFormOf(prepared);
  const draftKey = `${item.key}\u0000${active?.id ?? ""}`;
  const typed = form ? getDraft("choice", draftKey) : "";
  const value = form ? (typed === "" && !touched(draftKey) ? form.initial : typed) : "";
  // Unedited server text is not an input: the bound action already carries it.
  const input: ChoiceInput | undefined =
    form && value !== form.initial && value !== "" ? { [form.field]: value } : undefined;
  const block = availability(active?.id);
  const formMissing = form?.field === "text" && value.trim() === "";
  const legacy = !brief.binding || !brief.state;
  const freshness = legacy
    ? REFRESH_NEEDED
    : brief.state?.freshness === "current"
      ? "Current"
      : brief.state?.freshness === "stale"
        ? "Source changed"
        : "Freshness unknown";
  const dueAt = decision?.whyOperator ? undefined : item.defaultDueAt;
  const accept = () => {
    if (!active?.id || !block.ok || formMissing) return;
    void submitChoice(item, active.id, input);
  };
  const operatorWait = decision?.waiting ?? (decision ? "Waits for your choice." : undefined);
  return (
    <div className="bc-box">
      <section className="bc" aria-labelledby={headId} data-testid="brief-choice">
        {heading}
        <h3 id={headId} className="bc-question">
          {brief.ask?.trim() || item.text}
        </h3>
        <p className="bc-fresh">
          <Pill tone={brief.state?.freshness === "current" ? "ok" : "warn"}>{freshness}</Pill>
          {brief.state?.reason && <span className="s"> {brief.state.reason}</span>}
          {legacy && (
            <span className="s">
              {" "}
              Content is shown as it was written; it cannot be chosen from until it is refreshed.
            </span>
          )}
        </p>
        <dl className="bc-fields">
          <Field label="Why you">
            {decision?.whyOperator ? (
              <>
                <b>{decision.whyOperator.kind}</b>: {decision.whyOperator.explanation}
              </>
            ) : (
              "Not stated in this brief."
            )}
          </Field>
          <Field label="Context">
            <Markdown text={brief.assessment ?? brief.context} />
          </Field>
          <Field label="Consulted">
            {decision ? (
              decision.consulted.length === 0 ? (
                "Nobody consulted"
              ) : (
                <ul className="bc-list">
                  {decision.consulted.map((c, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: consultations keep source order
                    <li key={i}>
                      <b>{c.who}</b>: {c.finding}
                      {c.ref && <span className="chipref"> {c.ref}</span>}
                    </li>
                  ))}
                </ul>
              )
            ) : (
              "Not stated in this brief."
            )}
          </Field>
          <Field label="Cost of delay">{decision?.costOfDelay || "Unknown"}</Field>
          <Field label="If you do not answer">
            {dueAt !== undefined ? (
              <FyiCountdown
                dueAt={dueAt}
                effect={preparedFor(item, brief.recommendedOptionId)?.effect}
              />
            ) : (
              (operatorWait ?? "Not stated in this brief.")
            )}
          </Field>
        </dl>
        <h4 className="bsec" id={`${headId}-opts`}>
          Options
        </h4>
        {options.length === 0 ? (
          <p className="note">This brief lists no options.</p>
        ) : (
          <ul className="bc-options" aria-labelledby={`${headId}-opts`}>
            {options.map((o, i) => {
              const isRec = o.id !== undefined && o.id === brief.recommendedOptionId;
              const isActive = active === o;
              return (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: duplicate labels are legal; position is the identity
                  key={i}
                  className={`bc-option${isRec ? " rec" : ""}${isActive ? " active" : ""}`}
                >
                  <div className="bc-id">
                    <label>
                      <input
                        type="radio"
                        name={`${headId}-pick`}
                        checked={isActive}
                        disabled={options.length < 2}
                        onChange={() => setPicked(o.id)}
                      />{" "}
                      <b>{o.label}</b>
                    </label>
                    {o.id && <code className="bc-oid">{o.id}</code>}
                    {isRec && <Pill tone="ok">Recommended</Pill>}
                  </div>
                  <div className="bc-cons" data-label="Consequence">
                    {o.consequence ?? o.description ?? o.answer}
                    {pictures?.(o)}
                  </div>
                  <div className="bc-rev" data-label="Reversibility">
                    {o.reversibility ? (
                      <>
                        <b>{REVERSIBILITY_WORDS[o.reversibility.kind]}</b>. {o.reversibility.detail}
                      </>
                    ) : (
                      "Not stated."
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {brief.recommendation.trim() && (
          <div className="bc-rec">
            <Pill tone="plain">FLIGHT recommends</Pill>
            <Markdown text={brief.recommendation} />
          </div>
        )}
        {form && active && (
          <label className="bc-input">
            <span className="bsec">{form.label}</span>
            <textarea
              rows={3}
              value={value}
              disabled={sending}
              onChange={(e) => {
                touch(draftKey);
                setDraft("choice", draftKey, e.target.value);
                bump((n) => n + 1);
              }}
            />
          </label>
        )}
        <div className="bc-actions">
          <button
            type="button"
            className="primary"
            disabled={!block.ok || formMissing || !active?.id}
            aria-describedby={block.ok ? undefined : `${headId}-why`}
            onClick={accept}
          >
            {active
              ? `${active.id === brief.recommendedOptionId ? "Accept recommendation" : "Choose"}: ${active.label}${prepared ? ` — ${prepared.effect}` : ""}`
              : "Accept recommendation"}
          </button>
          <button
            type="button"
            ref={discussOpener}
            aria-expanded={discussing}
            onClick={() => {
              if (discussing) discussOpener.current?.focus();
              setDiscussing(!discussing);
            }}
          >
            {discussing ? "Close discussion" : "Discuss"}
          </button>
        </div>
        {!block.ok && (
          <p className="note" id={`${headId}-why`} data-testid="choice-blocked">
            {block.reason}
          </p>
        )}
        {sending && (
          <p className="note" role="status">
            Sending your choice…
          </p>
        )}
        {failed && attempt && (
          <div className="bc-error" role="alert" tabIndex={-1} ref={errorRef}>
            <b>Not sent.</b> {attempt.error}{" "}
            <span>
              Your choice and input are kept; pressing the button again retries this same request.
            </span>{" "}
            <button
              type="button"
              className="sm ghost"
              onClick={() => {
                dismissAttempt(item.key);
                setPicked(attempt.optionId);
              }}
            >
              Change the choice
            </button>
          </div>
        )}
        {receipt && (
          <p className="bc-receipt" role="status" data-testid="choice-receipt">
            <Pill tone={receipt.state === "applied" ? "ok" : "warn"}>{receipt.state}</Pill>{" "}
            {receiptLine(receipt)}
          </p>
        )}
        {discussing && (
          <ItemDiscussion
            layout="panel"
            itemKey={item.key}
            live={flight === undefined ? undefined : flight.seat?.live === true}
            seat={flight === undefined ? undefined : flight.seat}
            focus
          />
        )}
      </section>
    </div>
  );
}

// Which drafts the operator has edited, so clearing a field does not restore the server text.
const edited = new Set<string>();
const touched = (k: string) => edited.has(k);
const touch = (k: string) => edited.add(k);
export const forgetChoiceDraft = (k: string) => {
  edited.delete(k);
  clearDraft("choice", k);
};
