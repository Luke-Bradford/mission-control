import { loadOperatorToken } from "./api.ts";
import { startStream } from "./data.ts";

/** Reserve the stream connection before bootstrap and the first render's resource requests. */
export function startClient(render: () => void): () => void {
  const stop = startStream();
  void loadOperatorToken();
  render();
  return stop;
}
