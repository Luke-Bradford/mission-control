/**
 * The simulated crew. One scripted scene (`DEMO_SCENE`) plays beat by beat on a single timer, so the
 * same scene plays each time. The state starts from the seed, moved to the present, and is dropped
 * when the last stream disconnects. This module is its own chunk, loaded only once Demo is on.
 */
import type {
  ActivityRow,
  CommsMessage,
  CrewRow,
  LimitRow,
  MapDelta,
  MapSnapshot,
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
} from "../../test/demoSeedPages.ts";
import { NOW } from "../../test/fixtures.ts";
import { demoSeed } from "../../test/overviewDensityFixtures.ts";
import { applyDelta } from "../map/deltas.ts";
import { shiftTimes } from "./shift.ts";

export const DEMO_BEAT_MS = 4000;
const SCENE_BEATS = 45;
const MAP_PATH = `/api/repos/${DEMO_REPO}/map`;
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
  /** Change `state` as of `at`; returns the Map frames this beat sends, with their `seq` set. */
  apply(state: DemoState, at: number): MapDelta[];
}

type Emit = (type: "changed" | "map", data: unknown) => void;
interface Subscriber {
  repo: string | null;
  emit: Emit;
}

let seed: ReturnType<typeof demoSeed> | undefined;
let state: DemoState | undefined;
/** The Map's frame counter. It only rises, so a restarted scene never replays an old `seq`. */
let mapSeq = 0;
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

function fresh(): DemoState {
  seed ??= demoSeed();
  const api = shiftTimes(seed.api, NOW, Date.now() - NOW);
  (api[MAP_PATH] as MapSnapshot).seq = mapSeq;
  return { api, tickets: DEMO_TICKETS.map((t) => ({ ...t })), beat: -1 };
}

/** The live state, started at beat 0 if nothing has read it yet. */
export function getState(): DemoState {
  state ??= fresh();
  return state;
}

// ---- The scene -----------------------------------------------------------------------------

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

const rowsOf = (s: DemoState): CrewRow[] => (s.api[CREW_PATH] as { rows: CrewRow[] }).rows;
const summaryOf = (s: DemoState): OverviewSummary => s.api["/api/overview"] as OverviewSummary;
const snapshotOf = (s: DemoState): MapSnapshot => s.api[MAP_PATH] as MapSnapshot;

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
}

function work(s: DemoState, at: number) {
  const seat = WORKERS[s.beat % WORKERS.length] ?? "dev-1";
  const tool = TOOLS[s.beat % TOOLS.length] ?? "Read";
  const row = rowsOf(s).find((r) => r.id === seat);
  if (!row) return;
  row.hudState = "running";
  row.stateSince = at;
  row.lastOutputAt = at;
  if (row.digest) {
    row.digest.liveTool = { name: tool, since: at, detail: `src/${seat}/work.ts` };
    row.digest.toolCalls += 1;
    row.digest.lastEventAt = at;
    row.digest.contextTokens = (row.digest.contextTokens ?? 80_000) + 600;
  }
  if (row.run?.tokens) row.run.tokens.output += 900;
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
  const shift = Date.now() - NOW;
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
  logActivity(
    s,
    at,
    move.seat ?? "flight-1",
    `${DEMO_REPO}#${move.n} moved to ${move.to}`,
    move.to === "merged" ? "merge" : "run-start",
  );
}

type Frame = {
  [K in MapDelta["type"]]: Omit<Extract<MapDelta, { type: K }>, "seq">;
}[MapDelta["type"]];

/** A frame for the Map, applied to the state so a refetch agrees with the stream. */
function frame(s: DemoState, delta: Frame): MapDelta {
  const snapshot = snapshotOf(s);
  const full = { ...delta, seq: snapshot.seq + 1 } as MapDelta;
  const next =
    full.type === "edit" || full.type === "invalidate"
      ? { ...snapshot, seq: full.seq }
      : (applyDelta(snapshot, full, Date.now()) ?? { ...snapshot, seq: full.seq });
  s.api[MAP_PATH] = next;
  mapSeq = next.seq;
  return full;
}

function mapBeat(s: DemoState, at: number): MapDelta[] {
  const seat = WORKERS[(s.beat >> 1) % WORKERS.length] ?? "dev-1";
  const tree = snapshotOf(s).tree;
  const fileAt = (beat: number) => tree[(beat * 7) % tree.length]?.path ?? "src/app/module-1.ts";
  if (s.beat % 2 === 0) {
    const file = fileAt(s.beat);
    return [
      frame(s, {
        type: "call.start",
        seat,
        id: `call-${s.beat}`,
        since: at,
        tool: "Edit",
        detail: file,
        files: [file],
        writeTok: 40 + s.beat,
      }),
    ];
  }
  const file = fileAt(s.beat - 1);
  return [
    frame(s, {
      type: "call.end",
      seat,
      id: `call-${s.beat - 1}`,
      at,
      files: [file],
      resultTok: 12,
      error: false,
      refused: false,
      why: null,
      tests: null,
    }),
    frame(s, { type: "edit", seat, file, add: 3 + (s.beat % 7), rem: 1 }),
    frame(s, { type: "diff", seat, file, add: 6 + s.beat, rem: 2 }),
  ];
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
      return mapBeat(s, at);
    },
  };
}

/** The scene: 45 beats, 4 seconds apart, a 3-minute loop. No randomness. */
export const DEMO_SCENE: readonly DemoBeat[] = Array.from({ length: SCENE_BEATS }, (_, i) =>
  makeBeat(i),
);

// ---- The timer ---------------------------------------------------------------------------------

const hidden = (): boolean => document.visibilityState === "hidden";
const EVERY_TOPIC: readonly Topic[] = ["agents", "boards", "limits", "attention", "machine"];

function tell(topics: readonly Topic[], deltas: readonly MapDelta[]) {
  for (const sub of [...subscribers]) {
    for (const topic of topics) sub.emit("changed", { topic });
    if (sub.repo === DEMO_REPO) for (const delta of deltas) sub.emit("map", delta);
  }
}

/** Play the next beat; at the loop's end, start over from the seed and fire every topic once. */
export function playNext(): void {
  const s = getState();
  const index = s.beat + 1;
  if (index >= SCENE_BEATS) {
    // The Map's `seq` carries on from where it was, and an invalidate makes it refetch.
    state = fresh();
    tell(EVERY_TOPIC, [frame(state, { type: "invalidate" })]);
    return;
  }
  const beat = DEMO_SCENE[index] as DemoBeat;
  tell(beat.topics, beat.apply(s, Date.now()));
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
  const repo = new URL(path, "http://demo.invalid").searchParams.get("map");
  const subscriber: Subscriber = { repo, emit };
  if (subscribers.size === 0) {
    getState();
    document.addEventListener("visibilitychange", onVisibility);
  }
  subscribers.add(subscriber);
  schedule();
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size > 0) return;
    clearTimeout(timer);
    timer = undefined;
    document.removeEventListener("visibilitychange", onVisibility);
    state = undefined;
  };
}
