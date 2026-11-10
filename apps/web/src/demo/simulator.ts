/**
 * The simulated crew. One scripted scene (`DEMO_SCENE`) plays beat by beat on a single timer, so the
 * same scene plays each time. The state starts from the seed, moved to the present, and is dropped
 * when the last stream disconnects. This module is its own chunk, loaded only once Demo is on.
 */
import type {
  ActivityRow,
  AgentDetailView,
  AgentStream,
  CommsMessage,
  CrewRow,
  LimitRow,
  OverviewSummary,
  Topic,
} from "@mc/core";
import {
  boardItems,
  commsMessage,
  DEMO_REPO,
  DEMO_TICKETS,
  type DemoTicket,
  openPrs,
  pipelineStages,
  prFlowView,
  qaQueue,
  ticketHistory,
} from "../../test/demoSeedPages.ts";
import { NOW } from "../../test/fixtures.ts";
import { demoSeed } from "../../test/overviewDensityFixtures.ts";
import { shiftTimes } from "./shift.ts";

export const DEMO_BEAT_MS = 4000;
const SCENE_BEATS = 45;
const CREW_PATH = "/api/crew?shape=summary";
const DOCK_PATH = "/api/agents/flight-1/stream?limit=20";

/** Everything the simulator answers from, and what its beats change. */
export interface DemoState {
  api: Record<string, unknown>;
  tickets: DemoTicket[];
  /** The beat last played; -1 before the first. */
  beat: number;
}

export interface DemoBeat {
  topics: readonly Topic[];
  /** Change `state` as of `at`. */
  apply(state: DemoState, at: number): void;
}

type Emit = (type: "changed", data: unknown) => void;
interface Subscriber { emit: Emit; }

let seed: ReturnType<typeof demoSeed> | undefined;
let state: DemoState | undefined;
let beatMs = DEMO_BEAT_MS;
let timer: ReturnType<typeof setTimeout> | undefined;
const subscribers = new Set<Subscriber>();

/** Harness only: a faster scene, so a test sees it move. */
export function setBeatMs(ms: number): void {
  beatMs = ms;
  if (timer === undefined) return;
  clearTimeout(timer);
  timer = undefined;
  schedule();
}

const wholeMinutes = (ms: number): number => Math.round(ms / 60_000) * 60_000;

function fresh(): DemoState {
  seed ??= demoSeed();
  // A whole number of minutes, so the per-minute token buckets still start on minute marks.
  const api = shiftTimes(seed.api, NOW, wholeMinutes(Date.now() - NOW));
  return { api, tickets: DEMO_TICKETS.map((t) => ({ ...t })), beat: -1 };
}

/** The live state, started at beat 0 if nothing has read it yet. */
export function getState(): DemoState {
  state ??= fresh();
  return state;
}

// ---- The scene -----------------------------------------------------------------------------

interface SeatPhase {
  state: CrewRow["hudState"];
  phase: NonNullable<CrewRow["loop"]>["phase"];
  step: string | null;
  text: string;
  wait: NonNullable<CrewRow["loop"]>["wait"];
}
/** One seat's turn through its loop; the scene walks each seat along it. */
const PHASES: readonly SeatPhase[] = [
  { state: "running", phase: "working", step: "build", text: "Building", wait: null },
  { state: "running", phase: "working", step: "build", text: "Building", wait: null },
  { state: "running", phase: "ci", step: "checks", text: "Checks running", wait: "ci" },
  { state: "waiting", phase: "review", step: "review", text: "In review", wait: "retro" },
  { state: "parked", phase: "parked", step: null, text: "Waiting for the test lock", wait: "lock" },
  { state: "running", phase: "working", step: "build", text: "Building", wait: null },
];

const WORKERS = ["dev-1", "dev-2", "dev-3", "dev-5", "dev-6", "dev-7", "dev-8", "dev-10"] as const;
const TOOLS = ["Read", "Edit", "Bash", "Grep", "Write"] as const;
const TICKET_MOVES: readonly { n: number; to: DemoTicket["stage"]; seat: string | null }[] = [
  { n: 107, to: "review", seat: "dev-9" },
  { n: 201, to: "building", seat: "dev-7" },
  { n: 101, to: "checks", seat: "dev-1" },
  { n: 108, to: "merged", seat: null },
  { n: 202, to: "building", seat: "dev-9" },
  { n: 102, to: "checks", seat: "dev-2" },
  { n: 107, to: "merged", seat: null },
  { n: 103, to: "review", seat: "dev-3" },
  { n: 101, to: "review", seat: "dev-1" },
];

