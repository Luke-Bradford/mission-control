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
import { streamStatus } from "../src/data.ts";
import { NOW } from "./fixtures.ts";

const params = new URLSearchParams(window.location.search);
const fetchFixture = window.fetch.bind(window);
window.fetch = (input, init) => {
  const path =
    typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
  if (path === "/api/operator/bootstrap")
    return Promise.resolve(
      new Response(JSON.stringify({ token: "synthetic-desktop-fixture-key" }), { status: 200 }),
    );
  if (/^\/api\/qa-report-assets\/[de]{64}$/.test(path)) {
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVEsAAAAASUVORK5CYII=",
      ),
      (char) => char.charCodeAt(0),
    );
    return Promise.resolve(new Response(png, { headers: { "content-type": "image/png" } }));
  }
  if (["/api/attention", "/api/flight/summary"].includes(path)) {
    if (params.get("state") === "loading") return new Promise(() => {});
    if (params.get("state") === "error")
      return Promise.resolve(
        new Response(JSON.stringify({ error: "Controlled fixture unavailable" }), { status: 503 }),
      );
  }
  return fetchFixture(input, init);
};
Date.now = () => NOW;
document.documentElement.dataset.capture = "controlled-fixture";
streamStatus.set({
  connected: params.get("state") !== "disconnected",
  reconnecting: params.get("state") === "disconnected",
  lastMessageAt: NOW,
});
window.history.replaceState(null, "", params.get("path") ?? "/");
const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(<App />);
