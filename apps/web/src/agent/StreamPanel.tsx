import {
  type ActivityRow,
  type AgentStream,
  BACKGROUND_STALL_MS,
  type ConfigView,
  type CrewRow,
  type GuardHitsView,
  HUD_STATE_LABEL,
  type RunLoop,
  STALL_MS,
  type StreamEvent,
  type StreamKind,
} from "@mc/core";
import { type FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSecond } from "../clock.ts";
import { agentComms, commsKeys, commsLine, MentionText } from "../comms/messages.tsx";
import type { ComposerPrefill } from "../comms/model.ts";
import { useTestLock } from "../components/LockLines.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { callSign, seatTurn } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { dur, hhmm, mss } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { Seg } from "../hud/Seg.tsx";
import { useSeatName } from "../seatName.ts";
import { toast } from "../shell/Toast.tsx";
import { reviewPark, reviewParkSha } from "./reviewPark.tsx";
import { messageRun, messageSeat, seatError } from "./seat.ts";
import { type Relativise, relativiser, toolResult, toolTarget } from "./toolTarget.ts";

const DASH = "—";
/**
 * The composer hint's id, which the input's aria-describedby points at. Fixed like the prototype's
 * `agentInput`: the Agent page renders a single composer, so the id is unique.
 */
const HINT_ID = "agentHint";
/** Within this of the bottom counts as at the bottom (following new events). */
const NEAR_BOTTOM_PX = 40;

type Filter = "all" | "talk" | "think" | "tool" | "guard";

const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "talk", label: "Messages" },
  { value: "think", label: "Thinking" },
  { value: "tool", label: "Tools" },
  { value: "guard", label: "Guard" },
];

/** A message to or from the seat (`/api/activity`), shown in the transcript's time order. */
type A2aRow = { kind: "a2a"; at: number; text: string; key: string };
/** A guard hit on this run (`/api/guard/hits`), shown in the transcript's time order. */
type GuardRow = { kind: "guard"; at: number; text: string; key: string };
type TimedRow = A2aRow | GuardRow;
type StreamRow = StreamEvent | TimedRow;
type RowKind = StreamKind | "a2a" | "guard";

const NO_GUARD_HITS = "No guard hits in this run.";

/** Which kinds each filter shows. */
const SHOWS: Record<Filter, readonly RowKind[] | null> = {
  all: null,
  talk: ["op", "msg", "a2a", "sys"],
  think: ["think"],
  tool: ["tool"],
  guard: ["guard"],
};

/**
 * Who each kind is. **Decision:** the loop's prompt reads `prompt`, not the mockup's `you`: it is
 * the loop's message, not the operator's.
 */
const WHO: Record<RowKind, string> = {
  a2a: "agents",
  guard: "guard",
  op: "prompt",
  think: "thinking",
  tool: "tool",
  msg: "to you",
  sys: "system",
};

/** The row class (the mockup's: `op` is styled as `you`). */
const CLS: Record<RowKind, string> = {
  a2a: "a2a",
  guard: "sys",
  op: "you",
  think: "think",
  tool: "tool",
  msg: "msg",
  sys: "sys",
};

function ToolText({ tool, rel }: { tool: NonNullable<StreamEvent["tool"]>; rel: Relativise }) {
  const took = tool.ms === null ? DASH : dur(tool.ms);
  const result = tool.result === null ? "no result yet" : tool.result;
  const target = toolTarget(tool.input, rel);
  return (
    <details>
      <summary>
        <span className="tn">{tool.name}</span>
        {target && ` ${target}`}
        <span className="tres">
          {" · "}
          {toolResult(result, tool.error, rel)}
        </span>
      </summary>
      <pre>{`input: ${tool.input}\nresult: ${tool.error ? "error: " : ""}${result}\nduration: ${took}`}</pre>
    </details>
  );
}

/** Kinds whose text is the agent's (or the loop's prompt) own Markdown. */
const MARKDOWN: readonly StreamKind[] = ["op", "msg"];

/**
 * The transcript with the seat's messages and guard hits in: each goes before the first event with
 * a later `at`; an event without an `at` keeps its place, a tie goes after the event, leftovers go
 * last. `timed` is in time order.
 */
function mergeTimed(events: StreamEvent[], timed: TimedRow[]): StreamRow[] {
  const out: StreamRow[] = [];
  let next = 0;
  for (const ev of events) {
    while (ev.at !== null && next < timed.length && (timed[next] as TimedRow).at < ev.at) {
      out.push(timed[next++] as TimedRow);
    }
    out.push(ev);
  }
  out.push(...timed.slice(next));
  return out;
}

function EventRow({ ev, tz, rel }: { ev: StreamRow; tz: string | null; rel: Relativise }) {
  return (
    <div className={`ev ${CLS[ev.kind]}`}>
      <span className="at num">{ev.at !== null && tz ? hhmm(ev.at, tz) : DASH}</span>
      <span className="who">{WHO[ev.kind]}</span>
      <div className="txt">
        {ev.kind === "a2a" ? (
          <MentionText text={ev.text} />
        ) : ev.kind === "guard" ? (
          ev.text
        ) : ev.kind === "tool" && ev.tool ? (
          <ToolText tool={ev.tool} rel={rel} />
        ) : MARKDOWN.includes(ev.kind) ? (
          <Markdown text={ev.text} />
        ) : (
          ev.text
        )}
      </div>
    </div>
  );
}

