import "@fontsource/barlow-semi-condensed/latin-500.css";
import "@fontsource/barlow-semi-condensed/latin-600.css";
import "@fontsource/barlow-semi-condensed/latin-700.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import "../src/hud.css";
import { createRoot } from "react-dom/client";
import { App } from "../src/App.tsx";
import { hub, RESOURCES, streamStatus } from "../src/data.ts";
import { DOCK_COLLAPSED_KEY, writeSessionBool } from "../src/storage.ts";
import { NOW } from "./fixtures.ts";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
// The harness page stands in for the app at the Agent address; the shell around it (top bar,
// FLIGHT's dock, `main`) is the real one, so Comms is laid out where operators see it.
const params = new URLSearchParams(location.search);
writeSessionBool(DOCK_COLLAPSED_KEY, params.get("dock") === "folded");
Date.now = () => NOW;
streamStatus.set({
  connected: params.get("state") !== "disconnected",
  reconnecting: params.get("state") === "disconnected",
  lastMessageAt: NOW,
});
const fetchFixture = window.fetch.bind(window);
let stale = false;
window.fetch = (input, init) => {
  const path =
    typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
  if (path === RESOURCES.agentDetail("guido-1").path) {
    if (params.get("state") === "loading") return new Promise(() => {});
    if (params.get("state") === "error" || stale)
      return Promise.resolve(
        new Response(JSON.stringify({ error: "Controlled Agent view unavailable" }), {
          status: 503,
        }),
      );
  }
  return fetchFixture(input, init);
};
window.addEventListener("fixture-stale-agent", () => {
  stale = true;
  hub.refetch(RESOURCES.agentDetail("guido-1").path);
});
history.replaceState(null, "", new URLSearchParams(location.search).get("at") ?? "/agent/guido-1");
createRoot(root).render(<App />);
