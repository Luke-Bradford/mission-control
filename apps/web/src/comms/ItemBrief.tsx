import type { AttentionBrief, AttentionItem, BriefOption } from "@mc/core";
import { useEffect, useRef, useState } from "react";
import { ExternalLink } from "../components/ExternalLink.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { hub, RESOURCES } from "../data.ts";
import { rel } from "../fmt.ts";
import { Pill } from "../hud/Pill.tsx";
import {
  CATCH_UP_LABEL,
  handlePerson,
  type PersonThreadView,
  postPersonReply,
  whereOf,
} from "../notifications.ts";
import { openItem } from "../shell/overlays.ts";
import { toast } from "../shell/Toast.tsx";

/** FLIGHT's brief on an item: what it is and what FLIGHT recommends (all inert text). */
export function ItemBrief({ brief }: { brief: AttentionBrief }) {
  return (
    <div className="brief">
      <div className="bsec">FLIGHT's brief</div>
      <div className="s qtext">
        <Markdown text={brief.context} />
      </div>
      <div className="bsec">FLIGHT recommends</div>
      <div className="s qtext">
        <Markdown text={brief.recommendation} />
      </div>
    </div>
  );
}

/**
 * One button per option. In the panel each is a card with its answer under the label (a plain card
 * when `live` is false); in a row it is a small button with the answer as its title.
 */
export function BriefOptions(p: {
  options: BriefOption[];
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
            className="sm"
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
      {p.options.map((o, i) => (
        // Labels can repeat, so the text is no key; the list never reorders.
        // biome-ignore lint/suspicious/noArrayIndexKey: position is the only id, see above
        <OptionCard key={i} option={o} {...p} />
      ))}
    </div>
  );
}

function OptionCard(p: {
  option: BriefOption;
  live: boolean;
  disabled: boolean;
  title?: string;
  onPick: (o: BriefOption) => void;
}) {
  const content = (
    <>
      <b className="qtext">{p.option.label}</b>
      <span className="xs fg2">{p.option.answer}</span>
    </>
  );
  if (!p.live) return <div className="opt">{content}</div>;
  return (
    <button
      type="button"
      className="opt"
      aria-label={p.option.label}
      title={p.title}
      disabled={p.disabled}
      onClick={() => p.onPick(p.option)}
    >
      {content}
    </button>
  );
}

export function PersonStory({
  brief,
  items,
  tz,
  now,
  thread,
}: {
  brief: AttentionBrief;
  items: AttentionItem[];
  tz: string | null;
  now: number;
  thread: PersonThreadView;
}) {
  const person = brief.person;
  if (!person) return null;
  const catchUp = brief.catchUp ?? {
    kind: thread.catchUp,
    line: thread.reasonText,
    story: [],
    aware: [],
  };
  const list = (label: string, lines: string[] | undefined) =>
    lines?.length ? (
      <section>
        <div className="bsec">{label}</div>
        <ul className="checked">
          {lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: source order is fixed
            <li key={i}>{line}</li>
          ))}
        </ul>
      </section>
    ) : null;
  return (
    <div className="brief">
      {catchUp && (
        <div className="ctx">
          <span className="bsec">Catch-up</span>
          <div className="ctxline">
            <Pill tone={catchUp.kind === "new" ? "plain" : "warn"}>
              {CATCH_UP_LABEL[catchUp.kind]}
            </Pill>
            <span>{catchUp.line}</span>
          </div>
          {list("So far", catchUp.story)}
          {list("Be aware", catchUp.aware)}
        </div>
      )}
      {(person.history ?? thread.history)?.length ? (
        <section>
          <div className="bsec">Earlier in the thread</div>
          {(person.history ?? thread.history ?? []).map((message) => (
            <p className="s qtext" key={message.source.messageId}>
              <b>{message.author ?? "Someone"}</b> · {tz ? rel(message.at, now, tz) : "—"} ·{" "}
              <span>{message.text}</span>
            </p>
          ))}
        </section>
      ) : null}
      <b className="btitle qtext">{thread.title}</b>
      <div className="bsec">The message</div>
      <blockquote className="s qtext">
        {thread.message?.text ?? thread.snippet ?? "Message text unavailable."}
      </blockquote>
      {list("FLIGHT's assessment", person.assessment)}
      <div className="row">
        {person.related?.map((ref, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: source order is fixed
          <span className="chipref" key={i}>
            {ref.url ? <ExternalLink url={ref.url}>{ref.label}</ExternalLink> : ref.label}
          </span>
        ))}
        {person.decisionKey && items.some((i) => i.key === person.decisionKey) && (
          <button
            type="button"
            className="sm"
            onClick={() => openItem(person.decisionKey as string)}
          >
            Open the related decision
          </button>
        )}
      </div>
      <p className="s qtext">
        Here is what I know. {person.take} I drafted {person.replies?.length ?? 0} replies below:
        send one, edit it first, or tell me what you want to say.
      </p>
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
  const [text, setText] = useState("");
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
    setText(value);
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
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    disabled={busy}
                  />
                ) : (
                  <span className="s qtext">{reply.text}</span>
                )}
                <span className="row">
                  <button
                    type="button"
                    className="sm primary"
                    disabled={busy || (editing === reply.id && !text.trim())}
                    onClick={() =>
                      void run(async () => {
                        const body = editing === reply.id ? text : reply.text;
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