/**
 * The live call bar: the running tool and its time, only while the latest run is running (a
 * tool_use left open by an ended run is not live); a stalled agent's bar says since when nothing
 * was written; a waiting run names its queued full suite and the lock holder.
 */
function LiveCall({ row, tz }: { row: CrewRow; tz: string | null }) {
  const lock = useTestLock();
  const running = row.run?.status === "running";
  const waiting = running ? lock?.waiting.find((w) => w.runId === row.run?.id) : undefined;
  const live = running ? (row.digest?.liveTool ?? null) : null;
  const stalled = running && row.hudState === "stalled";
  if (!waiting && !live && !stalled) return <div id="liveCall" />;
  return <TickingLiveCall row={row} tz={tz} />;
}

function TickingLiveCall({ row, tz }: { row: CrewRow; tz: string | null }) {
  const now = useSecond();
  const nameOf = useSeatName();
  const lock = useTestLock();
  const running = row.run?.status === "running";
  const waiting = running ? lock?.waiting.find((w) => w.runId === row.run?.id) : undefined;
  const live = running ? (row.digest?.liveTool ?? null) : null;
  const stalled = running && row.hudState === "stalled";
  // The waiting Bash call is still the live tool while its hook waits for the lock: waiting wins.
  if (waiting && lock?.holder) {
    return (
      <div id="liveCall">
        <div className="livecall">
          {`⏸ Waiting for the test lock: ${row.repoId} full suite (${waiting.command}) ${mss(now - waiting.since)} behind ${nameOf(lock.holder.seatId)}`}
        </div>
      </div>
    );
  }
  if (!live && !stalled) return <div id="liveCall" />;
  const since = row.lastOutputAt;
  return (
    <div id="liveCall">
      <div className={stalled ? "livecall stuck" : "livecall"}>
        <span aria-hidden="true">▶</span>
        <span className="t" title={live ? live.name : "no tool running"}>
          {live ? live.name : "no tool running"}
        </span>
        {live && <span className="num">{mss(now - live.since)}</span>}
        <span className="xs">
          {stalled
            ? `no output since ${since !== null && tz ? hhmm(since, tz) : DASH} · stall flagged at ${mss(row.digest?.background.length ? BACKGROUND_STALL_MS : STALL_MS)}`
            : "elapsed"}
        </span>
      </div>
    </div>
  );
}

/** The hint under a crew seat's composer. */
function seatHint(row: CrewRow, vendor?: string): string {
  const call = callSign(row);
  switch (seatTurn(row)) {
    case "running":
      if (vendor === "codex")
        return `Reaches ${call} at its next model step (Codex steer); no new turn starts.`;
      return `Reaches ${call} mid-turn, alongside its next tool result. Smaller models can ignore a mid-turn note; use Interrupt and send if it matters.`;
    case "idle":
      return `${call} is ${HUD_STATE_LABEL[row.hudState].toLowerCase()}; your message starts its next turn.`;
    case "none":
      return `${call} has no live session; start it on a ticket from the Board.`;
  }
}

/**
 * Message a crew seat; an observed loop keeps the disabled composer and its fixed line.
 * `onSent` runs once the hub has taken the message.
 */
