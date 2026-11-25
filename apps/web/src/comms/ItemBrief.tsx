import type {
  AttentionBrief,
  AttentionItem,
  BriefOperatorReason,
  BriefOption,
  BriefReadState,
} from "@mc/core";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useSecond } from "../clock.ts";
import { Expandable } from "../components/Expandable.tsx";
import { Markdown, OpenLinks } from "../components/Markdown.tsx";
import { hub, RESOURCES } from "../data.ts";
import { hhmm } from "../fmt.ts";
import { Pill } from "../hud/Pill.tsx";
import {
  CATCH_UP_LABEL,
  catchUpTone,
  handlePerson,
  type PersonThreadView,
  postPersonReply,
  whereOf,
} from "../notifications.ts";
import { toast } from "../shell/Toast.tsx";
import "./ItemBrief.css";

export const BRIEF_LINES = 8;
export const BRIEF_FOLD_AFTER = 12;

export const WHY_OPERATOR_LABEL: Record<BriefOperatorReason, string> = {
  money: "Money",
  "product-direction": "Product direction",
  "security-exception": "Security exception",
  irreversible: "Cannot be undone",
  "floor-approval": "Floor approval",
};

export const REVERSIBILITY_LABEL = {
  reversible: "Can be undone",
  "partly-reversible": "Partly undoable",
  irreversible: "Cannot be undone",
} as const;

/** Whether the brief is fresh, and when it is not, the server's reason in plain words. */
export function FreshnessBadge({
  state,
  legacy = false,
}: {
  state?: BriefReadState;
  legacy?: boolean;
}) {
  const stale = state?.freshness === "stale";
  if (!legacy && (!state || state.freshness === "current")) return null;
  return (
    <p className="brief-fresh" role="status">
      <Pill tone={stale ? "warn" : "plain"}>{stale ? "Stale" : "Needs a refreshed brief"}</Pill>
      {state?.reason && <span className="s qtext"> {state.reason}</span>}
    </p>
  );
}

/**
 * The facts an operator needs to decide, open on every layout: why it needs them, who FLIGHT
 * consulted, what happens if nobody answers and what waiting costs. A brief with no decision
 * facts (written before they existed) shows only the refresh note; nothing is made up.
 */
