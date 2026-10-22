import type { AttentionItem, Crew } from "@mc/core";
import { useEffect, useRef, useState } from "react";
import { RESOURCES, startStream, useResource } from "./data.ts";
import { Agent } from "./pages/Agent.tsx";
import { BoardPage } from "./pages/BoardPage.tsx";
import { Comms, ITEM_GONE } from "./pages/Comms.tsx";
import { Flight } from "./pages/Flight.tsx";
import { Overview } from "./pages/Overview.tsx";
import { Setup } from "./pages/Setup.tsx";
import { Telemetry } from "./pages/Telemetry.tsx";
import {
  agentPath,
  isPopout,
  itemParam,
  legacyRedirect,
  navigate,
  PAGE_PATHS,
  type Route,
  route,
  usePath,
} from "./router.ts";
import { AwayModal } from "./shell/AwayModal.tsx";
import { Dock } from "./shell/Dock.tsx";
import { Footer } from "./shell/Footer.tsx";
import { Header } from "./shell/Header.tsx";
import { HelpModal } from "./shell/HelpModal.tsx";
import { ItemPanel } from "./shell/ItemPanel.tsx";
import { installKeys } from "./shell/keys.ts";
import {
  closeItem,
  openHelp,
  syncItem,
  toggleDock,
  useBuildStatus,
  useDock,
} from "./shell/overlays.ts";
import { PopoutContext } from "./shell/popout.ts";
import { getSelectedAgent, nextAgent, setSelectedAgent } from "./shell/selection.ts";
import { getSession } from "./shell/session.ts";
import { Toast, toast } from "./shell/Toast.tsx";

/** The document title (index.html's); a popped-out agent is `{id} · Mission Control`. */
const TITLE = "Mission Control";

/**
 * The HUD shell: header, the page, FLIGHT's dock beside it, the footer, and the overlays; a
 * popped-out window (`?popout=1`) shows the Agent page alone. An old path is redirected to where
 * it now lives; any other unknown path goes to Overview.
 */
export function App() {
  const path = usePath();
  // Read once: a popped-out window stays one when its picker moves to another agent.
  const [popout] = useState(() => isPopout(window.location.search));
  useEffect(() => startStream(), []);
  const r = route(path);
  const moved = r ? null : (legacyRedirect(path, window.location.hash) ?? PAGE_PATHS.overview);
  useEffect(() => {
    if (moved) navigate(moved, { replace: true });
  }, [moved]);
  const shown: Route = r ?? { page: "overview" };
  useShellKeys(shown, popout);
  useItemUrl(popout);
  // The URL an in-app navigation pushes has no ?item=, so the panel hides with it (the URL is
  // left alone: Back and Forward own the history). Back onto a ?item= URL keeps it, and popstate opens it.
  const shownPath = useRef(path);
  useEffect(() => {
    if (shownPath.current === path) return;
    shownPath.current = path;
    if (itemParam(window.location.search) === null) syncItem(null);
  }, [path]);
  const dock = useDock();
  const [buildStatus] = useBuildStatus();
  const cls = [
    "app",
    dock.wide && !dock.visible && "dock-hidden",
    !dock.wide && dock.visible && "dock-open",
    buildStatus && "bs-on",
  ]
    .filter(Boolean)
    .join(" ");
  const agentId = shown.page === "agent" ? shown.id : null;
  useEffect(() => {
    if (!popout) return;
    document.title = agentId === null ? TITLE : `${agentId} · ${TITLE}`;
    return () => {
      document.title = TITLE;
    };
  }, [popout, agentId]);
  // Popped out (the Agent header's Pop out): the Agent page alone, with its toasts.
  if (popout) {
    return (
      <div className={`${cls} popout`}>
        <main>
          <PopoutContext.Provider value={true}>
            <Agent id={agentId} />
          </PopoutContext.Provider>
        </main>
        <Toast />
      </div>
    );
  }
  return (
    <div className={cls}>
      <Header page={shown.page} />
      <div className="shell">
        <main>{r && <PageView route={r} />}</main>
        <Dock />
      </div>
      <Footer />
      <Toast />
      <HelpModal />
      <AwayModal />
      <ItemPanel />
    </div>
  );
}

/**
 * The Item panel follows the URL's `?item=`: a page loaded with one opens that item once the
 * attention list is known (a key that has gone toasts and drops the parameter), and Back and
 * Forward open and close the panel. Opening and closing it write the URL themselves (overlays.ts).
 */
function useItemUrl(popout: boolean) {
  const items = useResource<AttentionItem[]>(RESOURCES.attention).data;
  // the key the URL names that has not been looked up yet
  const [wanted, setWanted] = useState(() => (popout ? null : itemParam(window.location.search)));
  useEffect(() => {
    if (popout) return;
    const onPop = () => {
      const key = itemParam(window.location.search);
      if (key === null) syncItem(null);
      setWanted(key);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [popout]);
  useEffect(() => {
    if (wanted === null || items === undefined) return;
    setWanted(null);
    if (items.some((i) => i.key === wanted)) {
      syncItem(wanted);
    } else {
      closeItem(); // drops the parameter
      toast(ITEM_GONE);
    }
  }, [wanted, items]);
}

function PageView({ route: r }: { route: Route }) {
  switch (r.page) {
    case "overview":
      return <Overview />;
    case "flight":
      return <Flight />;
    case "board":
      return <BoardPage repoId={r.repoId} ticket={r.ticket} />;
    case "agent":
      return <Agent id={r.id} />;
    case "comms":
      return <Comms item={r.item} />;
    case "telemetry":
      return <Telemetry />;
    case "setup":
      return <Setup tab={r.tab} />;
  }
}

/** The global shortcuts, reading the latest crew, attention and page when a key is pressed. */
function useShellKeys(current: Route, popout: boolean) {
  const rows = useResource<Crew>(RESOURCES.crew).data?.rows;
  const items = useResource<AttentionItem[]>(RESOURCES.attention).data;
  const latest = useRef({ current, rows, items, popout });
  latest.current = { current, rows, items, popout };
  useEffect(() => {
    const select = (dir: 1 | -1) => {
      const { current: on, rows: r, items: i } = latest.current;
      const id = nextAgent(r ?? [], i ?? [], getSession(), getSelectedAgent(), dir);
      if (id === null) return;
      setSelectedAgent(id);
      if (on.page === "agent") navigate(agentPath(id)); // the URL follows the selection
    };
    return installKeys({
      // a page key leaves you where you are on that page (g b on a ticket keeps the ticket); a
      // pop-out is the Agent page alone, so no page key takes it anywhere
      navigate: (to) => {
        if (latest.current.popout) return;
        if (route(to)?.page !== latest.current.current.page) navigate(to);
      },
      toggleDock: () => toggleDock(),
      help: openHelp,
      selectNext: () => select(1),
      selectPrev: () => select(-1),
      toast,
    });
  }, []);
}
