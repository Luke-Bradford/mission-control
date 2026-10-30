import type { CommsMessage } from "@mc/core";
import { useMemo, useState } from "react";
import { apiGet } from "../api.ts";

/** A Comms read that pages: `hasMore` says older messages remain (`inboxHasMore` for the inbox). */
export interface CommsPage {
  messages?: CommsMessage[];
  inbox?: CommsMessage[];
  hasMore?: boolean;
  inboxHasMore?: boolean;
}

interface Paging {
  path: string | null;
  older: CommsMessage[];
  /** What the last older page said; null before any page was loaded. */
  hasMore: boolean | null;
  loading: boolean;
  error: string | null;
}

const NONE: Paging = { path: null, older: [], hasMore: null, loading: false, error: null };

export interface OlderMessages {
  /** The older pages loaded so far, then the live newest page. */
  messages: CommsMessage[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  load: () => void;
}

/** The path with `before=<message id>`, whether or not it has a query already. */
export function olderPath(path: string, before: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}before=${encodeURIComponent(before)}`;
}

/**
 * The newest page a Comms route sent (`live`, refetched as messages arrive) with the older pages
 * the reader asked for in front of it. `field` is the list the view shows: `inbox` or `messages`.
 */
export function useOlderMessages(
  path: string | null,
  live: CommsMessage[],
  liveHasMore: boolean,
  field: "messages" | "inbox",
): OlderMessages {
  // What was loaded or failed belongs to one route; another route starts clean, and a reply for
  // a route that is no longer shown is dropped.
  const [state, setState] = useState<Paging>(NONE);
  const cur = path !== null && state.path === path ? state : NONE;
  // Stable while nothing changes: effects keyed on the messages must not run on every render.
  const messages = useMemo(() => {
    if (cur.older.length === 0) return live;
    const liveIds = new Set(live.map((m) => m.id));
    return [...cur.older.filter((m) => !liveIds.has(m.id)), ...live];
  }, [cur.older, live]);
  const load = () => {
    const oldest = messages[0];
    if (path === null || oldest === undefined || cur.loading) return;
    setState({ ...cur, path, loading: true, error: null });
    apiGet<CommsPage>(olderPath(path, oldest.id))
      .then((page) =>
        setState((prev) =>
          prev.path === path
            ? {
                path,
                older: [...(page[field] ?? []), ...prev.older],
                hasMore: (field === "inbox" ? page.inboxHasMore : page.hasMore) ?? false,
                loading: false,
                error: null,
              }
            : prev,
        ),
      )
      .catch(() =>
        setState((prev) =>
          prev.path === path
            ? { ...prev, loading: false, error: "Could not load older messages." }
            : prev,
        ),
      );
  };
  return {
    messages,
    hasMore: cur.hasMore ?? liveHasMore,
    loading: cur.loading,
    error: cur.error,
    load,
  };
}
