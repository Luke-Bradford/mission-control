import type { AttentionItem, ConfigView, Crew } from "@mc/core";
import {
  lazy,
  Profiler,
  type ProfilerOnRenderCallback,
  type ReactNode,
  Suspense,
  useEffect,
  useRef,
  useState,
} from "react";
import { useNeedsCount } from "./attention.ts";
import { RESOURCES, useResource } from "./data.ts";
import { DEMO_MARKER_TEXT, DEMO_REFUSED, useDemo } from "./demo/mode.ts";
import type { FlightView } from "./flight/flightTypes.ts";

import {
  agentPath,
  FULL_WIDTH_PAGES,
  followLink,
  isPopout,
  itemParam,
  legacyRedirect,
  navigate,
  PAGE_PATHS,
  type Route,
  route,
  tabOf,
  usePath,
  useSearch,
} from "./router.ts";
import { AwayDigest } from "./shell/AwayDigest.tsx";
import { AwayModal } from "./shell/AwayModal.tsx";
import { CommandPalette } from "./shell/CommandPalette.tsx";
import { Dock, useOverviewDockOverlay } from "./shell/Dock.tsx";
import { Footer } from "./shell/Footer.tsx";
import { Header } from "./shell/Header.tsx";
import { HelpModal } from "./shell/HelpModal.tsx";
import { ItemPanel } from "./shell/ItemPanel.tsx";
import { installKeys } from "./shell/keys.ts";
import {
  closeItem,
  ITEM_GONE,
  openHelp,
  syncItem,
  toggleDock,
  useBuildStatus,
  useDock,
} from "./shell/overlays.ts";
import { PopoutContext } from "./shell/popout.ts";
import { getSelectedAgent, nextAgent, setSelectedAgent } from "./shell/selection.ts";
import { getSession, useSessionScope } from "./shell/session.ts";
import { Toast, toast } from "./shell/Toast.tsx";

const Agent = lazy(() => import("./pages/Agent.tsx").then((m) => ({ default: m.Agent })));
const BoardPage = lazy(() =>
  import("./pages/BoardPage.tsx").then((m) => ({ default: m.BoardPage })),
);
const Comms = lazy(() => import("./pages/Comms.tsx").then((m) => ({ default: m.Comms })));
const CommsChartPage = lazy(() =>
  import("./pages/CommsChartPage.tsx").then((m) => ({ default: m.CommsChartPage })),
);
const MapPage = lazy(() => import("./pages/MapPage.tsx").then((m) => ({ default: m.MapPage })));
const Needs = lazy(() => import("./pages/Needs.tsx").then((m) => ({ default: m.Needs })));
const Flight = lazy(() => import("./pages/Flight.tsx").then((m) => ({ default: m.Flight })));
const Overview = lazy(() => import("./pages/Overview.tsx").then((m) => ({ default: m.Overview })));
const TicketPage = lazy(() =>
  import("./pages/TicketPage.tsx").then((m) => ({ default: m.TicketPage })),
);
const Setup = lazy(() => import("./pages/Setup.tsx").then((m) => ({ default: m.Setup })));
const Telemetry = lazy(() =>
  import("./pages/Telemetry.tsx").then((m) => ({ default: m.Telemetry })),
);
const Audit = lazy(() => import("./pages/Audit.tsx").then((m) => ({ default: m.Audit })));
const QaReadiness = lazy(() =>
  import("./pages/QaReadiness.tsx").then((m) => ({ default: m.QaReadiness })),
);

/** The document title (index.html's); a popped-out agent is `{id} · Mission Control`. */
const TITLE = "Mission Control";

/** The document title in Demo; the same mark as the chip, in the tab. */
const DEMO_TITLE = `DEMO · ${TITLE}`;

/** The app, remounted on a switch between Live and Demo: page state and the Map start afresh. */
export function App(
  props: { onRender?: () => void; onPageRender?: ProfilerOnRenderCallback } = {},
) {
  const demo = useDemo();
  return <Shell key={demo ? "demo" : "live"} {...props} />;
}

/**
 * In Demo a same-origin `/api/` link would open the real hub in a new tab: stop it, and say why.
 */
function useDemoLinkGuard(demo: boolean) {
  useEffect(() => {
    if (!demo) return;
    const guard = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.("a[href]");
      if (!link) return;
      const url = new URL((link as HTMLAnchorElement).href, window.location.href);
      if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) return;
      e.preventDefault();
      e.stopPropagation();
      toast(DEMO_REFUSED);
    };
    document.addEventListener("click", guard, true);
    document.addEventListener("auxclick", guard, true);
    return () => {
      document.removeEventListener("click", guard, true);
      document.removeEventListener("auxclick", guard, true);
    };
  }, [demo]);
}

