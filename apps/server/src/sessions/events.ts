import { type Cmux, type CmuxEvent, parseCmuxEvent } from "../runtime/cmux.ts";

/** Makes the event stream's lifecycle change visible to both the Sessions page and sidebar. */
export function applyCmuxSessionEvent(deps: {
  sessions: { refreshMembership(): Promise<void> };
  bus: { emit(topic: "sessions"): void };
  sidebar: { tick(): Promise<void> };
}): void {
  void deps.sessions.refreshMembership().then(() => {
    deps.bus.emit("sessions");
    void deps.sidebar.tick();
  });
}

export function startCmuxEvents(deps: {
  cmux: Pick<Cmux, "events">;
  cursorFile: string;
  onChange: (event: CmuxEvent) => void;
  retryMs?: number;
  log?: (line: string) => void;
}): { stop(): void } {
  let stopped = false;
  let child: ReturnType<Cmux["events"]> | null = null;
  let delay = deps.retryMs ?? 5000;
  const start = () => {
    if (stopped) return;
    child = deps.cmux.events(deps.cursorFile, (line) => {
      const event = parseCmuxEvent(line);
      if (event !== null) deps.onChange(event);
    });
    child.ended.then(() => {
      if (stopped) return;
      const retry = setTimeout(start, delay);
      retry.unref?.();
      delay = Math.min(delay * 2, 60_000);
    });
  };
  start();
  return {
    stop() {
      stopped = true;
      child?.stop();
    },
  };
}