export function SeatComposer({
  row,
  placeholder,
  onSent,
  prefill,
  onPrefillConsumed,
}: {
  row: CrewRow;
  placeholder?: string;
  onSent?: () => void;
  prefill?: ComposerPrefill;
  onPrefillConsumed?: (token: number) => void;
}) {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const used = useRef<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const vendor = config?.accounts.find((a) => a.id === row.accountId)?.vendor;
  const loopResource = useResource<{ loop: RunLoop | null }>(
    row.run ? RESOURCES.runLoop(row.run.id) : null,
  );
  const loop = loopResource.data?.loop;
  const parkedReview = reviewPark(loop);
  const crew = row.kind === "crew";
  // The crew summary only says that a run is parked. Wait for its authoritative park kind before
  // allowing a message: a review park must use its run route rather than the ordinary seat route.
  const parkKindUnknown =
    row.loop?.phase === "parked" && row.run !== null && loopResource.data === undefined;
  const composerDisabled = !crew || busy || parkKindUnknown;
  const call = callSign(row);
  useEffect(() => {
    if (!prefill || used.current === prefill.token) return;
    used.current = prefill.token;
    setText(prefill.text);
    input.current?.focus();
    onPrefillConsumed?.(prefill.token);
  }, [onPrefillConsumed, prefill]);

  const send = async (interrupt: boolean) => {
    if (text.trim() === "") {
      toast("Type a message first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (parkedReview && row.run) await messageRun(row.run.id, text);
      else await messageSeat(row, text, interrupt);
      setText("");
      toast(`Delivered to ${call}.`);
      onSent?.();
    } catch (e) {
      setError(seatError(e));
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (crew && !busy && !parkKindUnknown) void send(false);
  };

  return (
    <form className="composer" id="agentForm" onSubmit={submit}>
      <input
        id="agentInput"
        ref={input}
        autoComplete="off"
        aria-label="Message this agent"
        aria-describedby={HINT_ID}
        placeholder={
          placeholder ?? (parkedReview ? "Send findings back for rework…" : `Message ${call}…`)
        }
        disabled={composerDisabled}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button type="submit" className="primary" disabled={composerDisabled}>
        {parkKindUnknown
          ? "Loading review findings…"
          : parkedReview
            ? "Send rework message"
            : "Send"}
      </button>
      {!parkedReview && !parkKindUnknown && (
        <button
          type="button"
          className="sm ghost"
          title="Stop the current turn, then send"
          disabled={composerDisabled}
          onClick={() => void send(true)}
        >
          Interrupt and send
        </button>
      )}
      {error && (
        <span className="crit-t s" role="alert">
          {error}
        </span>
      )}
      <span className="hint" id={HINT_ID}>
        {parkKindUnknown
          ? "Loading the park details before a message can be sent."
          : parkedReview
            ? `This sends RETRO's findings on ${reviewParkSha(parkedReview)} back for rework. It does not waive them.`
            : crew
              ? seatHint(row, vendor)
              : `${row.id} is an observed loop: Mission Control watches it and does not message it.`}
      </span>
    </form>
  );
}

/** The Activity panel (catalogue 2.4.4): the latest run's transcript, as inert text. */
export function StreamPanel({ row, tz }: { row: CrewRow; tz: string | null }) {
  const nameOf = useSeatName();
  const [filter, setFilter] = useState<Filter>("all");
  const stream = useResource<AgentStream>(RESOURCES.stream(row.id));
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const rel = useMemo(() => relativiser(config, row.id), [config, row.id]);
  const box = useRef<HTMLDivElement>(null);
  const activity = useResource<ActivityRow[]>(RESOURCES.activity).data;
  const a2a = useMemo<A2aRow[]>(() => {
    const list = row.run ? agentComms(activity ?? [], row.id, row.run.startedAt) : [];
    const keys = commsKeys(list);
    return list.map((c, i) => ({
      kind: "a2a",
      at: c.at,
      text: commsLine(c, row.id, nameOf),
      key: keys[i] as string,
    }));
  }, [activity, row.id, row.run, nameOf]);
  const hits = useResource<GuardHitsView>(RESOURCES.guardHits).data;
  const runId = stream.data?.runId;
  const guard = useMemo<GuardRow[]>(
    () =>
      (hits?.hits ?? [])
        .filter((h) => h.agentId === row.id && h.runId === runId)
        .sort((a, b) => a.at - b.at)
        .map((h) => ({ kind: "guard", at: h.at, text: h.text, key: `guard:${h.id}` })),
    [hits, row.id, runId],
  );
  const timed = useMemo(() => [...a2a, ...guard].sort((a, b) => a.at - b.at), [a2a, guard]);
  const shows = SHOWS[filter];
  const all = mergeTimed(stream.data?.events ?? [], timed);
  const events = all.filter((e) => shows === null || shows.includes(e.kind));
  const count = events.length;

  // Follow the newest event only when the list's content changed and the reader was already at
  // the bottom: a refetch (a fresh object every few seconds) or a reader scrolled up stays put.
  const atBottom = useRef(true);
  const signature = `${stream.data?.runId ?? ""}:${filter}:${count}:${events.at(-1)?.at ?? ""}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` is the trigger
  useLayoutEffect(() => {
    const el = box.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [signature]);
  const onScroll = () => {
    const el = box.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
  };

  let empty: string | null = null;
  if (stream.error && !stream.data) empty = `Could not load the activity: ${stream.error.message}`;
  else if (!stream.data) empty = "Loading…";
  else if (filter === "guard" && count === 0) empty = NO_GUARD_HITS;
  else if (all.length === 0) empty = stream.data.reason ?? "No activity yet.";
  else if (count === 0) empty = "Nothing of this kind in this run.";

  return (
    <Panel
      id="streamP"
      title="Activity"
      sub="messages, thinking, tool calls and checks"
      actions={
        <Seg label="Activity filter" options={FILTERS} value={filter} onChange={setFilter} />
      }
    >
      <LiveCall row={row} tz={tz} />
      <div className="scroll" id="stream" ref={box} onScroll={onScroll}>
        {empty !== null ? (
          <p className="pb s muted">{empty}</p>
        ) : (
          events.map((ev) => (
            <EventRow
              key={ev.kind === "a2a" || ev.kind === "guard" ? ev.key : `${runId}:${ev.id}`}
              ev={ev}
              tz={tz}
              rel={rel}
            />
          ))
        )}
      </div>
      <SeatComposer row={row} />
    </Panel>
  );
}
