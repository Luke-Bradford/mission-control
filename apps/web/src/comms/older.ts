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
  const [older, setOlder] = useState<CommsMessage[]>([]);
  const [olderHasMore, setOlderHasMore] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Stable while nothing changes: effects keyed on the messages must not run on every render.
  const messages = useMemo(() => {
    if (older.length === 0) return live;
    const liveIds = new Set(live.map((m) => m.id));
    return [...older.filter((m) => !liveIds.has(m.id)), ...live];
  }, [older, live]);
  const load = () => {
    const oldest = messages[0];
    if (path === null || oldest === undefined || loading) return;
    setLoading(true);
    setError(null);
    apiGet<CommsPage>(olderPath(path, oldest.id))
      .then((page) => {
        setOlder((prev) => [...(page[field] ?? []), ...prev]);
        setOlderHasMore((field === "inbox" ? page.inboxHasMore : page.hasMore) ?? false);
      })
      .catch(() => setError("Could not load older messages."))
      .finally(() => setLoading(false));
  };
  return { messages, hasMore: olderHasMore ?? liveHasMore, loading, error, load };
}
