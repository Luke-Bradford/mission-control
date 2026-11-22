import type {
  AttentionItem,
  BriefChoiceReceipt,
  BriefOption,
  ChoiceReceipt,
  Crew,
  Escalation,
  FlightView,
  TicketView,
} from "@mc/core";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, apiPost } from "../api.ts";
import { useNow, useTz } from "../clock.ts";
import {
  answerTarget,
  boundChoice,
  boundChoiceStands,
  choiceBlocker,
  choiceLine,
  dismissItem,
  newRequestId,
  receiptLine,
  sendAnswer,
  sendBoundChoice,
} from "../comms/answer.ts";
import { clearDraft, getDraft, setDraft } from "../comms/drafts.ts";
import {
  BRIEF_FOLD_AFTER,
  BRIEF_LINES,
  BriefOptions,
  DecisionFacts,
  ItemBrief,
  PersonChoices,
  Recommendation,
} from "../comms/ItemBrief.tsx";
import { MentionText } from "../comms/messages.tsx";
import { Expandable, Toggle } from "../components/Expandable.tsx";
import { ExternalLink } from "../components/ExternalLink.tsx";
import { Markdown, MarkdownInline } from "../components/Markdown.tsx";
import { hub, RESOURCES, streamStatus, useResource } from "../data.ts";
import { FlightStoppedNote } from "../flight/FlightStoppedNote.tsx";
import { FlightThread } from "../flight/FlightThread.tsx";
import { dayMonth, rel } from "../fmt.ts";
import { Pill } from "../hud/Pill.tsx";
import { RepoRef } from "../hud/RepoRef.tsx";
import { LinksSection } from "../needs/LinksSection.tsx";
import {
  OptionPictures,
  PlanAndMockups,
  useAttentionMaterials,
  useImageViewer,
} from "../needs/Materials.tsx";
import { Pictures } from "../needs/Pictures.tsx";
import { titleOf } from "../needs/QuestionBand.tsx";
import {
  CATCH_UP_LABEL,
  catchUpTone,
  markHandled,
  type NotificationsView,
  type PersonThreadView,
  sourceOf,
} from "../notifications.ts";
import { agentPath, followLink } from "../router.ts";
import { openItem, useOpenedItem } from "./overlays.ts";
import { useStore } from "./store.ts";
import "./ItemPanel.css";

