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
import { CodeHealth } from "../src/code-health/CodeHealth.tsx";
import { streamStatus } from "../src/data.ts";
import { Footer } from "../src/shell/Footer.tsx";

streamStatus.set({ connected: true, reconnecting: false, lastMessageAt: Date.now() });
const root = document.getElementById("root");
if (!root) throw Error("Fixture root missing");
// The shell's geometry: a 49 px header, a 380 px dock beside the work area, and the page filling `main`.
const style = document.createElement("style");
style.textContent =
  "html,body,#root{height:100%;margin:0;overflow:hidden}.frame{height:100%;display:flex;flex-direction:column}.frame-head{flex:none;height:49px;border-bottom:1px solid var(--line)}.frame-body{flex:1;min-height:0;display:flex}.frame-body main{flex:1;min-width:0;min-height:0;padding:12px}.frame-dock{flex:none;width:380px;border-left:1px solid var(--line)}";
document.head.append(style);
// A test drops the connection after the first read, so the page shows its disconnected notice.
(globalThis as { __streamDown?: () => void }).__streamDown = () =>
  streamStatus.set({ connected: false, reconnecting: true, lastMessageAt: Date.now() });
createRoot(root).render(
  <div className="frame">
    <header className="frame-head" />
    <div className="frame-body">
      <main>
        <CodeHealth />
      </main>
      <aside className="frame-dock" />
    </div>
    <Footer />
  </div>,
);
