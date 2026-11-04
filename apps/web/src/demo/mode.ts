/**
 * Demo mode, the part that lives in the main chunk: the flag, the words, the refusal and the fake
 * stream. The simulator and the seed load as separate chunks, only once Demo is on.
 */
import type { StreamSource } from "../api.ts";
import { type Store, store, useStore } from "../shell/store.ts";
import { DEMO_KEY, readSessionBool, setKeyScope, writeSessionBool } from "../storage.ts";

export const DEMO_REFUSED = "Demo mode: nothing was sent to the hub. Switch to Live to do this.";
export const DEMO_UNAVAILABLE = "Demo data could not load. Switch to Live or reload the page.";
export const DEMO_MARKER_TEXT =
  "Simulated crew. Nothing here is real, and nothing is sent to the hub.";
export const DEMO_NO_DATA = "Demo has no data for this view.";

/** The prefix Demo gives every remembered choice but the theme. */
export const DEMO_KEY_SCOPE = "mc-demo:";

export const demoMode: Store<boolean> = store(readSessionBool(DEMO_KEY) === true);
setKeyScope(demoMode.get() ? DEMO_KEY_SCOPE : "");

/** Read at call time by every network door. */
export const isDemo = (): boolean => demoMode.get();
export const useDemo = (): boolean => useStore(demoMode);

export function setDemo(on: boolean): void {
  writeSessionBool(DEMO_KEY, on);
  setKeyScope(on ? DEMO_KEY_SCOPE : "");
  demoMode.set(on);
}

/** The EventSource ready states (fixed by the standard), so no real EventSource is needed. */
const OPEN = 1;
const CLOSED = 2;

/** An 1×1 PNG, the answer to a review-image read in Demo. */
export const DEMO_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVEsAAAAASUVORK5CYII=";

export const demoRefusal = (): Response =>
  new Response(JSON.stringify({ error: DEMO_REFUSED }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });

const unavailable = (): Response =>
  new Response(JSON.stringify({ error: DEMO_UNAVAILABLE }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });

/** Answer a Demo request: writes are refused here, reads come from the lazily loaded source. */
export async function demoSend(path: string, init: RequestInit): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET") return demoRefusal();
  if (path.startsWith("/api/qa/review-shots/") || path.startsWith("/api/qa-report-assets/")) {
    const bytes = Uint8Array.from(atob(DEMO_PNG_BASE64), (c) => c.charCodeAt(0));
    return new Response(bytes, { status: 200, headers: { "content-type": "image/png" } });
  }
  try {
    const source = await import("./source.ts");
    return source.answer(path);
  } catch {
    return unavailable();
  }
}

/** What the fake stream hands the simulator to deliver an event with. */
type Emit = (type: "changed" | "map", data: unknown) => void;

/** An `EventTarget` that behaves as the hub's stream, fed by the simulator's timer. */
export function demoStream(path: string): StreamSource {
  const target = new EventTarget() as EventTarget & { readyState: number; close(): void };
  let stop: (() => void) | undefined;
  target.readyState = 0;
  target.close = () => {
    target.readyState = CLOSED;
    stop?.();
    stop = undefined;
  };
  const emit: Emit = (type, data) => {
    if (target.readyState !== OPEN) return;
    target.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
  };
  import("./simulator.ts").then(
    (sim) => {
      if (target.readyState === CLOSED) return;
      target.readyState = OPEN;
      target.dispatchEvent(new Event("open"));
      stop = sim.connect(path, emit);
    },
    () => {
      if (target.readyState === CLOSED) return;
      target.readyState = CLOSED;
      target.dispatchEvent(new Event("error"));
    },
  );
  return target as unknown as StreamSource;
}
