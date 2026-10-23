import { type MouseEvent, useSyncExternalStore } from "react";

/** A tiny History-API router: seven pages and a few ids do not justify a library. */
const NAV_EVENT = "mc:navigate";

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (to === window.location.pathname + window.location.search + window.location.hash) return;
  if (opts.replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  window.dispatchEvent(new Event(NAV_EVENT));
}

/** A link's click: navigate in-app, leaving modified clicks (new tab, new window) to the browser. */
export function followLink(e: MouseEvent, to: string): void {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(to);
}

function subscribe(fn: () => void): () => void {
  window.addEventListener("popstate", fn);
  window.addEventListener(NAV_EVENT, fn);
  return () => {
    window.removeEventListener("popstate", fn);
    window.removeEventListener(NAV_EVENT, fn);
  };
}

export const usePath = (): string =>
  useSyncExternalStore(subscribe, () => window.location.pathname);

export const SETUP_TABS = [
  "sessions",
  "repos",
  "loops",
  "accounts",
  "roles",
  "sources",
  "access",
] as const;
export type SetupTab = (typeof SETUP_TABS)[number];

export type Page = "overview" | "flight" | "board" | "agent" | "comms" | "telemetry" | "setup";

export type Route =
  | { page: "overview" }
  | { page: "flight" }
  | { page: "board"; repoId: string | null; ticket: number | null }
  | { page: "agent"; id: string | null }
  | { page: "comms"; item: string | null }
  | { page: "telemetry" }
  | { page: "setup"; tab: SetupTab };

/** Each page's own path (the header tabs and `g` keys go here). */
export const PAGE_PATHS: Record<Page, string> = {
  overview: "/",
  flight: "/flight",
  board: "/board",
  agent: "/agent",
  comms: "/comms",
  telemetry: "/telemetry",
  setup: "/setup",
};

const enc = encodeURIComponent;
export const agentPath = (id: string): string => `/agent/${enc(id)}`;
export const boardPath = (repoId: string): string => `/board/${enc(repoId)}`;
export const ticketPath = (repoId: string, issueNumber: number): string =>
  `${boardPath(repoId)}/${issueNumber}`;
/** An attention item's key, e.g. `esc:shop-app#3227` (its `#` is encoded, so it is not a hash). */
export const itemPath = (key: string): string => `/comms/${enc(key)}`;
export const setupPath = (tab: SetupTab): string => `/setup/${tab}`;
/** The query parameter that names the session whose Add agent form should open (`?add=s1`). */
export const ADD_AGENT_PARAM = "add";
/** The session id a URL's add-agent query names; null when it names none. */
export const addAgentParam = (search: string): string | null =>
  new URLSearchParams(search).get(ADD_AGENT_PARAM);
export const addAgentPath = (sessionId: string): string =>
  `${setupPath("sessions")}?${ADD_AGENT_PARAM}=${enc(sessionId)}`;

/** A popped-out window (`?popout=1`, the Agent header's Pop out): the page alone, no chrome. */
export const isPopout = (search: string): boolean =>
  new URLSearchParams(search).get("popout") === "1";

/** The query parameter that holds the open Item panel's key (`?item=esc:shop-app#3227`). */
export const ITEM_PARAM = "item";

/** The item key a URL's query names; null when it names none. */
export const itemParam = (search: string): string | null =>
  new URLSearchParams(search).get(ITEM_PARAM);

/**
 * The current URL with `?item=` set to `key`, or removed when null, keeping its path, other
 * parameters and hash; null when that is the URL it already is.
 */
export function withItemParam(key: string | null): string | null {
  const { pathname, search, hash } = window.location;
  if (itemParam(search) === key) return null;
  const q = new URLSearchParams(search);
  if (key === null) q.delete(ITEM_PARAM);
  else q.set(ITEM_PARAM, key);
  const qs = q.toString();
  return pathname + (qs ? `?${qs}` : "") + hash;
}

const decode = (s: string): string | null => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};

/** `/<prefix>` or `/<prefix>/<id>`; null when the id is not valid percent-encoding. */
function withId(path: string, prefix: string): { id: string | null } | null {
  if (path === `/${prefix}` || path === `/${prefix}/`) return { id: null };
  const m = new RegExp(`^/${prefix}/([^/]+)/?$`).exec(path);
  const id = m?.[1] ? decode(m[1]) : null;
  return id === null ? null : { id };
}

/** `/board/<repoId>/<issue number>`; null unless the number is a positive integer. */
function boardTicket(path: string): { repoId: string; ticket: number } | null {
  const m = /^\/board\/([^/]+)\/([1-9]\d*)\/?$/.exec(path);
  const repoId = m?.[1] ? decode(m[1]) : null;
  const ticket = Number(m?.[2]);
  return repoId === null || !Number.isSafeInteger(ticket) ? null : { repoId, ticket };
}

const isSetupTab = (s: string): s is SetupTab => (SETUP_TABS as readonly string[]).includes(s);

const bare = (path: string): string =>
  path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

/** The page a path shows; null when it is not one (see legacyRedirect, then Overview). */
export function route(path: string): Route | null {
  const p = bare(path);
  if (p === "/") return { page: "overview" };
  if (p === "/flight") return { page: "flight" };
  if (p === "/telemetry") return { page: "telemetry" };
  const board = withId(path, "board");
  if (board) return { page: "board", repoId: board.id, ticket: null };
  const ticket = boardTicket(path);
  if (ticket) return { page: "board", ...ticket };
  const agent = withId(path, "agent");
  if (agent) return { page: "agent", id: agent.id };
  const comms = withId(path, "comms");
  if (comms) return { page: "comms", item: comms.id };
  const setup = withId(path, "setup");
  if (setup)
    return { page: "setup", tab: setup.id && isSetupTab(setup.id) ? setup.id : "sessions" };
  return null;
}

const GLOSSARY = `${setupPath("sources")}#glossary`;

/**
 * Where a path from an earlier version now lives (`hash` is the URL's own, e.g. `#glossary`);
 * null when `path` is not one.
 */
export function legacyRedirect(path: string, hash = ""): string | null {
  const p = bare(path);
  if (p === "/needs-you" || p === "/needs") return PAGE_PATHS.comms;
  if (p === "/cto") return PAGE_PATHS.flight;
  if (p === "/metrics") return PAGE_PATHS.telemetry;
  if (p === "/agents" || p === "/loops") return PAGE_PATHS.overview;
  if (p === "/config") return GLOSSARY;
  if (p === "/settings") return hash === "#glossary" ? GLOSSARY : PAGE_PATHS.setup;
  const boards = /^\/boards(\/[^/]+)?\/?$/.exec(path);
  if (boards) return `/board${boards[1] ?? ""}`;
  const agent = withId(path, "agents") ?? withId(path, "loops");
  if (agent?.id) return agentPath(agent.id);
  const need = withId(path, "needs");
  if (need?.id) return itemPath(`esc:${need.id}`);
  return null;
}
