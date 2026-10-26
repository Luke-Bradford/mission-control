import {
  ATTENTION_KINDS,
  ATTENTION_LABEL,
  type AttentionHoldCondition,
  type AttentionItem,
  type AttentionKind,
  type BoardItem,
  type CrewRow,
  clockHm,
  FLIGHT_TRIAGE_LABEL,
  type FlightView,
  GUARD_NONE_TEXT,
  type GuardHitsView,
  guardAckKey,
  guardSummary,
  type TestLockState,
} from "@mc/core";
import { useEffect, useRef, useState } from "react";
import { ackKeys } from "../ack.ts";
import { interruptSeat, seatError } from "../agent/seat.ts";
import { apiPost } from "../api.ts";
import { isOperatorItem, itemOwner, ownerLabel } from "../attention.ts";
import { useSecond, useTz } from "../clock.ts";
import { Expandable } from "../components/Expandable.tsx";
import { ExternalLink } from "../components/ExternalLink.tsx";
import { useTestLock } from "../components/LockLines.tsx";
import { MarkdownInline } from "../components/Markdown.tsx";
import { needsLamp } from "../crew.ts";
import { ACTIONS, RESOURCES, useResource } from "../data.ts";
import { flightOffText } from "../flight/flightTypes.ts";
import { cutText, dur, mss } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Lamp } from "../hud/Lamp.tsx";
import { Panel } from "../hud/Panel.tsx";
import { RepoRef } from "../hud/RepoRef.tsx";
import { agentPath, navigate } from "../router.ts";
import { openDockChat, openItem, useFlightUnread } from "../shell/overlays.ts";
import { GUARD_DRAWER_ID } from "../telemetry/guardCopy.ts";
import { type AnswerTarget, answerTarget, sendAnswer } from "./answer.ts";
import { BriefOptions } from "./ItemBrief.tsx";

/** Attention raised by the crew's messages (an @CAPCOM tag or an unread direct reply), cleared by Read. */
const isChannelItem = (i: AttentionItem): boolean => i.kind === "tag" || i.kind === "message";

/** Rows are cut here (catalogue 2.5.1). */
export const NEED_TEXT_MAX = 170;

/** Stalls read from the item's own `at` and `tool` on the 1 s clock; the server text is only "No output". */
export function needText(i: AttentionItem, now: number): string {
  if (i.kind !== "stalled") return i.text;
  return `${mss(now - i.at)} ${i.tool ? `in ${i.tool}` : "without output"}`;
}

/** The server words a PR item `PR #n · You: …`; the number becomes a link to the PR's repo. */
const PR_TEXT = /^PR #(\d+)( · .*)$/s;

function NeedText({
  item,
  now,
  lock,
  full = false,
}: {
  item: AttentionItem;
  now: number;
  lock?: TestLockState;
  full?: boolean;
}) {
  const board = useResource<BoardItem[]>(
    item.kind === "pr" && item.repoId !== null ? RESOURCES.boards(item.repoId) : null,
  ).data;
  const ticket = board?.find((b) => `${b.repoId}#${b.issueNumber}` === item.ticket);
  let text = needText(item, now);
  if (item.kind === "stalled" && lock?.holder) {
    // Only a seat that is actually queued for the lock is waiting on it; another stall is unrelated.
    if (holdsLock(item, lock)) text += ` · holds the test lock (${lock.holder.seatId})`;
    else if (lock.waiting.some((w) => w.seatId === item.agentId)) {
      text += ` · waiting on the test lock (${lock.holder.seatId})`;
    }
  }
  const pr = /^PR #(\d+) · You: (.*)$/s.exec(item.text);
  if (item.kind === "pr" && ticket && pr) {
    return (
      <span>
        {item.ticket} ·{" "}
        <RepoRef repoId={ticket.repoId} number={Number(pr[1])} kind="pr" url={item.url} bare />
        {cutText(
          ` · ${ticket.title}: waiting ${dur(Math.max(0, now - item.at))} for you to ${pr[2]}`,
          full ? Infinity : NEED_TEXT_MAX - `${item.ticket} · PR #${pr[1]}`.length,
        )}
      </span>
    );
  }
  const m = item.kind === "pr" && item.repoId !== null ? PR_TEXT.exec(text) : null;
  // inline only, cut after parsing: a row stays one run of text and never ends in half a marker
  if (!m || item.repoId === null) {
    return (
      <span>
        <MarkdownInline text={text} max={full ? undefined : NEED_TEXT_MAX} />
      </span>
    );
  }
  return (
    <span>
      <RepoRef repoId={item.repoId} number={Number(m[1])} kind="pr" url={item.url} />
      <MarkdownInline
        text={m[2] ?? ""}
        max={full ? undefined : NEED_TEXT_MAX - `PR #${m[1]}`.length}
      />
    </span>
  );
}