type CommsLink = {
  from: string;
  to: string;
  count: number;
  lastId?: string;
  lastAt?: number;
  lastText?: string;
};

const rowsOf = (s: DemoState): CrewRow[] => (s.api[CREW_PATH] as { rows: CrewRow[] }).rows;
const summaryOf = (s: DemoState): OverviewSummary => s.api["/api/overview"] as OverviewSummary;

function logActivity(s: DemoState, at: number, who: string, text: string, kind: string) {
  const rows = s.api["/api/activity"] as ActivityRow[];
  rows.unshift({
    at,
    kind,
    who,
    text,
    ref: null,
    url: null,
    prs: [],
    status: null,
    summary: null,
  } as ActivityRow);
  rows.length = Math.min(rows.length, 50);
}

function say(s: DemoState, at: number, index: number) {
  const id = 1000 + s.beat * 10 + index;
  const from = WORKERS[(s.beat + index) % WORKERS.length] ?? "dev-1";
  const text = commsMessage(s.beat + index, at).text;
  const message: CommsMessage = commsMessage(id, at, { from, text });
  const crew = s.api["/api/comms/crew"] as { messages: CommsMessage[] };
  crew.messages.push(message);
  if (crew.messages.length > 60) crew.messages.shift();
  const mine = s.api[`/api/comms/agents/${from}`] as { messages: CommsMessage[] } | undefined;
  mine?.messages.push(message);
  logActivity(s, at, from, text, "message");
  const dock = s.api[DOCK_PATH] as {
    events: { id: string; at: number; kind: string; text: string }[];
  };
  dock.events.push({ id: `demo:${id}`, at, kind: "msg", text });
  if (dock.events.length > 20) dock.events.shift();
  // The seat's own page, and the graph of who talks to whom.
  pushEvent(s, from, { id: `demo:${id}`, at, kind: "msg", text });
  bumpLink(s, from, at, text, message.id);
}

type SeatEvent = AgentStream["events"][number];

/** Add an event to a seat's transcript, keeping the last 20. */
function pushEvent(s: DemoState, seat: string, event: SeatEvent) {
  const stream = s.api[`/api/agents/${seat}/stream?limit=20`] as AgentStream | undefined;
  if (!stream) return;
  stream.events.push(event);
  if (stream.events.length > 20) stream.events.shift();
  stream.lastOutputAt = event.at;
}

/** One more message on the pair `from` talks to most (or on its line to FLIGHT). */
function bumpLink(s: DemoState, from: string, at: number, text: string, id: string) {
  const links = (s.api["/api/comms/links"] as { links: CommsLink[] }).links;
  const link = links.find((l) => l.from === from) ?? links[0];
  if (!link) return;
  link.count += 1;
  // The Comms nav counts each seat's contacts from the same pairs.
  for (const [seat, other] of [
    [link.from, link.to],
    [link.to, link.from],
  ] as const)
    for (const key of [`/api/comms/agents/${seat}`, `/api/comms/agents/${seat}?summary=1`]) {
      const body = s.api[key] as { contacts?: { id: string; count: number }[] } | undefined;
      const contact = body?.contacts?.find((c) => c.id === other);
      if (contact) contact.count += 1;
      else body?.contacts?.push({ id: other, count: 1, unread: 0, lastMessage: null } as never);
    }
  link.lastAt = at;
  link.lastText = text;
  link.lastId = id;
}

