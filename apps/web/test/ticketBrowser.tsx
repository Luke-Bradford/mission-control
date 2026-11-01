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
import "../src/ticket/ticket.css";
import { createRoot } from "react-dom/client";
import { TicketPage } from "../src/pages/TicketPage.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
// The shell's frame: the page inside main, as App draws it.
createRoot(root).render(
  <div className="app">
    <div className="shell shell-full">
      <main>
        <TicketPage repoId="shop-app" number={3349} />
      </main>
    </div>
  </div>,
);