/**
 * The HUD shell: header, the page, FLIGHT's dock beside it, the footer, and the overlays; a
 * popped-out window (`?popout=1`) shows the Agent page alone. An old path is redirected to where
 * it now lives; any other unknown path says so and offers the main destinations.
 */
function Shell({
  onRender,
  onPageRender,
}: {
  onRender?: () => void;
  onPageRender?: ProfilerOnRenderCallback;
} = {}) {
  onRender?.();
  const demo = useDemo();
  useDemoLinkGuard(demo);
  useHudReady();
  const path = usePath();
  const search = useSearch();
  // Read once: a popped-out window stays one when its picker moves to another agent.
  const [popout] = useState(() => isPopout(window.location.search));
  const r = route(path, search);
  const moved = r ? null : legacyRedirect(path, window.location.hash);
  useEffect(() => {
    if (moved) navigate(moved, { replace: true });
  }, [moved]);
  const shown: Route = r ?? { page: "overview" };
  const notFound = r === null && moved === null;
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
  const overview = shown.page === "overview" && !notFound;
  const overviewOverlay = useOverviewDockOverlay(overview, dock);
  // The approved rail is site-wide. Comms already has the conversation; the full FLIGHT view
  // keeps its own workspace instead of duplicating it beside the page.
  const showDock = !notFound && tabOf(shown) !== "comms" && !FULL_WIDTH_PAGES.has(tabOf(shown));
  const [buildStatus] = useBuildStatus();
  const cls = [
    "app",
    overview && "overview-shell",
    overviewOverlay && "overview-flight-overlay",
    dock.wide && !dock.visible && "dock-hidden",
    dock.visible && dock.collapsed && "dock-collapsed",
    !dock.wide && dock.visible && "dock-open",
    buildStatus && "bs-on",
  ]
    .filter(Boolean)
    .join(" ");
  const agentId = shown.page === "agent" ? shown.id : null;
  // The tab title carries the count, so a waiting ask shows from another tab or a background window.
  const waiting = useNeedsCount().n;
  useEffect(() => {
    const base = demo ? DEMO_TITLE : TITLE;
    const lead = waiting && !demo ? `(${waiting}) ` : "";
    const pageTitle = notFound ? "Page not found" : titleFor(shown);
    document.title =
      popout && agentId !== null ? `${agentId} · ${base}` : `${lead}${pageTitle} · ${base}`;
    return () => {
      document.title = TITLE;
    };
  }, [popout, agentId, demo, waiting, notFound, shown]);
  // Popped out (the Agent header's Pop out): the Agent page alone, with its toasts.
  if (popout) {
    return (
      <div className={`${cls} popout`}>
        {demo && <div className="demo-frame" aria-hidden="true" />}
        {demo && (
          <span
            className="demo-marker demo-marker-popout"
            role="img"
            aria-label={DEMO_MARKER_TEXT}
            title={DEMO_MARKER_TEXT}
          >
            DEMO
          </span>
        )}
        <main>
          <PopoutContext.Provider value={true}>
            <Suspense fallback={<p>Loading…</p>}>
              <Agent id={agentId} />
            </Suspense>
          </PopoutContext.Provider>
        </main>
        <Toast />
      </div>
    );
  }
  return (
    <div className={cls}>
      {demo && <div className="demo-frame" aria-hidden="true" />}
      {shown.page === "board" && (
        // biome-ignore lint/a11y/useValidAnchor: this fragment link moves focus to the Board heading.
        <a
          className="skip-link"
          href="#board-content"
          onClick={() => document.getElementById("board-content")?.focus()}
        >
          Skip to board
        </a>
      )}
      <Header page={notFound ? null : tabOf(shown)} />
      <div className={`shell${showDock ? "" : " shell-full"}`}>
        <main>
          <AwayDigest>
            <Suspense fallback={<p>Loading…</p>}>
              {r ? (
                onPageRender ? (
                  <Profiler id={r.page} onRender={onPageRender}>
                    <PageView route={r} />
                  </Profiler>
                ) : (
                  <PageView route={r} />
                )
              ) : (
                <NotFound />
              )}
            </Suspense>
          </AwayDigest>
        </main>
        {showDock && <Dock coversPage={overviewOverlay} />}
      </div>
      <Footer />
      <Toast />
      <HelpModal />
      <CommandPalette />
      <AwayModal />
      <ItemPanel />
    </div>
  );
}

