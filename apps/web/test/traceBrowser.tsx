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

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
// The harness page stands in for the app at the Run Trace's own address; the shell around it
// (top bar, FLIGHT's dock, `main`) is the real one, so the trace is laid out where operators see it.
history.replaceState(
  null,
  "",
  `/agent/inco-1${new URLSearchParams(location.search).size ? location.search : ""}`,
);
createRoot(root).render(<App />);
