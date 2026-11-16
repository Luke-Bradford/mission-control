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

// The real shell on the Audit route, so the page is judged inside the header and dock it ships with.
history.replaceState(null, "", "/audit");
streamStatus.set({ connected: true, reconnecting: false, lastMessageAt: Date.now() });
const root = document.getElementById("root");
if (!root) throw Error("Fixture root missing");
createRoot(root).render(<App />);