export function DecisionFacts({
  brief,
  defaultDueAt,
  tz,
}: {
  brief: AttentionBrief;
  defaultDueAt?: number;
  tz: string | null;
}) {
  const decision = brief.decision;
  if (!decision) return <FreshnessBadge state={brief.state} legacy />;
  const why = decision.whyOperator;
  const effect =
    brief.binding?.actions.find((a) => a.optionId === brief.recommendedOptionId)?.effect ??
    "the recommended action";
  return (
    <section className="decision-facts" aria-label="Decision facts">
      <FreshnessBadge state={brief.state} />
      <div className="fact">
        <h3 className="bsec">Why it needs you</h3>
        <p className="s qtext">
          {why ? (
            <>
              <b>{WHY_OPERATOR_LABEL[why.kind]}.</b> {why.explanation}
            </>
          ) : (
            "Within FLIGHT's standing authority"
          )}
        </p>
      </div>
      <div className="fact">
        <h3 className="bsec">Who FLIGHT consulted</h3>
        {decision.consulted.length === 0 ? (
          <p className="s qtext">Nobody consulted</p>
        ) : (
          <ul className="checked">
            {decision.consulted.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: consultations remain in source order
              <li key={i}>
                <span className="chipref">{c.who}</span> {c.finding}
                {c.ref && <span className="chipref">{c.ref}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="fact">
        <h3 className="bsec">If nobody answers</h3>
        <p className="s qtext">
          {why ? (
            "Waits for your answer. Nothing happens automatically."
          ) : defaultDueAt !== undefined ? (
            <FYITiming dueAt={defaultDueAt} effect={effect} tz={tz} />
          ) : (
            "Nothing is scheduled to happen automatically."
          )}
          {decision.waiting && <> {decision.waiting}</>}
        </p>
      </div>
      <div className="fact">
        <h3 className="bsec">Cost of delay</h3>
        <p className="s qtext">{decision.costOfDelay}</p>
      </div>
    </section>
  );
}

/** The only second-by-second part of a brief, so a FYI clock cannot rerender its list or refetch it. */
function FYITiming({ dueAt, effect, tz }: { dueAt: number; effect: string; tz: string | null }) {
  const now = useSecond();
  const remaining = Math.max(0, Math.ceil((dueAt - now) / 1000));
  const minutes = Math.floor(remaining / 60);
  const seconds = String(remaining % 60).padStart(2, "0");
  const when = tz ? hhmm(dueAt, tz) : "soon";
  return (
    <>
      FLIGHT will {effect} at {when} unless you choose.
      <span className="fyi-countdown" aria-live="polite">
        {remaining > 0 ? ` ${minutes}:${seconds} remaining.` : " Deadline reached."}
      </span>
    </>
  );
}

function BriefSection({
  title,
  children,
  after,
  plain = false,
}: {
  title: string;
  children: ReactNode;
  after?: ReactNode;
  /** Unclamped: the Needs you page shows the whole text. */
  plain?: boolean;
}) {
  return (
    <section className="brief-section">
      <h3 className="bsec">{title}</h3>
      <div className="s qtext">
        {plain ? (
          children
        ) : (
          <Expandable lines={BRIEF_LINES} foldAfter={BRIEF_FOLD_AFTER} of={title}>
            {children}
          </Expandable>
        )}
      </div>
      {after}
    </section>
  );
}

/** The same brief for every kind of item, with source text for older items. */
export function ItemBrief({
  brief,
  original,
  links,
  afterOriginal,
  catchUp,
  viewLinks,
  approval = false,
  plain = false,
}: {
  plain?: boolean;
  brief?: AttentionBrief;
  original?: ReactNode;
  links?: ReactNode;
  afterOriginal?: ReactNode;
  catchUp?: ReactNode;
  viewLinks?: ReactNode;
  approval?: boolean;
}) {
  const ask = brief?.ask?.trim();
  // A brief with no source text has no question to show, so the heading is left out too.
  const question = original ?? (brief?.original ? <Markdown text={brief.original} /> : null);
  const body = (
    <div className="brief">
      {brief?.catchUp ? (
        <div className="ctx">
          <div className="bsec">Catch-up</div>
          <div className="ctxline">
            <Pill tone={catchUpTone(brief.catchUp.kind)}>{CATCH_UP_LABEL[brief.catchUp.kind]}</Pill>
            {brief.catchUp.line}
          </div>
          <TextList title="So far" lines={brief.catchUp.story} />
          <TextList title="Be aware" lines={brief.catchUp.aware} />
        </div>
      ) : (
        catchUp
      )}
      {question ? (
        <BriefSection
          plain={plain}
          title="The question"
          after={
            <>
              {afterOriginal}
              {links}
            </>
          }
        >
          {question}
        </BriefSection>
      ) : (
        <>
          {afterOriginal}
          {links}
        </>
      )}
      {brief && (
        <>
          <BriefSection
            plain={plain}
            title={approval ? "If you approve" : "FLIGHT's view"}
            after={
              <>
                {brief.basis && <p className="note">checked: {brief.basis}</p>}
                {viewLinks}
              </>
            }
          >
            <Markdown text={brief.assessment ?? brief.context} />
            <TextList title="FLIGHT's assessment" lines={brief.person?.assessment} />
            {brief.person && (
              <p className="s qtext">
                Here is what I know. {brief.person.take} I drafted{" "}
                {brief.person.replies?.length ?? 0} replies below: send one, edit it first, or tell
                me what you want to say.
              </p>
            )}
            {Boolean(brief.checked?.length) && (
              <>
                <div className="bsec">What FLIGHT checked</div>
                <ul className="checked">
                  {brief.checked?.map((check, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: sources remain in source order
                    <li key={i}>
                      <span className="chipref">{check.source}</span> {check.finding}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </BriefSection>
          {Boolean(brief.did?.length) && (
            <BriefSection plain={plain} title="What FLIGHT did">
              <ul className="checked">
                {brief.did?.map((step, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: actions remain in source order
                  <li key={i}>
                    <Markdown text={step.action} />
                    <span className="brief-refs">
                      {step.refs.map((ref, j) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: references remain in source order
                        <span className="chipref" key={j}>
                          {ref}
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </BriefSection>
          )}
          {ask?.trim() && (
            <BriefSection plain={plain} title="What FLIGHT needs from you">
              <Markdown text={ask} />
            </BriefSection>
          )}
        </>
      )}
    </div>
  );
  return plain ? <OpenLinks>{body}</OpenLinks> : body;
}

function TextList({ title, lines }: { title: string; lines?: string[] }) {
  if (!lines?.length) return null;
  return (
    <>
      <div className="bsec">{title}</div>
      <ul className="checked">
        {lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines remain in source order
          <li key={i}>{line}</li>
        ))}
      </ul>
    </>
  );
}

/**
 * One button per option. In the panel each is a card with its answer under the label (a plain card
 * when `live` is false); a row puts its buttons above the visible option descriptions.
 */
export function BriefOptions(p: {
  options: BriefOption[];
  recommendedOptionId?: string;
  recommendation?: string;
  primaryFirst?: boolean;
  live: boolean;
  disabled: boolean;
  title?: string;
  variant: "panel" | "row";
  rowLabel?: string;
  /** The pictures that show an option, rendered on it so choosing it is choosing them. */
  pictures?: (o: BriefOption) => ReactNode;
  /** Per option: false shuts that option while the rest stay open. */
  canPick?: (o: BriefOption) => boolean;
  onPick: (o: BriefOption) => void;
}) {
  const labelId = useId();
  if (p.options.length === 0) return null;
  if (p.variant === "row") {
    return (
      <>
        {p.recommendation && <Recommendation text={p.recommendation} />}
        {/* biome-ignore lint/a11y/useSemanticElements: group labels action buttons, not form fields */}
        <div role="group" aria-labelledby={p.rowLabel ? labelId : undefined}>
          {p.rowLabel && (
            <span className="bsec" id={labelId}>
              {p.rowLabel}
            </span>
          )}
          <div className="nopts">
            {p.options.map((o, i) => (
              <button
                type="button"
                className={p.primaryFirst && i === 0 ? "sm primary" : "sm"}
                // Labels can repeat, so the text is no key; the list never reorders.
                // biome-ignore lint/suspicious/noArrayIndexKey: position is the only id, see above
                key={i}
                title={p.title}
                disabled={p.disabled || !p.live || p.canPick?.(o) === false}
                onClick={() => p.onPick(o)}
              >
                {o.label}
              </button>
            ))}
          </div>
          <div className="optlist">
            {p.options.map((o, i) => (
              <OptionCard
                {...p}
                key={o.id ?? i}
                option={o}
                of={`${o.label}, option ${i + 1}`}
                recommended={o.id !== undefined && o.id === p.recommendedOptionId}
                recommendation={undefined}
                live={false}
                hideLabel
              />
            ))}
          </div>
          {(p.disabled || !p.live) && p.title && <p className="note">{p.title}</p>}
        </div>
      </>
    );
  }
  return (
    <div className="optlist">
      {p.recommendation &&
        !p.options.some((o) => o.id !== undefined && o.id === p.recommendedOptionId) && (
          <Recommendation text={p.recommendation} />
        )}
      {p.options.map((o, i) => (
        // Labels can repeat, so the text is no key; the list never reorders.
        <OptionCard
          key={o.id ?? i}
          option={o}
          of={`${o.label}, option ${i + 1}`}
          recommended={o.id !== undefined && o.id === p.recommendedOptionId}
          {...p}
          disabled={p.disabled || p.canPick?.(o) === false}
        />
      ))}
      {(p.disabled || !p.live) && p.title && <p className="note">{p.title}</p>}
    </div>
  );
}

function OptionCard(p: {
  hideLabel?: boolean;
  option: BriefOption;
  of: string;
  recommended: boolean;
  recommendation?: string;
  live: boolean;
  disabled: boolean;
  title?: string;
  pictures?: (o: BriefOption) => ReactNode;
  onPick: (o: BriefOption) => void;
}) {
  const label = (
    <b className="qtext" aria-hidden={p.hideLabel || undefined}>
      {p.option.label}
    </b>
  );
  const { consequence, reversibility } = p.option;
  return (
    <div className={p.recommended ? "opt rec" : "opt"}>
      <div className="opt-head">
        {p.live ? (
          <button
            type="button"
            className="option-pick"
            aria-label={p.option.label}
            title={p.title}
            disabled={p.disabled}
            onClick={() => p.onPick(p.option)}
          >
            {label}
          </button>
        ) : (
          label
        )}
        {p.recommended &&
          !(
            p.recommendation?.trim() &&
            p.recommendation.trim() !== (p.option.description ?? p.option.answer).trim()
          ) && <Pill tone="plain">FLIGHT recommends</Pill>}
      </div>
      <div className="opt-body">
        <Expandable lines={BRIEF_LINES} foldAfter={BRIEF_FOLD_AFTER} of={p.of}>
          <span className="xs fg2">{p.option.description ?? p.option.answer}</span>
        </Expandable>
        {consequence && (
          <p className="s qtext opt-consequence">
            <span className="bsec">Consequence</span> {consequence}
          </p>
        )}
        {p.pictures?.(p.option)}
        {p.recommended &&
          p.recommendation?.trim() &&
          p.recommendation.trim() !== (p.option.description ?? p.option.answer).trim() && (
            <Recommendation text={p.recommendation} of={`Recommendation, ${p.of}`} />
          )}
      </div>
      {reversibility && (
        <p className="s qtext opt-rev">
          <b>{REVERSIBILITY_LABEL[reversibility.kind]}.</b> {reversibility.detail}
        </p>
      )}
    </div>
  );
}

export function Recommendation({ text, of = "Recommendation" }: { text: string; of?: string }) {
  if (!text.trim()) return null;
  return (
    <div className="recommendation">
      <Pill tone="plain">FLIGHT recommends</Pill>
      <Expandable lines={BRIEF_LINES} foldAfter={BRIEF_FOLD_AFTER} of={of}>
        <Markdown text={text} />
      </Expandable>
    </div>
  );
}

export function PersonChoices({
  item,
  thread,
}: {
  item: AttentionItem;
  thread?: PersonThreadView;
}) {
  const person = item.brief?.person;
  const [done, setDone] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);
  useEffect(() => {
    if (!done) return;
    hub.refetch(RESOURCES.attention.path);
    hub.refetch(RESOURCES.notifications.path);
  }, [done]);
  if (!person) return null;
  const run = async (action: () => Promise<void>) => {
    if (lock.current || done) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "server unreachable");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const handled = async (how: "marked" | "copied" | "flight", replyId?: string) => {
    const result = await handlePerson(item.key, how, replyId);
    setDone(
      how === "marked"
        ? "marked handled"
        : how === "copied"
          ? "reply copied for Teams"
          : "with FLIGHT",
    );
    setMessage(result.message ?? "");
  };
  const edit = (id: string, value: string) => {
    setEditing(id);
    setDrafts((previous) => ({ ...previous, [id]: previous[id] ?? value }));
  };
  return (
    <div className="composer person-choices">
      {done ? (
        <p>
          Handled: <b>{done}</b>
        </p>
      ) : (
        <>
          <div className="bsec">Suggested replies</div>
          {!person.replies?.length && <p className="note">No suggested replies yet.</p>}
          <div className="optlist">
            {person.replies?.map((reply, i) => (
              <div className={i === 0 ? "opt rec" : "opt"} key={reply.id}>
                <span className="row">
                  <b>{reply.label}</b>
                  {i === 0 && <Pill tone="plain">FLIGHT suggests</Pill>}
                </span>
                {editing === reply.id ? (
                  <textarea
                    ref={input}
                    aria-label="Suggested reply"
                    value={drafts[reply.id] ?? reply.text}
                    onChange={(e) =>
                      setDrafts((previous) => ({ ...previous, [reply.id]: e.target.value }))
                    }
                    disabled={busy}
                  />
                ) : (
                  <Expandable lines={BRIEF_LINES} foldAfter={BRIEF_FOLD_AFTER}>
                    <span className="s qtext">{drafts[reply.id] ?? reply.text}</span>
                  </Expandable>
                )}
                <span className="row">
                  <button
                    type="button"
                    className="sm primary"
                    disabled={busy || !(drafts[reply.id] ?? reply.text).trim()}
                    onClick={() =>
                      void run(async () => {
                        const body = drafts[reply.id] ?? reply.text;
                        if (person.source.kind === "github") {
                          await postPersonReply(item.key, reply.id, body);
                          setDone("replied on GitHub");
                          toast(
                            `Posted on ${thread ? whereOf(thread).replace(/^GitHub · /, "") : "GitHub"} as you. Clicking Post was your approval.`,
                          );
                        } else {
                          try {
                            await navigator.clipboard.writeText(body);
                          } catch {
                            edit(reply.id, body);
                            toast("Copy was blocked here; select the reply and copy it.");
                            input.current?.focus();
                            input.current?.select();
                            return;
                          }
                          toast(
                            "Reply copied. Paste it into Teams; Open in Teams takes you to the message.",
                          );
                          await handled("copied", reply.id);
                        }
                      })
                    }
                  >
                    {person.source.kind === "github" ? "Post on GitHub" : "Copy for Teams"}
                  </button>
                  <button
                    type="button"
                    className="sm ghost"
                    disabled={busy}
                    onClick={() => {
                      edit(reply.id, reply.text);
                      toast("Opens the reply so you can change it before sending.");
                    }}
                  >
                    Edit first
                  </button>
                </span>
              </div>
            ))}
          </div>
          <div className="row">
            <button type="button" disabled={busy} onClick={() => void run(() => handled("marked"))}>
              Mark handled
            </button>
            <button type="button" disabled={busy} onClick={() => void run(() => handled("flight"))}>
              Let FLIGHT handle it
            </button>
          </div>
        </>
      )}
      {message && <p className="s qtext">{message}</p>}
      {error && (
        <p className="note err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
