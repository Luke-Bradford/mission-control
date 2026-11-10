import { joinMapGraph, type MapGraph, type MapSnapshot } from "@mc/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../api.ts";
import { hub, RESOURCES, type Resource, useResource } from "../data.ts";

/** Reads the repository graph only when a QA view needs import relationships. */
export function useRepoGraph(
  repo: string | null,
): Resource<MapSnapshot> & { retry: () => void } {
  const snapshot = useResource<MapSnapshot>(repo === null ? null : RESOURCES.repoMap(repo));
  const key = snapshot.data?.graphKey;
  const graphRef =
    repo && key
      ? {
          path: `/api/repos/${encodeURIComponent(repo)}/map/graph?key=${encodeURIComponent(key)}`,
          topic: null,
        }
      : null;
  const graph = useResource<MapGraph>(graphRef);
  const attempts = useRef({ repo, count: 0 });
  const [recoveryError, setRecoveryError] = useState<Error | null>(null);
  if (attempts.current.repo !== repo) attempts.current = { repo, count: 0 };
  const reconcile = useCallback(async () => {
    if (!repo) return;
    const next = await hub.read<MapSnapshot>(RESOURCES.repoMap(repo));
    if (next.graphKey)
      await hub.read<MapGraph>({
        path: `/api/repos/${encodeURIComponent(repo)}/map/graph?key=${encodeURIComponent(next.graphKey)}`,
        topic: null,
      });
  }, [repo]);
  useEffect(() => {
    if (!(graph.error instanceof ApiError) || graph.error.status !== 409 || attempts.current.count >= 2)
      return;
    attempts.current.count++;
    let current = true;
    void reconcile().catch((e) => {
      if (current) setRecoveryError(e instanceof Error ? e : new Error(String(e)));
    });
    return () => {
      current = false;
    };
  }, [graph.error, reconcile]);
  const retry = useCallback(() => {
    attempts.current.count = 0;
    setRecoveryError(null);
    void reconcile().catch((e) => setRecoveryError(e instanceof Error ? e : new Error(String(e))));
  }, [reconcile]);
  return useMemo(() => {
    if (!snapshot.data || !key) return { ...snapshot, retry };
    if (!graph.data)
      return {
        data: undefined,
        error: recoveryError ?? graph.error ?? snapshot.error,
        loading: graph.loading || snapshot.loading,
        retry,
      };
    try {
      return { ...snapshot, data: joinMapGraph(snapshot.data, graph.data), error: graph.error ?? snapshot.error, retry };
    } catch (e) {
      return { data: undefined, error: e instanceof Error ? e : new Error(String(e)), loading: false, retry };
    }
  }, [snapshot, key, graph, recoveryError, retry]);
}