const PAGE_TITLES: Record<Route["page"], string> = {
  overview: "Overview",
  needs: "Needs you",
  flight: "Flight",
  board: "Board",
  ticket: "Board",
  agent: "Agents",
  map: "Map",
  comms: "Comms",
  commsChart: "Comms",
  telemetry: "Telemetry",
  qa: "QA",
  audit: "Audit",
  setup: "Setup",
};

function titleFor(current: Route): string {
  return PAGE_TITLES[current.page];
}

function NotFound() {
  return (
    <section id="page-not-found" className="panel" aria-labelledby="not-found-heading">
      <div className="ph">
        <h1 id="not-found-heading">Page not found</h1>
        <span className="sub">Check the address or choose a page.</span>
      </div>
      <p>The address does not match a Mission Control page.</p>
      <nav aria-label="Main pages" className="not-found-links">
        <a href={PAGE_PATHS.overview} onClick={(event) => followLink(event, PAGE_PATHS.overview)}>
          Overview
        </a>
        <a href={PAGE_PATHS.board} onClick={(event) => followLink(event, PAGE_PATHS.board)}>
          Board
        </a>
        <a href={PAGE_PATHS.comms} onClick={(event) => followLink(event, PAGE_PATHS.comms)}>
          Comms
        </a>
      </nav>
    </section>
  );
}

/** Screenshot automation waits for initial shell data and fonts, never network idleness. */
function useHudReady() {
  const crew = useResource<Crew>(RESOURCES.crew);
  const config = useResource<ConfigView>(RESOURCES.config);
  const ready = !crew.loading && !config.loading;
  useEffect(() => {
    if (!ready) return;
    let current = true;
    void (document.fonts?.ready ?? Promise.resolve()).then(() => {
      if (current) document.documentElement.dataset.hudReady = "1";
    });
    return () => {
      current = false;
      delete document.documentElement.dataset.hudReady;
    };
  }, [ready]);
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
  let page: ReactNode;
  switch (r.page) {
    case "overview":
      page = <Overview />;
      break;
    case "needs":
      page = <Needs item={r.item} />;
      break;
    case "flight":
      page = <Flight />;
      break;
    case "board":
      page = <BoardPage repoId={r.repoId} ticket={r.ticket} />;
      break;
    case "ticket":
      page = <TicketPage repoId={r.repoId} number={r.number} />;
      break;
    case "agent":
      page = <Agent id={r.id} />;
      break;
    case "map":
      page = <MapPage repoId={r.repoId} />;
      break;
    case "comms":
      page = <Comms item={r.item} view={r.view} />;
      break;
    case "commsChart":
      page = <CommsChartPage />;
      break;
    case "telemetry":
      page = <Telemetry />;
      break;
    case "audit":
      page = <Audit />;
      break;
    case "qa":
      page = <QaReadiness />;
      break;
    case "setup":
      page = <Setup tab={r.tab} />;
      break;
  }
  return page;
}

/** The global shortcuts, reading the latest crew, attention and page when a key is pressed. */
function useShellKeys(current: Route, popout: boolean) {
  const rows = useResource<Crew>(RESOURCES.crew).data?.rows;
  const items = useResource<AttentionItem[]>(RESOURCES.attention).data;
  const flight = useResource<FlightView>(RESOURCES.flight).data;
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const flightId =
    flight?.seat?.id ??
    config?.crew?.sessions.flatMap((s) => s.seats).find((s) => !s.retiring && s.loop === "watch")
      ?.id;
  const { repo } = useSessionScope();
  const latest = useRef({ current, rows, items, popout, repo, flightId });
  latest.current = { current, rows, items, popout, repo, flightId };
  useEffect(() => {
    const select = (dir: 1 | -1) => {
      const { current: on, rows: r, items: i } = latest.current;
      const id = nextAgent(
        r ?? [],
        i ?? [],
        getSession(),
        getSelectedAgent(),
        dir,
        latest.current.repo,
        latest.current.flightId,
        Date.now(),
      );
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
      toggleDock: () => {
        const { current: on, popout: isPopout } = latest.current;
        // The full FLIGHT page opens the conversation in Comms. Comms and pop-outs already own
        // their workspace; every other page has the same site-wide rail.
        if (isPopout || tabOf(on) === "comms") return;
        if (FULL_WIDTH_PAGES.has(tabOf(on))) navigate(PAGE_PATHS.comms);
        else toggleDock();
      },
      help: openHelp,
      selectNext: () => select(1),
      selectPrev: () => select(-1),
      toast,
    });
  }, []);
}
