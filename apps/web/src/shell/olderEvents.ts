import type { AgentStream, StreamEvent } from "@mc/core";
import { useMemo, useState } from "react";
import { apiGet } from "../api.ts";

const NO_EVENTS: StreamEvent[] = [];

interface Paging {
  key: string | null;
  events: StreamEvent[];
  /** What the last older page said; null before any page was loaded. */
  hasMore: boolean | null;
  loading: boolean;
  error: string | null;
}

const NONE: Paging = { key: null, events: NO_EVENTS, hasMore: null, loading: false, error: null };

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
  // Everything loaded or failed belongs to one stream: this route and this run. A new run, or
  // another route, starts clean, and a reply for a stream that is no longer shown is dropped.
  const key = path === null || live === undefined ? null : `${path}|${live.runId}`;
  const [state, setState] = useState<Paging>(NONE);
  const cur = key !== null && state.key === key ? state : NONE;
  const kept = cur.events;
  const events = useMemo(() => {
    const liveEvents = live?.events ?? [];
    if (kept.length === 0) return liveEvents;
    const liveIds = new Set(liveEvents.map((e) => e.id));
    return [...kept.filter((e) => !liveIds.has(e.id)), ...liveEvents];
  }, [kept, live?.events]);
  const hasMore = cur.hasMore ?? live?.hasMore ?? false;
  const load = () => {
    const first = events[0];
    if (path === null || key === null || first === undefined || cur.loading) return;
    setState({ ...cur, key, loading: true, error: null });
    apiGet<AgentStream>(
      `${path}${path.includes("?") ? "&" : "?"}before=${encodeURIComponent(first.id)}`,
    )
      .then((page) =>
        setState((prev) =>
          prev.key === key
            ? {
                key,
                events: [...page.events, ...prev.events],
                hasMore: page.hasMore ?? false,
                loading: false,
                error: null,
              }
            : prev,
        ),
      )
      .catch(() =>
        setState((prev) =>
          prev.key === key
            ? { ...prev, loading: false, error: "Could not load older events." }
            : prev,
        ),
      );
  };
  const stream = useMemo(() => live && { ...live, events }, [live, events]);
  return { stream, hasMore, loading: cur.loading, error: cur.error, load };
}
