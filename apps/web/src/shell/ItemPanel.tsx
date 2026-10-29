import {
  ATTENTION_LABEL,
  type AttentionItem,
  type BriefOption,
  type Crew,
  type ItemDiscussion as Discussion,
  type Escalation,
  type FlightView,
  type TicketView,
} from "@mc/core";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { ApiError, apiPost } from "../api.ts";
import { useNow, useTz } from "../clock.ts";
import { answerTarget, askFlight, dismissItem, sendAnswer } from "../comms/answer.ts";
import {
  BRIEF_FOLD_AFTER,
  BRIEF_LINES,
  BriefOptions,
  ItemBrief,
  PersonChoices,
  Recommendation,
} from "../comms/ItemBrief.tsx";
import { ItemDiscussion } from "../comms/ItemDiscussion.tsx";
import { MentionText } from "../comms/messages.tsx";
import { Expandable, Toggle } from "../components/Expandable.tsx";
import { ExternalLink } from "../components/ExternalLink.tsx";
import { Markdown, MarkdownInline } from "../components/Markdown.tsx";
import { hub, RESOURCES, useResource } from "../data.ts";
import { flightOffText } from "../flight/flightTypes.ts";
import { dayMonth, hhmm, rel } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { RepoRef } from "../hud/RepoRef.tsx";
import {
  CATCH_UP_LABEL,
  markHandled,
  type NotificationsView,
  type PersonThreadView,
  sourceOf,
  whereOf,
  whoOf,
} from "../notifications.ts";
import { agentPath, followLink } from "../router.ts";
import { BuildChips } from "./buildStatus.tsx";
import {
  closeItem,
  openItem,
  trapTab,
  useItem,
  useOpenedItem,
  useOverlay,
  useReturnFocus,
} from "./overlays.ts";
import { toast } from "./Toast.tsx";
import "./ItemPanel.css";

/**
 * A 540px fly-out for one thing that needs the operator. Every item uses the same brief sections;
 * escalations retain their GitHub reply link. Item discussion uses its own persisted history.
 */
