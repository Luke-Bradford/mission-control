import "./agentV2Browser.tsx";
import type { AgentStream } from "@mc/core";
import { hub, RESOURCES } from "../src/data.ts";

let next: AgentStream | null = null;
const stream = RESOURCES.stream("guido-1").path;
const originalFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const path =
    typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
  if (next && path === stream)
    return Promise.resolve(
      new Response(JSON.stringify(next), { headers: { "Content-Type": "application/json" } }),
    );
  return originalFetch(input, init);
};
window.addEventListener("proof-stream-arrivals", (event) => {
  next = (event as CustomEvent<AgentStream>).detail;
  hub.refetch(stream);
});
