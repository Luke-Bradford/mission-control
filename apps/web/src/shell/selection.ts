/**
 * The selected agent: `j`/`k` move it (within the session filter, in crewOrder, wrapping); the
 * Overview highlights its row, and on the Agent page the URL follows it.
 */
import type { AgentId, AttentionItem, CrewRow } from "@mc/core";
import { crewOrder } from "../crew.ts";
import { inCrewSession } from "./session.ts";
import { store, useStore } from "./store.ts";

const selected = store<AgentId | null>(null);

export const getSelectedAgent = (): AgentId | null => selected.get();
export const setSelectedAgent = (id: AgentId | null): void => selected.set(id);

export function useSelectedAgent(): [AgentId | null, (id: AgentId | null) => void] {
  return [useStore(selected), setSelectedAgent];
}

/**
 * The agent `dir` steps from `current` (1 = j, -1 = k) among those in view, wrapping; from none in
 * view, j starts at the first and k at the last. null when no agent is in view.
 */
export function nextAgent(
  rows: CrewRow[],
  items: AttentionItem[],
  session: string,
  current: AgentId | null,
  dir: 1 | -1,
  repo: string | null = session,
): AgentId | null {
  const order = crewOrder(
    rows.filter((r) => inCrewSession(session, r, repo)),
    items,
  );
  const n = order.length;
  if (n === 0) return null;
  const i = order.findIndex((r) => r.id === current);
  const next = i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n;
  return order[next]?.id ?? null;
}

export const resetSelection = (): void => selected.set(null);
