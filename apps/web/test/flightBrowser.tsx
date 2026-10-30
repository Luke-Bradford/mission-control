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
// The harness page stands in for the app at the FLIGHT page's Record tab, shell and all.
history.replaceState(null, "", "/flight#outcomesP");
createRoot(root).render(<App />);