export function ItemPanel() {
  const key = useItem();
  useOverlay("item", key !== null, () => closeItem());
  const items = useResource<AttentionItem[]>(RESOURCES.attention).data;
  const escRes = useResource<Escalation[]>(RESOURCES.escalations);
  const escalations = escRes.data;
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const notesRes = useResource<NotificationsView>(RESOURCES.notifications);
  const notes = notesRes.data;
  const flight = useResource<FlightView>(RESOURCES.flight).data;
  const seat = flight?.seat ?? null;
  const [person, setPerson] = useState<{ item: AttentionItem; thread: PersonThreadView } | null>(
    null,
  );
  const openedItem = useOpenedItem();
  const listedItem =
    items?.find((i) => i.key === key) ?? (openedItem?.key === key ? openedItem : undefined);
  const wholeItem = useResource<AttentionItem>(
    listedItem?.kind === "tag" && key !== null ? RESOURCES.attentionItem(key) : null,
  ).data;
  const currentItem = wholeItem?.key === key ? wholeItem : listedItem;
  const [savedAsk, setSavedAsk] = useState<AttentionItem | null>(null);
  useEffect(() => {
    if (currentItem && currentItem.kind !== "person") setSavedAsk(currentItem);
    else if (savedAsk?.key !== key) setSavedAsk(null);
  }, [key, currentItem, savedAsk?.key]);
  const currentThread = notes?.open.find((t) => t.key === key);
  useEffect(() => {
    if (currentItem?.kind === "person" && currentThread) {
      setPerson({ item: currentItem, thread: currentThread });
    } else if (person?.item.key !== key) {
      setPerson(null);
    }
  }, [key, currentItem, currentThread, person?.item.key]);
  const savedPerson = person?.item.key === key ? person : null;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [justHandled, setJustHandled] = useState<Record<string, string>>({});
  const [receipts, setReceipts] = useState<
    Record<string, { id: string; text: string; note?: string }>
  >({});
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const tz = useTz();
  const now = useNow();
  const head = useId();
  const close = useRef<HTMLButtonElement>(null);
  const activeKey = useRef(key);
  activeKey.current = key;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset action state when its item changes
  useEffect(() => {
    setText("");
    setBusy(false);
    setErr(null);
  }, [key]);
  useReturnFocus(key !== null);
  useEffect(() => {
    if (key !== null) close.current?.focus();
  }, [key]);
  if (key === null) return null;

  const item = currentItem ?? savedPerson?.item ?? (savedAsk?.key === key ? savedAsk : undefined);
  const esc = item?.escalationId ? escalations?.find((e) => e.id === item.escalationId) : undefined;
  // An escalation item waits for its escalations rather than flash the generic view.
  const holding = Boolean(item?.escalationId) && escalations === undefined && escRes.error === null;
  const agentId = item?.agentId ?? null;
  const agentIndex = crew?.rows.find((r) => r.id === agentId)?.index ?? 0;
  const live = seat?.live === true;
  // Led by the item's title, so the answer reads in context.
  const about = esc?.title ?? item?.text ?? "";
  const target = item ? answerTarget(item, crew?.rows, seat) : null;
  const queueApproval = item?.kind === "approval" && item.key.startsWith("note:queue-reorder:");
  const replyOk = target?.to === "seat" || (target?.to === "flight" && live);
  const act = async (run: () => Promise<string | null>) => {
    setBusy(true);
    setErr(null);
    const failed = await run();
    if (activeKey.current !== key) return;
    setBusy(false);
    setErr(failed);
  };
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    const body = text.trim();
    if (!item || !target || !body || !replyOk || busy) return;
    void act(async () => {
      const failed = await sendAnswer(target, seat, item, about, body);
      if (failed === null && activeKey.current === item.key)
        setText((current) => (current === text ? "" : current));
      return failed;
    });
  };
  const pick = (o: BriefOption) => {
    if (item && queueApproval) {
      if (busy || chosen[item.key] || (o.id !== "approve" && o.id !== "deny")) return;
      void act(async () => {
        try {
          const result = await apiPost<{ ok: boolean; text: string }>(
            `/api/queue/reorder/${encodeURIComponent(item.key)}`,
            { action: o.id },
          );
          if (!result.ok) return result.text;
          setChosen((prev) => ({ ...prev, [item.key]: o.label }));
          setReceipts((prev) => ({
            ...prev,
            [item.key]: { id: crypto.randomUUID(), text: result.text },
          }));
          hub.refetchTopic("attention");
          hub.refetchTopic("agents");
          hub.refetchTopic("boards");
          return null;
        } catch (e) {
          const explanation =
            e instanceof ApiError ? (e.body as { text?: unknown } | undefined)?.text : undefined;
          return typeof explanation === "string"
            ? explanation
            : e instanceof Error
              ? e.message
              : String(e);
        }
      });
      return;
    }
    if (!item || !target || !replyOk || busy || chosen[item.key]) return;
    if (item.kind === "person") {
      void act(() => sendAnswer(target, seat, item, about, o.answer));
      return;
    }
    if (item.kind === "approval" && o.label === "Edit") {
      toast("Opens the draft so you can change it before approving.");
      return;
    }
    const resource = RESOURCES.discussion(item.key);
    const discussion = hub.snapshot(resource.path, resource.topic).data as Discussion | undefined;
    const id = crypto.randomUUID();
    const receiptText = `You chose: ${o.label}\n\n${o.answer}`;
    const receipt = (note?: string) =>
      setReceipts((prev) => ({ ...prev, [item.key]: { id, text: receiptText, note } }));
    const refresh = () => {
      hub.refetch(resource.path);
      if (discussion) hub.refetch(RESOURCES.discussion(item.key, discussion.id).path);
    };
    void act(async () => {
      if (target.to !== "flight") {
        const failed = await sendAnswer(target, seat, item, about, o.answer);
        if (failed !== null) return failed;
      } else {
        if (!discussion)
          return "The discussion couldn't be loaded. Refresh discussion and try again.";
        try {
          await askFlight(item.key, discussion.version, id, o.answer);
          refresh();
        } catch (e) {
          return e instanceof Error ? e.message : "server unreachable";
        }
      }
      // These results belong to the captured item even if another item is now open.
      setChosen((prev) => ({ ...prev, [item.key]: o.label }));
      if (target.to === "flight") {
        receipt("FLIGHT hasn't replied yet.");
      } else if (discussion && live) {
        receipt("FLIGHT hasn't replied yet.");
        void askFlight(item.key, discussion.version, id, `You chose: ${o.label}`)
          .catch(() => receipt("Answer sent. FLIGHT hasn't replied yet."))
          .finally(refresh);
      } else {
        receipt(
          discussion
            ? "FLIGHT hasn't replied yet."
            : "Answer sent. The discussion couldn't be loaded.",
        );
      }
      return null;
    });
  };
  const dismiss = () => {
    if (!item) return;
    void act(async () => {
      const failed = await dismissItem(item.key);
      if (failed === null && activeKey.current === item.key) closeItem();
      return failed;
    });
  };
  const thread = currentThread ?? savedPerson?.thread;
  const handled = thread ? notes?.handledToday.find((h) => h.id === thread.id) : undefined;
  const handledHow = handled?.how ?? justHandled[key];
  const flightTitle = live ? undefined : flightOffText(seat);
  const options = item?.brief?.person ? [] : (item?.brief?.options ?? []);
  const when = (ms: number): string => (tz ? rel(ms, now, tz) : "—");

  return (
    <aside
      className={item?.kind === "person" ? "flyout person-item" : "flyout decision-item"}
      id="discuss"
      aria-labelledby={head}
      onKeyDown={trapTab}
    >
      <div className="panel">
        <div className="ph" id="dsHead">
          <h2 id={head}>{item ? ATTENTION_LABEL[item.kind] : "Item"}</h2>
          {thread && <b>{whoOf(thread)}</b>}
          {agentId !== null && <AgentTag id={agentId} index={agentIndex} sm />}
          {item && !holding && (
            <span className="sub">
              {thread
                ? `${whereOf(thread)} · ${when(thread.updatedAt)}`
                : item.kind !== "person" && item.brief
                  ? `raised by FLIGHT at ${tz ? hhmm(item.brief.at, tz) : "—"}`
                  : esc
                    ? `opened ${when(esc.openedAt)}`
                    : when(item.at)}
            </span>
          )}
          <BuildChips panel="discuss" />
          <span className="act">
            {thread && item?.brief?.person && (
              <ExternalLink
                url={thread.message?.url ?? thread.url}
                allowedOrigin={
                  item.brief.person.source.kind === "teams"
                    ? "https://teams.microsoft.com"
                    : "https://github.com"
                }
              >
                Open in {item.brief.person.source.kind === "teams" ? "Teams" : "GitHub"} ↗
              </ExternalLink>
            )}
            {item && (
              <button type="button" className="sm ghost" disabled={busy} onClick={dismiss}>
                Dismiss
              </button>
            )}
            <button type="button" className="sm" ref={close} onClick={() => closeItem()}>
              Close
            </button>
          </span>
        </div>
        <div className="item-body">
          <div className="pb" id="dsBrief">
            {!item || holding ? (
              <p className="note">
                {items === undefined || item ? "Loading…" : "This item is no longer open."}
              </p>
            ) : (
              <ItemBrief
                key={item.key}
                brief={item.brief}
                approval={item.kind === "approval"}
                original={
                  item.escalationId || thread || !item.brief?.original ? (
                    <OriginalItem item={item} esc={esc} thread={thread} tz={tz} now={now} />
                  ) : undefined
                }
                catchUp={
                  esc || thread ? (
                    <SourceCatchUp
                      esc={esc}
                      thread={thread}
                      tz={tz}
                      now={now}
                      hasBrief={Boolean(item.brief)}
                    />
                  ) : undefined
                }
                afterOriginal={
                  <>
                    {esc && <IssueBody key={esc.id} esc={esc} folded={Boolean(esc.question)} />}
                    {item.kind === "person" && !thread && (
                      <p className="note">
                        {notesRes.error
                          ? `Could not load the message: ${notesRes.error.message}`
                          : notes === undefined
                            ? "Loading the message…"
                            : "This message is no longer open."}
                      </p>
                    )}
                  </>
                }
                links={<OriginalLinks item={item} thread={thread} />}
                viewLinks={
                  item.brief?.person && (
                    <div className="row">
                      {item.brief.person.related?.map((ref, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: references remain in source order
                        <span className="chipref" key={i}>
                          {ref.url ? (
                            <ExternalLink url={ref.url}>{ref.label}</ExternalLink>
                          ) : (
                            ref.label
                          )}
                        </span>
                      ))}
                      {item.brief.person.decisionKey &&
                        items?.some((i) => i.key === item.brief?.person?.decisionKey) && (
                          <button
                            type="button"
                            className="sm"
                            onClick={() => openItem(item.brief?.person?.decisionKey as string)}
                          >
                            Open the related decision
                          </button>
                        )}
                    </div>
                  )
                }
              />
            )}
          </div>
          {item?.brief && !holding && <h3 className="bsec answer-heading">Your answer</h3>}
          {item?.brief && options.length === 0 && !holding && (
            <div className="composer">
              <Recommendation text={item.brief.recommendation} />
            </div>
          )}
          {item && !item.brief?.person && !holding && (esc || options.length > 0) && (
            <div className="composer" id="dsOpts">
              {options.length > 0 && (
                <>
                  {chosen[key] && (
                    <p>
                      You chose: <b>{chosen[key]}</b>
                    </p>
                  )}
                  <BriefOptions
                    options={options}
                    recommendedOptionId={item.brief?.recommendedOptionId}
                    recommendation={item.brief?.recommendation}
                    live={queueApproval || target?.to !== "github"}
                    disabled={busy || (!queueApproval && !replyOk) || Boolean(chosen[key])}
                    title={
                      !queueApproval && target?.to === "github"
                        ? "Reply on GitHub to answer this item."
                        : !queueApproval && target?.to === "flight"
                          ? flightTitle
                          : undefined
                    }
                    variant={item.kind === "approval" ? "row" : "panel"}
                    rowLabel={item.kind === "approval" ? "Your call:" : undefined}
                    primaryFirst={item.kind === "approval"}
                    onPick={pick}
                  />
                </>
              )}
              {esc && (
                <div className="row">
                  <ExternalLink url={esc.url}>Reply on GitHub ↗</ExternalLink>
                </div>
              )}
            </div>
          )}
          {item?.brief?.person && <PersonChoices key={item.key} item={item} thread={thread} />}
          {item?.kind === "person" && !item.brief?.person && !holding && (
            <div className="composer" id="dsPerson">
              {handledHow ? (
                <span>
                  Handled: <b>{handledHow}</b>
                </span>
              ) : !currentItem ? (
                <span>No longer open</span>
              ) : (
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const failed = await markHandled(item.key);
                      if (failed === null)
                        setJustHandled((prev) => ({ ...prev, [item.key]: "marked handled" }));
                      return failed;
                    })
                  }
                >
                  Mark handled
                </button>
              )}
            </div>
          )}
          {item && !holding && (target?.to === "seat" || target?.to === "flight") && (
            <form className="composer" id="dsForm" onSubmit={submit}>
              <input
                id="dsInput"
                autoComplete="off"
                aria-label="Your answer"
                placeholder="Type your answer…"
                title={!replyOk ? flightTitle : undefined}
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={!replyOk}
              />
              <button
                type="submit"
                className="primary"
                title={target?.to === "flight" ? flightTitle : undefined}
                disabled={!replyOk || busy}
              >
                Reply
              </button>
            </form>
          )}
          {item && !holding && (
            <ItemDiscussion
              itemKey={item.key}
              live={flight === undefined ? undefined : live}
              title={flightTitle}
              receipt={queueApproval ? undefined : receipts[item.key]}
              focus={options.length === 0 && !item.brief?.person?.replies?.length}
              collapsed={options.length > 0 || Boolean(item.brief?.person?.replies?.length)}
            />
          )}
          {queueApproval && busy && (
            <p className="note" role="status">
              Saving…
            </p>
          )}
          {queueApproval && receipts[key] && (
            <p className="note" role="status">
              {receipts[key].text}
            </p>
          )}
          {err !== null && (
            <p className="note err" role="alert">
              {err}
            </p>
          )}
        </div>
      </div>
    </aside>
  );
}

