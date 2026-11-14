import type { AgentStream, CrewRow, LiveTask } from "@mc/core";
import { RESOURCES, useResource } from "../data.ts";

const NONE: LiveTask[] = [];

/**
 * The seat's own task list for its current run: Claude's task tools or Codex plan updates,
 * replayed from its stream (the same read the activity list uses). None without a run.
 */
export function usePlan(row: Pick<CrewRow, "id" | "run">): LiveTask[] {
  const stream = useResource<AgentStream>(row.run ? RESOURCES.stream(row.id) : null);
  return row.run && stream.data?.runId === row.run.id ? (stream.data.tasks ?? NONE) : NONE;
}
