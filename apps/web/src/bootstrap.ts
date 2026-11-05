import { loadOperatorToken } from "./api.ts";
import { hub, startStream } from "./data.ts";
import { demoMode, isDemo } from "./demo/mode.ts";

/** Reserve the stream connection before bootstrap and the first render's resource requests. */
export function startClient(render: () => void): () => void {
  let stopStream = startStream();
  void loadOperatorToken();
  // A switch between Live and Demo swaps the stream and drops the cache. Nothing is refetched
  // here: the shell remounts by mode, and each new subscriber fetches from the right source.
  const unsubscribe = demoMode.subscribe(() => {
    stopStream();
    hub.clear({ refetch: false });
    stopStream = startStream();
    if (!isDemo()) void loadOperatorToken();
  });
  render();
  return () => {
    unsubscribe();
    stopStream();
  };
}
