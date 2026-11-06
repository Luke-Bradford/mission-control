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

// The Needs you page, rendered with controlled data (the test supplies the API answers).
const params = new URLSearchParams(window.location.search);
Date.now = () => NOW;
document.documentElement.dataset.capture = "controlled-fixture";
streamStatus.set({
  connected: params.get("state") !== "disconnected",
  reconnecting: params.get("state") === "disconnected",
  lastMessageAt: NOW,
});
window.history.replaceState(null, "", params.get("path") ?? "/needs-you");
const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(<App />);
