import type { Cmux, CmuxEvent } from "../runtime/cmux.ts";

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
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const name = event.type ?? event.event ?? event.name;
        if (name === "workspace.created" || name === "workspace.closed")
          deps.onChange({
            kind: name === "workspace.created" ? "created" : "closed",
            workspaceId:
              typeof (event.workspace_id ?? event.workspaceId ?? event.id) === "string"
                ? String(event.workspace_id ?? event.workspaceId ?? event.id)
                : null,
          });
      } catch {
        /* cmux may print non-event diagnostics */
      }
    });
    child.ended.then(() => {
      if (stopped) return;
      setTimeout(start, delay).unref();
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