function work(s: DemoState, at: number) {
  const seat = WORKERS[s.beat % WORKERS.length] ?? "dev-1";
  const tool = TOOLS[s.beat % TOOLS.length] ?? "Read";
  const row = rowsOf(s).find((r) => r.id === seat);
  if (!row) return;
  // The seat moves through its loop: build, checks, review, a wait for the test lock, build again.
  const phase = PHASES[
    Math.floor(s.beat / WORKERS.length + WORKERS.indexOf(seat)) % PHASES.length
  ] as SeatPhase;
  if (row.hudState !== phase.state || row.loop?.phase !== phase.phase) row.stateSince = at;
  row.hudState = phase.state;
  if (row.loop)
    row.loop = {
      ...row.loop,
      phase: phase.phase,
      text: phase.text,
      step: phase.step,
      parked: phase.phase === "parked" ? phase.text : null,
      wait: phase.wait,
      tries:
        phase.step === "review"
          ? { n: 2, max: 3 }
          : phase.step === "checks"
            ? { n: 1, max: 3 }
            : { n: 1, max: 3 },
    };
  row.lastOutputAt = at;
  if (row.digest) {
    row.digest.liveTool = { name: tool, since: at, detail: `src/${seat}/work.ts` };
    row.digest.toolCalls += 1;
    row.digest.lastEventAt = at;
    row.digest.contextTokens = (row.digest.contextTokens ?? 80_000) + 600;
    // The seat's tokens for this minute, which the crew table and its chart read.
    const minute = Math.floor(at / 60_000) * 60_000;
    const bucket = row.digest.minuteTokens.find(([start]) => start === minute);
    if (bucket) bucket[1] += 900;
    else row.digest.minuteTokens.push([minute, 900]);
  }
  if (row.run?.tokens) row.run.tokens.output += 900;
  // The seat's own page: one more tool call in its transcript and its tool counts.
  const detail = `src/${seat}/work.ts`;
  pushEvent(s, seat, {
    id: `${seat}:demo:${s.beat}`,
    at,
    kind: "tool",
    text: `${tool} ${detail}`,
    tool: { name: tool, input: detail, result: "ok", ms: 150, error: false },
  });
  const view = s.api[`/api/agents/${seat}`] as AgentDetailView | undefined;
  if (view) {
    view.row = row;
    if (view.tools.total !== null) view.tools.total += 1;
    const entry = view.tools.byTool.find((t) => t.name === tool);
    if (entry) entry.calls += 1;
    else view.tools.byTool.push({ name: tool, calls: 1, failed: 0 });
  }
}

function burn(s: DemoState) {
  const summary = summaryOf(s);
  const tokens = summary.kpis.tokensPerMin;
  const next = 41_000 + ((s.beat * 2300) % 9000);
  tokens.now = next;
  tokens.series = [...(tokens.series ?? []).slice(1), next];
  summary.kpis.spendToday.usd = Math.round((summary.kpis.spendToday.usd + 0.06) * 100) / 100;
  const spend = summary.kpis.spendToday.series;
  if (spend) summary.kpis.spendToday.series = [...spend.slice(1), 0.12 + (s.beat % 5) / 50];
  if (s.beat % 4 === 0)
    for (const limit of s.api["/api/limits"] as LimitRow[])
      limit.used = Math.min(99, limit.used + 0.4);
  for (const key of Object.keys(s.api))
    if (key.startsWith("/api/telemetry?")) {
      const t = s.api[key] as {
        today: { tokens: number; toolCalls: number; costUsd: number | null };
      };
      t.today.tokens += next;
      t.today.toolCalls += 3;
      if (t.today.costUsd !== null) t.today.costUsd += 0.06;
    }
}

