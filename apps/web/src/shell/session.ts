/**
 * The header's session filter: `all`, or one crew session id.
 * It filters Overview agent and Activity rows, Board cards, the Agent
 * picker, j/k, Comms threads, and Setup's Sessions panels and Loops rows (catalogue §1.1 item 2).
 */
import type { ConfigView, Crew, CrewRow } from "@mc/core";
import { useMemo } from "react";
import { RESOURCES, useResource } from "../data.ts";
import { store, useStore } from "./store.ts";

export const SESSION_ALL = "all";

const session = store<string>(SESSION_ALL);

export const getSession = (): string => session.get();
export const setSession = (s: string): void => session.set(s);

export function useSession(): [string, (s: string) => void] {
  return [useStore(session), setSession];
}

/** Whether an id is in view under the filter. */
export const inSession = (s: string, id: string | null): boolean => s === SESSION_ALL || s === id;

/** Config includes empty sessions; crew can still name a session while config catches up. */
export function useSessions(config?: ConfigView) {
  const loaded = useResource<ConfigView>(RESOURCES.config).data;
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const configured = config ?? loaded;
  return useMemo(() => {
    const sessions = new Map(
      (configured?.crew?.sessions ?? []).map((s) => [s.id, { id: s.id, repoId: s.repoId }]),
    );
    for (const row of crew?.rows ?? []) {
      if (row.sessionId !== null && !sessions.has(row.sessionId))
        sessions.set(row.sessionId, { id: row.sessionId, repoId: row.repoId });
    }
    return [...sessions.values()];
  }, [configured, crew]);
}

/** Observed loops have no crew session and follow its repo instead. */
export function inCrewSession(
  session: string,
  row: Pick<CrewRow, "sessionId" | "repoId">,
  repo: string = session,
): boolean {
  return row.sessionId === null ? inSession(repo, row.repoId) : inSession(session, row.sessionId);
}

/** Repo-only data follows the chosen session's repo; agents follow its session id. */
export function useSessionScope(config?: ConfigView) {
  const [session] = useSession();
  const sessions = useSessions(config);
  const repo = sessions.find((s) => s.id === session)?.repoId ?? session;
  return {
    session,
    repo,
    inView: (row: Pick<CrewRow, "sessionId" | "repoId">) => inCrewSession(session, row, repo),
    inRepo: (id: string) => inSession(repo, id),
  };
}

export const resetSession = (): void => session.set(SESSION_ALL);