/**
 * A 540px fly-out for one thing that needs the operator. Every item uses the same brief sections;
 * escalations retain their GitHub reply link. The FLIGHT thread beside the question is the one stored conversation.

/** Everything one open item shows and does, shared by the flyout and the Needs you page. */
export function useItemDetail(key: string | null) {
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
  const [text, setTextState] = useState(() => getDraft("answer", key));
  const setText = (value: string) => {
    setTextState(value);
    if (key !== null) setDraft("answer", key, value);
  };
  const [busy, setBusy] = useState(false);
  const [justHandled, setJustHandled] = useState<Record<string, string>>({});
  const [receipts, setReceipts] = useState<
    Record<string, { id: string; text: string; note?: string }>
  >({});
  const [chosenLocal, setChosen] = useState<Record<string, string>>({});
  const [boundReceipts, setBoundReceipts] = useState<Record<string, BriefChoiceReceipt>>({});
  const [err, setErr] = useState<string | null>(null);
  // What the operator picked on each item and under which request id: a retry of the same
  // option on the same brief reuses the id, so the server never applies it twice.
  const intents = useRef<Record<string, { optionId: string; briefId: number; requestId: string }>>(
    {},
  );
  // Bumped by Discuss: the conversation opens and takes focus.
  const [discussOpen, setDiscussOpen] = useState<Record<string, number>>({});
  const tz = useTz();
  const now = useNow();
  const activeKey = useRef(key);
  activeKey.current = key;
  useEffect(() => {
    setTextState(getDraft("answer", key));
    setBusy(false);
    setErr(null);
  }, [key]);
  const k: string = key ?? "";

  const item = currentItem ?? savedPerson?.item ?? (savedAsk?.key === key ? savedAsk : undefined);
  // The choice already made on this item, so a reload still shows it recorded.
  const choiceRes = useResource<ChoiceReceipt>(
    item?.brief && item.brief.options.length > 0 ? RESOURCES.choice(item.key) : null,
  );
  const serverChoice =
    choiceRes.data?.key === k && item?.brief && choiceRes.data.chosenAt >= item.brief.at
      ? choiceRes.data
      : undefined;
  const recorded = serverChoice;
  // The bound choice made on this item: this page's receipt, else the one the hub stored.
  const boundReceipt = boundReceipts[k] ?? item?.brief?.choice;
  const boundLabel =
    boundReceipt && boundChoiceStands(boundReceipt)
      ? item?.brief?.options.find((o) => o.id === boundReceipt.optionId)?.label
      : undefined;
  const chosen =
    recorded && !chosenLocal[k]
      ? { ...chosenLocal, [k]: recorded.label }
      : boundLabel && !chosenLocal[k]
        ? { ...chosenLocal, [k]: boundLabel }
        : chosenLocal;
  const esc = item?.escalationId ? escalations?.find((e) => e.id === item.escalationId) : undefined;
  // An escalation item waits for its escalations rather than flash the generic view.
  const holding = Boolean(item?.escalationId) && escalations === undefined && escRes.error === null;
  const agentId = item?.agentId ?? null;
  const agentIndex = crew?.rows.find((r) => r.id === agentId)?.index ?? 0;
  // The thread beside the question is headed with the title the page and the list show for it.
  const about = item ? titleOf(item) : "";
  const target = item ? answerTarget(item, crew?.rows, seat) : null;
  const queueApproval = item?.kind === "approval" && item.key.startsWith("note:queue-reorder:");
  // FLIGHT being stopped never blocks the operator: the hub keeps the message for its next start.
  const replyOk = target?.to === "seat" || target?.to === "flight";
  const act = async (run: () => Promise<string | null>) => {
    setBusy(true);
    setErr(null);
    const failed = await run();
    if (activeKey.current !== k) return;
    setBusy(false);
    setErr(failed);
  };
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    const body = text.trim();
    if (!item || !target || !body || !replyOk || busy) return;
    void act(async () => {
      const failed = await sendAnswer(target, seat, item, body);
      if (failed === null && getDraft("answer", item.key) === text) {
        clearDraft("answer", item.key);
        if (activeKey.current === item.key) setTextState("");
      }
      return failed;
    });
  };
  const pick = (o: BriefOption) => {
    if (item && queueApproval && !boundChoice(item, o)) {
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
    const bound = item ? boundChoice(item, o) : null;
    if (item && bound && o.id !== undefined) {
      if (busy || chosen[item.key]) return;
      const prior = intents.current[item.key];
      const intent =
        prior?.optionId === o.id && prior.briefId === bound.briefId
          ? prior
          : { optionId: o.id, briefId: bound.briefId, requestId: newRequestId() };
      intents.current[item.key] = intent;
      void act(async () => {
        const result = await sendBoundChoice(item, o, intent.requestId);
        // No answer: the outcome is unknown, so the intent stays for a retry.
        if ("error" in result) return result.error;
        if (!boundChoiceStands(result.receipt)) {
          delete intents.current[item.key];
          return result.receipt.text;
        }
        setChosen((prev) => ({ ...prev, [item.key]: o.label }));
        setBoundReceipts((prev) => ({ ...prev, [item.key]: result.receipt }));
        return null;
      });
    }
  };
  const dismiss = (after?: () => void) => {
    if (!item) return;
    void act(async () => {
      const failed = await dismissItem(item.key);
      if (failed === null && activeKey.current === item.key) after?.();
      return failed;
    });
  };
  const thread = currentThread ?? savedPerson?.thread;
  const handled = thread ? notes?.handledToday.find((h) => h.id === thread.id) : undefined;
  const handledHow = handled?.how ?? justHandled[k];
  // A person-source brief may carry a complete decision even when the server cannot prepare an
  // action for it. Keep that contract readable and let its missing binding disable choices.
  // Only older records with no decision context use the legacy reply controls.
  const completePersonBrief = Boolean(item?.brief?.person && item.brief.decision);
  const options = completePersonBrief
    ? (item?.brief?.options ?? [])
    : item?.brief?.person
      ? []
      : (item?.brief?.options ?? []);
  const when = (ms: number): string => (tz ? rel(ms, now, tz) : "—");

  return {
    key,
    k,
    item,
    items,
    holding,
    esc,
    escalations,
    thread,
    notes,
    notesRes,
    tz,
    now,
    agentId,
    agentIndex,
    seat,
    about,
    flight,
    target,
    queueApproval,
    replyOk,
    text,
    setText,
    busy,
    err,
    chosen,
    recorded,
    boundReceipt,
    receipts,
    handledHow,
    options,
    completePersonBrief,
    currentItem,
    submit,
    pick,
    discussOpen,
    discuss: () => setDiscussOpen((prev) => ({ ...prev, [k]: (prev[k] ?? 0) + 1 })),
    dismiss,
    act,
    setJustHandled,
    when,
  };
}

export type ItemDetailState = ReturnType<typeof useItemDetail>;