function moveTicket(s: DemoState, at: number, move: (typeof TICKET_MOVES)[number]) {
  const ticket = s.tickets.find((t) => t.n === move.n);
  if (!ticket) return;
  ticket.stage = move.to;
  ticket.seat = move.seat ?? (move.to === "merged" ? null : ticket.seat);
  const shift = wholeMinutes(Date.now() - NOW);
  summaryOf(s).pipeline = pipelineStages(s.tickets).map((stage) => ({
    ...stage,
    oldestAt: stage.count ? at - 40 * 60_000 : null,
    cards: stage.cards.map((c) => ({ ...c, since: at - 60_000 })),
  }));
  s.api[`/api/boards/${DEMO_REPO}`] = boardItems(s.tickets).map((item) => ({
    ...item,
    updatedAt: item.issueNumber === move.n ? at : item.updatedAt + shift,
    createdAt: item.createdAt + shift,
  }));
  const prs = openPrs(s.tickets).map((pr) => ({ ...pr, updatedAt: at }));
  s.api[`/api/repos/${DEMO_REPO}/prs?linked=1&shape=summary`] = prs;
  s.api[`/api/repos/${DEMO_REPO}/prs`] = prs;
  s.api["/api/prs/flow"] = shiftTimes(prFlowView(s.tickets), NOW, shift);
  // The ticket's own page, the QA queue and the seat that took it all follow the move.
  s.api[`/api/tickets/${DEMO_REPO}/${ticket.n}`] = shiftTimes(ticketHistory(ticket), NOW, shift);
  s.api["/api/qa/queue"] = shiftTimes(qaQueue(s.tickets), NOW, shift);
  if (move.to === "building" && move.seat) {
    for (const row of [
      rowsOf(s).find((r) => r.id === move.seat),
      s.api[`/api/crew/${move.seat}`] as CrewRow | undefined,
    ])
      if (row) {
        row.ticket = `${DEMO_REPO}#${ticket.n}`;
        row.ticketTitle = ticket.title;
        row.stateSince = at;
      }
  }
  logActivity(
    s,
    at,
    move.seat ?? "flight-1",
    `${DEMO_REPO}#${move.n} moved to ${move.to}`,
    move.to === "merged" ? "merge" : "run-start",
  );
}

function makeBeat(index: number): DemoBeat {
  const move = index % 5 === 4 ? TICKET_MOVES[Math.floor(index / 5) % TICKET_MOVES.length] : null;
  const topics: Topic[] = ["agents"];
  if (move) topics.push("boards");
  else if (index % 4 === 0) topics.push("limits");
  else if (index % 3 === 0) topics.push("machine");
  return {
    topics,
    apply(s, at) {
      s.beat = index;
      work(s, at);
      burn(s);
      if (index % 2 === 0) say(s, at, 0);
      if (index % 7 === 3) say(s, at, 1);
      if (move) moveTicket(s, at, move);
      return;
    },
  };
}

/** The scene: 45 beats, 4 seconds apart, a 3-minute loop. No randomness. */
export const DEMO_SCENE: readonly DemoBeat[] = Array.from({ length: SCENE_BEATS }, (_, i) =>
  makeBeat(i),
);

// ---- The timer ---------------------------------------------------------------------------------

// Reached through `globalThis`, as data.ts does: the server's type check reads this file too.
type PageDocument = {
  visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};
const pageDocument = (): PageDocument | undefined =>
  (globalThis as { document?: PageDocument }).document;

const hidden = (): boolean => pageDocument()?.visibilityState === "hidden";
const EVERY_TOPIC: readonly Topic[] = ["agents", "boards", "limits", "attention", "machine"];

function tell(topics: readonly Topic[]) {
  for (const sub of [...subscribers]) {
    for (const topic of topics) sub.emit("changed", { topic });
  }
}

/** Play the next beat; at the loop's end, start over from the seed and fire every topic once. */
export function playNext(): void {
  const s = getState();
  const index = s.beat + 1;
  if (index >= SCENE_BEATS) {
    state = fresh();
    tell(EVERY_TOPIC);
    return;
  }
  const beat = DEMO_SCENE[index] as DemoBeat;
  beat.apply(s, Date.now());
  tell(beat.topics);
}

function tick() {
  timer = undefined;
  playNext();
  schedule();
}

function schedule() {
  if (timer !== undefined || subscribers.size === 0 || hidden()) return;
  timer = setTimeout(tick, beatMs);
}

function onVisibility() {
  if (hidden()) {
    clearTimeout(timer);
    timer = undefined;
  } else schedule();
}

/**
 * Join the scene as one stream. The first stream starts it, from beat 0; the last to leave drops
 * the state. `path` is the stream's address: `?map=<repo>` also gets that repo's frames.
 */
export function connect(path: string, emit: Emit): () => void {
  const subscriber: Subscriber = { emit };
  if (subscribers.size === 0) {
    getState();
    pageDocument()?.addEventListener("visibilitychange", onVisibility);
  }
  subscribers.add(subscriber);
  schedule();
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size > 0) return;
    clearTimeout(timer);
    timer = undefined;
    pageDocument()?.removeEventListener("visibilitychange", onVisibility);
    state = undefined;
  };
}