function OriginalItem({
  item,
  esc,
  thread,
  tz,
  now,
}: {
  item: AttentionItem;
  esc?: Escalation;
  thread?: PersonThreadView;
  tz: string | null;
  now: number;
}) {
  if (esc) {
    const q = esc.question;
    return (
      <>
        <b className="btitle qtext">
          <MarkdownInline text={esc.title} />
        </b>
        {q && (
          <>
            <div className="bsec">What is being asked</div>
            <Markdown text={q.question} />
            <div className="bsec">Why it came to you</div>
            <Markdown text={q.reasoning_quote} />
            <div className="bsec">Effort so far</div>
            <Markdown text={q.effort_sunk} />
            <div className="bsec">If nobody answers</div>
            <Markdown text={q.default_if_ignored} />
            <ul className="source-answers">
              {q.answers.map((answer, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: answers remain in source order
                <li key={i}>
                  <span className="qtext">
                    <MarkdownInline text={answer} />
                  </span>
                  {answer === q.recommendation && <span className="pill plain">Recommended</span>}
                </li>
              ))}
            </ul>
          </>
        )}
      </>
    );
  }
  return (
    <>
      {thread ? (
        <>
          {Boolean((item.brief?.person?.history ?? thread.history)?.length) && (
            <>
              <div className="bsec">Earlier in the thread</div>
              {(item.brief?.person?.history ?? thread.history ?? []).map((message) => (
                <p className="s qtext" key={message.source.messageId}>
                  <b>{message.author ?? "Someone"}</b> · {tz ? rel(message.at, now, tz) : "—"} ·{" "}
                  <span>{message.text}</span>
                </p>
              ))}
            </>
          )}
          <b className="btitle qtext">{thread.title}</b>
          <div className="bsec">The message</div>
          <blockquote className="s qtext">
            <MentionText text={thread.message?.text ?? thread.snippet ?? item.text} />
          </blockquote>
        </>
      ) : (
        <Markdown text={item.text} />
      )}
    </>
  );
}

