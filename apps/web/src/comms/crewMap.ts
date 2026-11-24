import { createCrewMapImpl } from "./crewMapImpl.ts";

/** What the map reads: one picture of the crew at `now`. Shape from docs/prototype/comms-crew-map-live.html. */
export type MapRole =
  | "flight"
  | "server"
  | "web"
  | "review"
  | "plan"
  | "operator"
  | "helper"
  | "hub";
export type MapState = "running" | "idle" | "stopped" | "unknown" | "nodata";
export type MapHold = "blocked" | "stalled" | "error";
export type MapParticipant = {
  id: string;
  label: string;
  role: MapRole;
  kind: "seat" | "operator" | "helper" | "hub";
  state: MapState;
  /** Stuck, not stopped: blocked, stalled or in error. Drawn as a red square and named in words. */
  hold?: MapHold | null;
  stateSince?: number | null;
  ticket?: string | null;
  ticketTitle?: string | null;
  contextTokens?: number | null;
  /** This seat's own limit; the map falls back to the snapshot's. */
  contextLimit?: number | null;
  liveTool?: string | null;
  tokensPerMinute?: number | null;
};
export type MapMessage = {
  id: string;
  at: number;
  from: string;
  to: string;
  ask?: boolean;
  ticket?: string | null;
  text: string;
};
export type MapWait = {
  id: string;
  from: string;
  to: string;
  since: number;
  followUpAt?: number | null;
  text: string;
};
export type MapSnapshot = {
  now: number;
  source: { kind: "live" | "demo" | "replay"; label: string; ok: boolean; error?: string };
  contextLimit?: number;
  participants: MapParticipant[];
  messages: MapMessage[];
  /** Only asks under a day old. */
  waits: MapWait[];
  /** Asks a day old or more: one quiet count, never drawn. */
  olderWaits: number;
  olderWaitsOldest?: number | null;
  history?: { tokensPerMinute?: Array<[number, number]> };
};
export type MapView = "panel" | "full" | "ambient";
export type MapSelection = { type: "seat"; id: string } | { type: "link"; a: string; b: string };
export type MapPins = Partial<Record<MapView, Record<string, [number, number]>>>;
export type MapOptions = {
  view?: MapView;
  contextLimit?: number;
  chart?: boolean;
  sweep?: boolean;
  hubNotices?: boolean;
  reducedMotion?: "auto" | boolean;
  catchUp?: boolean;
  pins?: MapPins | null;
  onPinsChange?: (pins: MapPins) => void;
  onSelect?: (selection: MapSelection | null) => void;
  onOpenConversation?: (selection: MapSelection) => void;
  onViewChange?: (view: MapView) => void;
};
export type CrewMap = {
  update: (snapshot: MapSnapshot) => void;
  setView: (view: MapView) => void;
  select: (id: string | null) => void;
  setOptions: (options: MapOptions) => void;
  resetPlaces: () => void;
  getPins: () => MapPins;
  colorOf: (id: string) => string | null;
  destroy: () => void;
  /** For tests: what the map holds now (moving lights, link heat, owed replies, each seat's words). */
  _probe: () => {
    comets: Array<{
      from: string;
      to: string;
      color: string;
      start: { x: number; y: number };
      end: { x: number; y: number };
    }>;
    lanes: Array<{ from: string; to: string; heat: number }>;
    waits: Array<{ id: string; from: string; to: string }>;
    older: number;
    labels: Array<{ id: string; x: number; y: number; w: number; h: number }>;
    dots: Array<{ id: string; x: number; y: number; r: number }>;
    seats: Array<{
      id: string;
      name: string;
      state: MapState;
      hold: MapHold | "";
      ctx: number;
      lim: number;
      tool: string;
      sub: string;
      x: number;
      y: number;
      color: string;
    }>;
  };
  /** For tests: where every seat is, and what the map is doing. */
  _state: () => {
    halted: boolean;
    mode: string;
    view: MapView;
    sel: string;
    comets: number;
    warm: number;
    lanes: number;
    active: number;
    tier: string;
    labBad: string[];
    seats: Array<{ id: string; x: number; y: number; hx: number; hy: number; r: number }>;
  };
};

/** Builds the living crew map inside `container`; `destroy` removes everything it made. */
export const createCrewMap: (container: HTMLElement, options?: MapOptions) => CrewMap =
  createCrewMapImpl;
