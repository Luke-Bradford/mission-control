/**
 * The header's session filter: `all`, or one repo id. A session is a repo until the engine creates
 * real ones (spec §8a.1). It filters Overview agent and Activity rows, Board cards, the Agent
 * picker, j/k, Comms threads, and Setup's Sessions panels and Loops rows (catalogue §1.1 item 2).
 */
import { store, useStore } from "./store.ts";

export const SESSION_ALL = "all";

const session = store<string>(SESSION_ALL);

export const getSession = (): string => session.get();
export const setSession = (s: string): void => session.set(s);

export function useSession(): [string, (s: string) => void] {
  return [useStore(session), setSession];
}

/** Whether something in `repoId` is in view under the filter. */
export const inSession = (s: string, repoId: string): boolean => s === SESSION_ALL || s === repoId;

export const resetSession = (): void => session.set(SESSION_ALL);
