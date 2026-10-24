import type { AttentionBrief, AttentionItem, BriefOption } from "@mc/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Expandable } from "../components/Expandable.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { hub, RESOURCES } from "../data.ts";
import { handlePerson, type PersonThreadView, postPersonReply, whereOf } from "../notifications.ts";
import { toast } from "../shell/Toast.tsx";

export const BRIEF_LINES = 8;
export const BRIEF_FOLD_AFTER = 12;

function BriefSection({
  title,
  children,
  after,
}: {
  title: string;
  children: ReactNode;
  after?: ReactNode;
}) {
  return (
    <section className="brief-section">
      <h3 className="bsec">{title}</h3>
      <div className="s qtext">
        <Expandable lines={BRIEF_LINES} foldAfter={BRIEF_FOLD_AFTER} of={title}>
          {children}
        </Expandable>
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
}: {
  brief?: AttentionBrief;
  original?: ReactNode;
  links?: ReactNode;
  afterOriginal?: ReactNode;
  catchUp?: ReactNode;
  viewLinks?: ReactNode;
}) {
  const ask = brief?.ask?.trim() || brief?.recommendation;
  return (
    <div className="brief">
      {brief?.catchUp ? (
        <div className="ctx">
          <div className="bsec">Catch-up</div>
          <div className="ctxline">
            <span className={`pill ${brief.catchUp.kind === "new" ? "plain" : "warn"}`}>
              {brief.catchUp.kind === "new"
                ? "New"
                : brief.catchUp.kind === "old"
                  ? "Old thread"
                  : "Follow-up"}
            </span>
            {brief.catchUp.line}
          </div>
          <TextList title="So far" lines={brief.catchUp.story} />
          <TextList title="Be aware" lines={brief.catchUp.aware} />
        </div>
      ) : (
        (catchUp ??
        (brief && (
          <div className="ctx">
            <div className="bsec">Catch-up</div>
            <div className="bsec">So far</div>
            <p className="note">Catch-up unavailable.</p>
            <div className="bsec">Be aware</div>
            <p className="note">Awareness unavailable.</p>
          </div>
        )))
      )}
      <BriefSection
        title="The question"
        after={
          <>
            {afterOriginal}
            {links}
          </>
        }
      >
        {original ?? (brief?.original && <Markdown text={brief.original} />)}
      </BriefSection>
      {brief && (
        <>
          <BriefSection
            title="FLIGHT's view"
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
            <BriefSection title="What FLIGHT did">
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
            <BriefSection title="What FLIGHT needs from you">
              <Markdown text={ask} />
            </BriefSection>
          )}
        </>
      )}
    </div>
  );
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
 * when `live` is false); in a row it is a small button with the answer as its title.
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
  onPick: (o: BriefOption) => void;
}) {
  if (p.options.length === 0) return null;
  if (p.variant === "row") {
    return (
      <div className="nopts">
        {p.options.map((o, i) => (
          <button
            type="button"
            className={p.primaryFirst && i === 0 ? "sm primary" : "sm"}
            // Labels can repeat, so the text is no key; the list never reorders.
            // biome-ignore lint/suspicious/noArrayIndexKey: position is the only id, see above
            key={i}
            title={p.title ?? o.answer}
            disabled={p.disabled}
            onClick={() => p.onPick(o)}
          >
            {o.label}
          </button>
        ))}
      </div>
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
          recommended={o.id !== undefined && o.id === p.recommendedOptionId}
          {...p}
        />
      ))}
    </div>
  );
}

function OptionCard(p: {
  option: BriefOption;
  recommended: boolean;
  recommendation?: string;
  live: boolean;
  disabled: boolean;
  title?: string;
  onPick: (o: BriefOption) => void;
}) {
  const label = <b className="qtext">{p.option.label}</b>;
  return (
    <div className={p.recommended ? "opt rec" : "opt"}>
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
      <Expandable lines={BRIEF_LINES} foldAfter={BRIEF_FOLD_AFTER}>
        <span className="xs fg2">{p.option.description ?? p.option.answer}</span>
      </Expandable>
      {p.recommended &&
        (p.recommendation?.trim() &&
        p.recommendation.trim() !== (p.option.description ?? p.option.answer).trim() ? (
          <Recommendation text={p.recommendation} />
        ) : (
          <span className="pill plain">FLIGHT recommends</span>
        ))}
    </div>
  );
}

export function Recommendation({ text }: { text: string }) {
  if (!text.trim()) return null;
  return (
    <div className="recommendation">
      <span className="pill plain">FLIGHT recommends</span>
      <Expandable lines={BRIEF_LINES} foldAfter={BRIEF_FOLD_AFTER}>
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
                  {i === 0 && <span className="pill plain">FLIGHT suggests</span>}
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
