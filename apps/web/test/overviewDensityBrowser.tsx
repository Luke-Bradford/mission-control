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

const state = new URLSearchParams(location.search).get("state");
const diagnosticErrors: string[] = [];
Reflect.set(window, "__overviewDiagnosticErrors", diagnosticErrors);
const reportError = console.error.bind(console);
console.error = (...args) => {
  diagnosticErrors.push(args.map(String).join(" "));
  reportError(...args);
};
const originalFetch = window.fetch.bind(window);
const scoped = [
  "/api/overview",
  "/api/overview/timeline",
  "/api/crew?shape=summary",
  "/api/attention",
  "/api/machine",
  "/api/metrics",
  "/api/limits",
];
window.fetch = (input, init) => {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (method.toUpperCase() !== "GET") throw Error(`Read-only Overview fixture refused ${method}`);
  const path =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? `${input.pathname}${input.search}`
        : input.url;
  if (path === "/api/operator/bootstrap")
    return Promise.resolve(
      new Response(JSON.stringify({ token: "fictional-overview-layout" }), { status: 200 }),
    );
  if (scoped.includes(path)) {
    if (state === "loading") return new Promise(() => {});
    if (state === "error")
      return Promise.resolve(
        new Response(JSON.stringify({ error: "Controlled fixture could not load" }), {
          status: 503,
        }),
      );
  }
  return originalFetch(input, init);
};
Date.now = () => NOW;
document.documentElement.dataset.capture = "controlled-overview-fixture";
streamStatus.set({
  connected: state !== "disconnected",
  reconnecting: state === "disconnected",
  lastMessageAt: NOW,
});
window.history.replaceState(null, "", "/");
const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(<App />);