/** Kind order (`ATTENTION_KINDS`), then as the server sent them. */
export function sortNeeds(items: AttentionItem[]): AttentionItem[] {
  const rank = (i: AttentionItem) => ATTENTION_KINDS.indexOf(i.kind);
  return [...items].sort((a, b) => rank(a) - rank(b));
}

/** The kinds the row's Answer button opens, when no escalation on GitHub carries the question. */
const ANSWERED_HERE: readonly AttentionKind[] = ["approval", "question"];

/** The server raises a `lock` item for a stalled holder with a seat waiting, and a stall alone can be the holder's. */
function holdsLock(i: AttentionItem, lock: TestLockState | undefined): boolean {
  if (i.kind === "lock") return true;
  return i.kind === "stalled" && i.agentId !== null && i.agentId === lock?.holder?.seatId;
}

/** The text FLIGHT is asked about a stray file (the mockup's "… outside every area. Whose is it?"). */
const strayQuestion = (text: string): string => `${text.replace(/[.\s]+$/, "")}. Whose is it?`;

/**
 * Comms › Needs you (catalogue 2.5.1): the attention list, with its row actions, Ack and
 * Acknowledge all. `onAskFlight` runs once a stray file's question is sent to FLIGHT.
 */
export function NeedsList({
  items,
  rows,
  onAskFlight,
  onRead,
}: {
  items: AttentionItem[] | undefined;
  rows: CrewRow[];
  onAskFlight: () => void;
  onRead: (id: string) => void;
}) {
  const held = useResource<AttentionItem[]>(RESOURCES.heldAttention);
  const [holding, setHolding] = useState<string | null>(null);
  const now = useSecond();
  const replies = useFlightUnread();
  const flightSeat = useResource<FlightView>(RESOURCES.flight).data?.seat ?? null;
  const lock = useTestLock();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = sortNeeds((items ?? []).filter(isOperatorItem));
  const handled = sortNeeds(
    (items ?? []).filter(
      (i) => !isOperatorItem(i) && i.flightTriage !== "waiting" && i.flightTriage !== "handling",
    ),
  );
  const unacked = list.filter((i) => !i.acked);
  // Acknowledging a channel item does not mark its messages read.
  const ackable = unacked.map((i) => i.key);

  const ack = async (keys: string[]) => {
    setBusy(true);
    setError(null);
    setError(await ackKeys(keys));
    setBusy(false);
  };
  /** Run a row's control; a refusal shows in the panel's error line. */
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(seatError(e));
    }
    setBusy(false);
  };
  const stop = (seatId: string) => act(() => interruptSeat({ id: seatId }));
  const askFlight = (i: AttentionItem) =>
    act(async () => {
      if (flightSeat?.live !== true) return;
      await apiPost(ACTIONS.seatMessage(flightSeat.id), { text: strayQuestion(i.text) });
      onAskFlight();
    });
  const answer = async (target: AnswerTarget, i: AttentionItem, body: string) => {
    setBusy(true);
    setError(null);
    setError(await sendAnswer(target, flightSeat, i, i.text, body));
    setBusy(false);
  };

  return (
    <Panel
      id="cNeedsP"
      title="Needs you"
      sub={
        list.length > 0 ? `${list.length} · ${unacked.length} not acknowledged` : "nothing waiting"
      }
      actions={
        <button
          type="button"
          className="sm ghost"
          id="ackAll"
          disabled={busy || ackable.length === 0}
          onClick={() => ack(ackable)}
        >
          Acknowledge all
        </button>
      }
    >
      <div className="scroll" id="cNeeds">
        {items !== undefined && list.length === 0 && replies === 0 && (
          <div className="pb muted">Nothing needs you right now.</div>
        )}
        {error && <div className="pb crit-t s">{error}</div>}
        {replies > 0 && (
          // no Ack: it clears when the operator has looked at the Chat tab
          <div className="nrow" data-kind="message">
            <div>
              <span className="kind">{ATTENTION_LABEL.message}</span>{" "}
              <span>{replies > 1 ? `FLIGHT replied (${replies})` : "FLIGHT replied"}</span>
            </div>
            <div className="acts">
              <button type="button" className="sm" onClick={openDockChat}>
                Open the chat
              </button>
            </div>
          </div>
        )}
        {list.map((i) => {
          const lamp = needsLamp([i], !i.acked);
          const agentId = i.agentId;
          const row = rows.find((r) => r.id === agentId);
          const target = answerTarget(i, rows, flightSeat);
          return (
            <div key={i.key} className={i.acked ? "nrow acked" : "nrow"} data-kind={i.kind}>
              {lamp && <Lamp {...lamp} />}
              <div>
                <span className="kind">{ATTENTION_LABEL[i.kind]}</span>{" "}
                {agentId !== null && <AgentTag id={agentId} index={row?.index ?? 0} sm />}{" "}
                <NeedText item={i} now={now} lock={lock} />
                {i.holdReleased && <div className="xs muted">hold released: {i.holdReleased}</div>}
                {i.flightTriage === "missed" && (
                  <div className="xs muted">{FLIGHT_TRIAGE_LABEL.missed}</div>
                )}
                {i.brief && (
                  <>
                    <div className="xs fg2">
                      FLIGHT recommends:{" "}
                      <MarkdownInline text={i.brief.recommendation} max={NEED_TEXT_MAX} />
                    </div>
                    {target.to !== "github" && (
                      <BriefOptions
                        options={i.brief.options}
                        live
                        disabled={busy || !(target.to === "seat" || flightSeat?.live === true)}
                        title={
                          target.to === "flight" && flightSeat?.live !== true
                            ? flightOffText(flightSeat)
                            : undefined
                        }
                        variant="row"
                        onPick={(o) => answer(target, i, o.answer)}
                      />
                    )}
                  </>
                )}
              </div>
              <div className="acts">
                {isChannelItem(i) && agentId !== null && (
                  <button type="button" className="sm primary" onClick={() => onRead(agentId)}>
                    Read
                  </button>
                )}
                {i.kind === "person" && i.url && (
                  <ExternalLink url={i.url}>Open in GitHub ↗</ExternalLink>
                )}
                {i.escalationId === null && !isChannelItem(i) && (
                  <button type="button" className="sm primary" onClick={() => openItem(i.key)}>
                    {ANSWERED_HERE.includes(i.kind)
                      ? "Answer"
                      : i.brief || i.kind === "person"
                        ? "Read the brief"
                        : "Discuss"}
                  </button>
                )}
                {agentId !== null && holdsLock(i, lock) && (
                  <button
                    type="button"
                    className="sm warn"
                    disabled={busy}
                    onClick={() => stop(agentId)}
                  >
                    Stop the run
                  </button>
                )}
                {agentId !== null && i.kind === "stalled" && !holdsLock(i, lock) && (
                  <button
                    type="button"
                    className="sm"
                    disabled={busy}
                    onClick={() => stop(agentId)}
                  >
                    Interrupt
                  </button>
                )}
                {i.kind === "stray" && (
                  <button
                    type="button"
                    className="sm"
                    disabled={busy || flightSeat?.live !== true}
                    title={flightSeat?.live === true ? undefined : flightOffText(flightSeat)}
                    onClick={() => askFlight(i)}
                  >
                    Ask FLIGHT
                  </button>
                )}
                {i.escalationId !== null ? (
                  <>
                    <button type="button" className="sm primary" onClick={() => openItem(i.key)}>
                      Read the brief
                    </button>
                    {i.url && <ExternalLink url={i.url}>Open on GitHub ↗</ExternalLink>}
                  </>
                ) : i.kind === "pr" ? (
                  i.url && <ExternalLink url={i.url}>Open PR ↗</ExternalLink>
                ) : (
                  // a stray is only acknowledged: the commit tool already set it aside
                  i.kind !== "stray" &&
                  !isChannelItem(i) &&
                  agentId !== null && (
                    <button
                      type="button"
                      className="sm"
                      onClick={() => navigate(agentPath(agentId))}
                    >
                      Open
                    </button>
                  )
                )}
                {!i.acked && (
                  <button
                    type="button"
                    className="sm ghost"
                    disabled={busy}
                    onClick={() => ack([i.key])}
                  >
                    Ack
                  </button>
                )}
                <button
                  type="button"
                  className="sm ghost"
                  disabled={busy}
                  onClick={() => setHolding(i.key)}
                >
                  Hold…
                </button>
              </div>
              {holding === i.key && (
                <HoldForm
                  busy={busy}
                  onCancel={() => setHolding(null)}
                  onHold={(reason, condition) =>
                    act(async () => {
                      await apiPost(ACTIONS.hold(i.key), { reason, condition });
                      setHolding(null);
                    })
                  }
                />
              )}
            </div>
          );
        })}
      </div>
      {held.data && held.data.length > 0 && (
        <details id="cHeld" className="guard">
          <summary>Held · {held.data.length}</summary>
          {held.data.map((i) => (
            <div className="nrow" key={i.key} data-kind={i.kind}>
              <div>
                <span className="kind">{ATTENTION_LABEL[i.kind]}</span> <span>{i.text}</span>
                <div className="xs muted">{i.hold?.reason}</div>
                <button
                  type="button"
                  className="sm"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      await apiPost(ACTIONS.releaseHold(i.key), {});
                    })
                  }
                >
                  Release
                </button>
              </div>
            </div>
          ))}
        </details>
      )}
      {handled.length > 0 && (
        <details id="cHandled" className="guard">
          <summary>Being handled · {handled.length}</summary>
          {handled.map((i) => (
            <div key={i.key} className="nrow" data-kind={i.kind}>
              <div>
                <span className="kind">{ATTENTION_LABEL[i.kind]}</span>{" "}
                <span className="xs muted">{ownerLabel(itemOwner(i))}</span>{" "}
                <Expandable lines={2}>
                  <NeedText item={i} now={now} lock={lock} full />
                </Expandable>
              </div>
            </div>
          ))}
        </details>
      )}
      <GuardDrawer rows={rows} busy={busy} ack={ack} />
    </Panel>
  );
}

