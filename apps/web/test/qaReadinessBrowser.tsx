import "@fontsource/barlow-semi-condensed/latin-500.css";
import "@fontsource/barlow-semi-condensed/latin-600.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "../src/hud.css";
import { createRoot } from "react-dom/client";
import { QaReadiness } from "../src/pages/QaReadiness.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(<QaReadiness />);
