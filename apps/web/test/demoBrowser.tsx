import "./demoBrowserSetup.ts";
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
import { startClient } from "../src/bootstrap.ts";
import { BrowserNotifications } from "../src/browserNotifications.ts";

// The real client, started the way main.tsx starts it, so the switch and the stream are the real ones.
// The simulator is imported only when a test asks, so a Live page never fetches its chunk.
Reflect.set(window, "__demoSetBeatMs", async (ms: number) =>
  (await import("../src/demo/simulator.ts")).setBeatMs(ms),
);
Reflect.set(window, "__demoMisses", async () => [
  ...(await import("../src/demo/source.ts")).demoMisses(),
]);
window.history.replaceState(null, "", new URLSearchParams(window.location.search).get("at") ?? "/");
const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
startClient(() =>
  createRoot(root).render(
    <>
      <App />
      <BrowserNotifications />
    </>,
  ),
);
