import type { AgentStream, StreamEvent } from "@mc/core";
import { useMemo, useState } from "react";
import { apiGet } from "../api.ts";

const NO_EVENTS: StreamEvent[] = [];

export interface OlderEvents {
  /** The stream with the older pages loaded so far in front of its newest page. */
  stream: AgentStream | undefined;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  load: () => void;
}

/**
 * A stream's newest page (refetched as events arrive) with the older pages the reader asked for
 * in front of it, each `?before=` the first event's id.
 */
export function useOlderEvents(path: string | null, live: AgentStream | undefined): OlderEvents {
  const [older, setOlder] = useState<{ runId: string | null; events: StreamEvent[] }>({
    runId: null,
    events: [],
  });
  const [olderHasMore, setOlderHasMore] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A new run starts a new stream: what was loaded before it no longer belongs.
  const kept = live && older.runId === live.runId ? older.events : NO_EVENTS;
  const events = useMemo(() => {
    const liveEvents = live?.events ?? [];
    if (kept.length === 0) return liveEvents;
    const liveIds = new Set(liveEvents.map((e) => e.id));
    return [...kept.filter((e) => !liveIds.has(e.id)), ...liveEvents];
  }, [kept, live?.events]);
  const hasMore =
    kept.length > 0 && olderHasMore !== null ? olderHasMore : (live?.hasMore ?? false);
  const load = () => {
    const first = events[0];
    if (path === null || live === undefined || first === undefined || loading) return;
    setLoading(true);
    setError(null);
    apiGet<AgentStream>(
      `${path}${path.includes("?") ? "&" : "?"}before=${encodeURIComponent(first.id)}`,
    )
      .then((page) => {
        setOlder({ runId: live.runId, events: [...page.events, ...kept] });
        setOlderHasMore(page.hasMore ?? false);
      })
      .catch(() => setError("Could not load older events."))
      .finally(() => setLoading(false));
  };
  const stream = useMemo(() => live && { ...live, events }, [live, events]);
  return {
    stream,
    hasMore,
    loading,
    error,
    load,
  };
}