function OriginalLinks({ item, thread }: { item: AttentionItem; thread?: PersonThreadView }) {
  return (
    <div className="row">
      {item.agentId !== null && (
        <a
          href={agentPath(item.agentId)}
          onClick={(e) => followLink(e, agentPath(item.agentId as string))}
        >
          Open {item.agentId}
        </a>
      )}
      {thread
        ? !item.brief?.person && (
            <ExternalLink
              url={thread.message?.url ?? thread.url}
              allowedOrigin={
                thread.message?.source.kind === "teams"
                  ? "https://teams.microsoft.com"
                  : "https://github.com"
              }
            >
              Open in {sourceOf(thread)} ↗
            </ExternalLink>
          )
        : item.url && <ExternalLink url={item.url}>Open on GitHub ↗</ExternalLink>}
    </div>
  );
}

function SourceCatchUp({
  esc,
  thread,
  tz,
  now,
  hasBrief,
}: {
  esc?: Escalation;
  thread?: PersonThreadView;
  tz: string | null;
  now: number;
  hasBrief: boolean;
}) {
  if (!esc && !thread) return null;
  const kind =
    thread?.catchUp ?? (esc && now - esc.openedAt < 24 * 3_600_000 ? "new" : "follow-up");
  return (
    <div className="ctx">
      <div className="bsec">Catch-up</div>
      <div className="ctxline">
        <span className={`pill ${kind === "new" ? "plain" : "warn"}`}>{CATCH_UP_LABEL[kind]}</span>
        <span>
          {thread ? (
            <>
              {thread.reasonText} · first seen {tz ? dayMonth(thread.firstSeenAt, tz) : "—"}
            </>
          ) : (
            esc && (
              <>
                Opened {tz ? dayMonth(esc.openedAt, tz) : "—"} on{" "}
                <RepoRef repoId={esc.repoId} number={esc.issueNumber} url={esc.url} />
              </>
            )
          )}
        </span>
      </div>
      {esc && !hasBrief && (
        <>
          <div className="bsec">So far</div>
          <p className="note">Catch-up unavailable.</p>
          <div className="bsec">Be aware</div>
          <p className="note">Awareness unavailable.</p>
          <div className="bsec">What FLIGHT checked</div>
          <p className="note">Checked sources unavailable.</p>
        </>
      )}
    </div>
  );
}