/** The flyout's body (`panel`, in today's order) or the page's two columns (`page`). */
export function ItemDetail({
  detail,
  layout,
}: {
  detail: ItemDetailState;
  layout: "panel" | "page";
}) {
  const {
    key,
    k,
    item,
    items,
    holding,
    esc,
    thread,
    notes,
    notesRes,
    tz,
    now,
    about,
    flight,
    target,
    queueApproval,
    replyOk,
    text,
    setText,
    busy,
    err,
    chosen,
    recorded,
    boundReceipt,
    receipts,
    handledHow,
    options,
    completePersonBrief,
    currentItem,
    submit,
    pick,
    discussOpen,
    discuss,
    act,
    setJustHandled,
  } = detail;
  const page = layout === "page";
  const materials = useAttentionMaterials(page && item && !holding ? item : null);
  const viewer = useImageViewer();
  const connection = useStore(streamStatus);
  const disconnected = !connection.connected && connection.reconnecting;
  if (key === null) return null;
  const p = page ? "needs" : "ds";
  const flightSeat = flight === undefined ? undefined : flight.seat;
  const briefBlock = (
    <div className="pb" id={`${p}Brief`}>
      {!item || holding ? (
        <p className="note">
          {items === undefined || item ? "Loading…" : "This item is no longer open."}
        </p>
      ) : (
        <ItemBrief
          plain={page}
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
          links={<OriginalLinks item={item} thread={thread} hideUrl={page} />}
          viewLinks={
            item.brief?.person && (
              <div className="row">
                {item.brief.person.related?.map((ref, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: references remain in source order
                  <span className="chipref" key={i}>
                    {ref.url ? <ExternalLink url={ref.url}>{ref.label}</ExternalLink> : ref.label}
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
  );
  const brief = item?.brief;
  const recommended = brief?.options.find(
    (o) => o.id !== undefined && o.id === brief.recommendedOptionId,
  );
  // An unbound queue proposal still goes through its own route; every other option needs the
  // server's binding on a current brief.
  const blockerOf = (o: BriefOption): string | null =>
    !item
      ? "Loading…"
      : disconnected
        ? "Disconnected. Reconnect to choose."
        : queueApproval && !boundChoice(item, o) && (o.id === "approve" || o.id === "deny")
          ? null
          : choiceBlocker(item, o);
  const sendable = options.some((o) => blockerOf(o) === null);
  const githubOnly = target?.to === "github" && !sendable;
  const acceptBlock = recommended
    ? githubOnly
      ? null
      : blockerOf(recommended)
    : "FLIGHT named no recommended option.";
  const showFacts =
    brief !== undefined &&
    (!brief.person || completePersonBrief) &&
    !holding &&
    (brief.for === "operator" || options.length > 0);
  const answerBlock = (
    <>
      {item && brief && showFacts && (
        <DecisionFacts brief={brief} defaultDueAt={item.defaultDueAt} tz={tz} />
      )}
      {item?.brief && !holding && <h3 className="bsec answer-heading">Your answer</h3>}
      {item?.brief && options.length === 0 && !holding && (
        <div className="composer">
          <Recommendation text={item.brief.recommendation} />
        </div>
      )}
      {item &&
        (!item.brief?.person || completePersonBrief) &&
        !holding &&
        (esc || options.length > 0) && (
          <div className="composer" id={`${p}Opts`}>
            {options.length > 0 && (
              <>
                {chosen[k] && (
                  <p>
                    You chose: <b>{chosen[k]}</b>
                    {recorded && (
                      <span className="note" data-testid="choice-line">
                        {" "}
                        · {choiceLine(recorded, tz ?? "UTC")}
                      </span>
                    )}
                    {!recorded && boundReceipt && (
                      <span className="note" data-testid="choice-line">
                        {" "}
                        · {receiptLine(boundReceipt)}
                      </span>
                    )}
                  </p>
                )}
                <BriefOptions
                  options={options}
                  recommendedOptionId={item.brief?.recommendedOptionId}
                  recommendation={item.brief?.recommendation}
                  live={sendable || target?.to !== "github"}
                  disabled={busy || Boolean(chosen[k])}
                  canPick={(o) => blockerOf(o) === null}
                  title={githubOnly ? "Reply on GitHub to answer this item." : undefined}
                  variant={item.kind === "approval" ? "row" : "panel"}
                  rowLabel={item.kind === "approval" ? "Your call:" : undefined}
                  primaryFirst={item.kind === "approval"}
                  pictures={
                    materials.packets.length > 0
                      ? (o) => (
                          <OptionPictures
                            option={o}
                            packets={materials.packets}
                            open={viewer.open}
                          />
                        )
                      : undefined
                  }
                  onPick={pick}
                />
                {recommended && !(githubOnly && acceptBlock === null) && (
                  <div className="answer-actions">
                    <button
                      type="button"
                      className="primary"
                      disabled={busy || Boolean(chosen[k]) || acceptBlock !== null}
                      onClick={() => pick(recommended)}
                    >
                      Accept recommendation: {recommended.label}
                    </button>
                    <button type="button" onClick={discuss}>
                      Discuss
                    </button>
                    {acceptBlock !== null && !chosen[k] && <p className="note">{acceptBlock}</p>}
                  </div>
                )}
                {!recommended && (
                  <div className="answer-actions">
                    <button type="button" onClick={discuss}>
                      Discuss
                    </button>
                    {acceptBlock !== null && !githubOnly && <p className="note">{acceptBlock}</p>}
                  </div>
                )}
                {!queueApproval && target?.to === "flight" && (
                  <FlightStoppedNote seat={flightSeat} />
                )}
              </>
            )}
            {esc && (
              <div className="row">
                <ExternalLink url={esc.url}>Reply on GitHub ↗</ExternalLink>
              </div>
            )}
          </div>
        )}
      {item?.brief?.person && !completePersonBrief && (
        <PersonChoices key={item.key} item={item} thread={thread} />
      )}
      {item?.kind === "person" && !item.brief?.person && !holding && (
        <div className="composer" id={`${p}Person`}>
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
    </>
  );
  const replyBlock = (
    <>
      {item &&
        !completePersonBrief &&
        !holding &&
        (target?.to === "seat" || target?.to === "flight") && (
          <form className="composer" id={`${p}Form`} onSubmit={submit}>
            {page ? (
              <textarea
                id={`${p}Input`}
                aria-label="Your answer"
                placeholder="Type your answer… (Ctrl or ⌘ + Enter sends)"
                rows={3}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit(e);
                }}
                disabled={!replyOk}
              />
            ) : (
              <input
                id={`${p}Input`}
                autoComplete="off"
                aria-label="Your answer"
                placeholder="Type your answer…"
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={!replyOk}
              />
            )}
            <button type="submit" className="primary" disabled={!replyOk || busy}>
              Reply
            </button>
            {target?.to === "flight" && <FlightStoppedNote seat={flightSeat} />}
          </form>
        )}
    </>
  );
  const discussionBlock = (
    <>
      {item && !holding && (
        <FlightThread
          key={item.key}
          id={`${p}Thread`}
          itemKey={item.key}
          about={about}
          openRequest={discussOpen[item.key] ?? 0}
        />
      )}
    </>
  );
  const notesBlock = (
    <>
      {queueApproval && busy && (
        <p className="note" role="status">
          Saving…
        </p>
      )}
      {queueApproval && receipts[k] && (
        <p className="note" role="status">
          {receipts[k].text}
        </p>
      )}
      {err !== null && (
        <p className="note err" role="alert">
          {err}
        </p>
      )}
    </>
  );
  if (page && item && !holding) {
    return (
      <div className="needs-body">
        <div className="needs-main" id="needsMain">
          <div className="needs-answer">
            {answerBlock}
            {replyBlock}
          </div>
          <PlanAndMockups item={item} open={viewer.open} {...materials} />
          {viewer.element}
          <Pictures item={item} />
          {item.brief ? (
            <details className="needs-more" open={Boolean(item.brief.person) || undefined}>
              <summary>Details</summary>
              {briefBlock}
            </details>
          ) : (
            // with no brief, the item's own text is all there is: keep it in view
            briefBlock
          )}
          <LinksSection item={item} />
        </div>
        <div className="needs-side" id="needsSide">
          {discussionBlock}
          {notesBlock}
        </div>
      </div>
    );
  }
  return (
    <>
      {briefBlock}
      {answerBlock}
      {replyBlock}
      {discussionBlock}
      {notesBlock}
    </>
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
                  {answer === q.recommendation && <Pill tone="plain">Recommended</Pill>}
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

function OriginalLinks({
  item,
  thread,
  hideUrl = false,
}: {
  item: AttentionItem;
  thread?: PersonThreadView;
  /** The page lists the item URL and the seat's page in its Links section. */
  hideUrl?: boolean;
}) {
  return (
    <div className="row">
      {item.agentId !== null && !hideUrl && (
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
        : item.url && !hideUrl && <ExternalLink url={item.url}>Open on GitHub ↗</ExternalLink>}
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
        <Pill tone={catchUpTone(kind)}>{CATCH_UP_LABEL[kind]}</Pill>
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
