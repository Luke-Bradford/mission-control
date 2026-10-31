import type { CrewRow, RunLoopView } from "@mc/core";
import { hub, RESOURCES, useResource } from "../data.ts";
import { NO_SECTION_DATA, PromptCostBar } from "../hud/PromptCost.tsx";

/** The side panel's Context tab: what the run's prompt cost, by section, from what the hub recorded at its start. */
export function PromptTab({ row }: { row: CrewRow }) {
  const ref = row.run ? RESOURCES.runLoop(row.run.id) : null;
  const loop = useResource<RunLoopView>(ref);
  if (ref === null) return <p className="s muted">No run yet.</p>;
  const view = loop.data;
  if (view === undefined) {
    return loop.error ? (
      <>
        <p className="s crit-t" role="alert">
          Could not load the prompt cost: {loop.error.message}
        </p>
        <button type="button" className="sm" onClick={() => hub.refetch(ref.path)}>
          Retry
        </button>
      </>
    ) : (
      <p className="s muted" role="status">
        Loading…
      </p>
    );
  }
  const latest = view.prompt?.at(-1);
  return (
    <>
      {loop.error && (
        <p className="s crit-t" role="status">
          ▲ Stale · could not refresh: {loop.error.message}
        </p>
      )}
      {latest === undefined ? (
        <p className="s muted">{NO_SECTION_DATA}</p>
      ) : (
        <PromptCostBar cost={latest} />
      )}
    </>
  );
}
