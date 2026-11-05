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
import "../src/agent/Overview.css";
import { createRoot } from "react-dom/client";
import { AgentHeaderActions } from "../src/agent/Header.tsx";
import { RESOURCES, streamStatus } from "../src/data.ts";
import { Setup } from "../src/pages/Setup.tsx";
import { NOW, seatRow } from "./fixtures.ts";

// One harness for the repo, seat and account-switch forms: `?form=F06` is the Agent page header
// that holds Switch account; anything else is Setup's Repos & seats tab. `?state=` is how the
// data arrives: loading (never), error (refused), status-loading (accounts load, their login state does not) or
// disconnected (the live stream is down). F06 is drawn as the Agent page draws it: the More menu.
const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
const params = new URLSearchParams(location.search);
const state = params.get("state");
Date.now = () => NOW;
streamStatus.set({
  connected: state !== "disconnected",
  reconnecting: state === "disconnected",
  lastMessageAt: NOW,
});
const fixture = window.fetch.bind(window);
window.fetch = (input, init) => {
  const path =
    typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
  if (path === RESOURCES.accountStatus.path && state === "status-loading")
    return new Promise(() => {});
  if (path === RESOURCES.config.path) {
    if (state === "loading") return new Promise(() => {});
    if (state === "error")
      return Promise.resolve(
        new Response(JSON.stringify({ error: "Controlled config unavailable" }), { status: 503 }),
      );
  }
  return fixture(input, init);
};
createRoot(root).render(
  <div className="app">
    <div className="shell shell-full">
      <main>
        {params.get("form") === "F06" ? (
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <AgentHeaderActions
              row={seatRow({ accountId: params.get("account") ?? "codex-main" })}
            />
          </div>
        ) : (
          <Setup tab="repos" />
        )}
      </main>
    </div>
  </div>,
);