/** Guard hits this week (catalogue 2.5.1): for information, each with its own Ack. */
function GuardDrawer({
  rows,
  busy,
  ack,
}: {
  rows: CrewRow[];
  busy: boolean;
  ack: (keys: string[]) => Promise<void>;
}) {
  const view = useResource<GuardHitsView>(RESOURCES.guardHits).data;
  const hits = view?.hits;
  // the whole window's count (the list is capped), so this and Setup's Hits column agree
  const total = view ? Object.values(view.counts).reduce((a, b) => a + b, 0) : 0;
  const tz = useTz();
  const drawer = useRef<HTMLDetailsElement>(null);
  const rendered = hits !== undefined;
  // `/comms#cGuard` (the Telemetry Guard tile's link) opens the drawer and scrolls to it, once it
  // has rendered, and again whenever the hash changes to it with Comms already open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `rendered` is the re-run trigger
  useEffect(() => {
    const openFromHash = () => {
      if (window.location.hash === `#${GUARD_DRAWER_ID}` && drawer.current) {
        drawer.current.open = true;
        drawer.current.scrollIntoView?.();
      }
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, [rendered]);
  if (hits === undefined) return null;
  return (
    <details id={GUARD_DRAWER_ID} ref={drawer} className="guard">
      <summary>
        {total === 0 ? GUARD_NONE_TEXT : guardSummary(total, hits.filter((h) => !h.acked).length)}
      </summary>
      {hits.map((h) => (
        <div key={h.id} className={h.acked ? "nrow acked" : "nrow"}>
          <span className="warn-t" aria-hidden="true">
            ⊘
          </span>
          <div className="min0">
            <AgentTag id={h.agentId} index={rows.find((r) => r.id === h.agentId)?.index ?? 0} sm />{" "}
            <span className="s">{h.text}</span>
            <br />
            <span className="xs muted num">
              {tz === null ? "—" : clockHm(h.at, tz)} · rule: {h.rule}
            </span>
          </div>
          {!h.acked && (
            <div className="acts">
              <button
                type="button"
                className="sm ghost"
                aria-label={`Ack: ${h.text}`}
                disabled={busy}
                onClick={() => ack([guardAckKey(h.id)])}
              >
                Ack
              </button>
            </div>
          )}
        </div>
      ))}
    </details>
  );
}

export function HoldForm({
  busy,
  onCancel,
  onHold,
}: {
  busy: boolean;
  onCancel: () => void;
  onHold: (reason: string, condition: AttentionHoldCondition) => void;
}) {
  const [reason, setReason] = useState("");
  const [kind, setKind] = useState<AttentionHoldCondition["kind"]>("manual");
  const [date, setDate] = useState("");
  const [ticket, setTicket] = useState("");
  return (
    <form
      className="hold-form"
      onSubmit={(event) => {
        event.preventDefault();
        const condition: AttentionHoldCondition =
          kind === "date"
            ? { kind, at: new Date(date).getTime() }
            : kind === "ticket"
              ? { kind, ticket: ticket.trim() }
              : { kind };
        onHold(reason.trim(), condition);
      }}
    >
      <label>
        Reason
        <input
          required
          maxLength={1000}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <label>
        Release condition
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as AttentionHoldCondition["kind"])}
        >
          <option value="manual">until I release it</option>
          <option value="date">a date</option>
          <option value="ticket">until a ticket merges</option>
          <option value="crew">until the crew resumes</option>
        </select>
      </label>
      {kind === "date" && (
        <label>
          Date
          <input
            required
            type="datetime-local"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
      )}
      {kind === "ticket" && (
        <label>
          Ticket
          <input
            required
            pattern="[^#\s]+#[1-9][0-9]*"
            placeholder="repo#123"
            value={ticket}
            onChange={(e) => setTicket(e.target.value)}
          />
        </label>
      )}
      <div className="row">
        <button type="submit" className="sm" disabled={busy || !reason.trim()}>
          Hold item
        </button>
        <button type="button" className="sm ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