/**
 * The question's own text: the escalation's issue body, from the ticket resource. With no
 * structured question it shows at once; with one it stays folded until asked
 * for, and is not fetched before. Once asked for it stays subscribed, so hiding and showing it
 * again makes no new request. The caller keys it on the escalation, so no state carries over.
 */
function IssueBody({ esc, folded = false }: { esc: Escalation; folded?: boolean }) {
  const [open, setOpen] = useState(!folded);
  const [asked, setAsked] = useState(!folded);
  const res = useResource<TicketView>(asked ? RESOURCES.ticket(esc.repoId, esc.issueNumber) : null);
  const t = res.data;
  const body = t?.body.trim() ?? "";
  return (
    <>
      {folded && (
        <Toggle
          on={open}
          of="the issue's text"
          onClick={() => {
            setAsked(true);
            setOpen(!open);
          }}
        />
      )}
      {open && t === undefined && !res.error && <p className="note">Loading…</p>}
      {open && res.error && !t && (
        <p className="crit-t s">Could not load the question: {res.error.message}</p>
      )}
      {open && body !== "" && (
        <>
          <div className="s qtext">
            {folded ? (
              <Markdown text={body} />
            ) : (
              <Expandable lines={BRIEF_LINES} foldAfter={BRIEF_FOLD_AFTER} of="the issue's text">
                <Markdown text={body} />
              </Expandable>
            )}
          </div>
          {t?.bodyTruncated && (
            <p className="s">
              <ExternalLink url={t.url}>Continue on GitHub ↗</ExternalLink>
            </p>
          )}
        </>
      )}
    </>
  );
}
