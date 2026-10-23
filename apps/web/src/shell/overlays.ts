/**
 * What is open over the pages: FLIGHT's dock, the help, Away mode, the Item panel, and the build
 * status toggle. Each overlay pushes itself on one stack while open, and `Esc` closes the topmost
 * (catalogue §1.6). The components are Task 9's; until then the dock, Away and Item panel render
 * nothing, but the header buttons and keys already drive these stores.
 */
import { type KeyboardEvent, useEffect, useRef, useSyncExternalStore } from "react";
import { itemParam, withItemParam } from "../router.ts";
import { BUILD_STATUS_KEY, DOCK_KEY, readBool, writeBool } from "../storage.ts";
import { store, useStore } from "./store.ts";

// ---------- overlay stack ----------

const stack: { id: string; close: () => void }[] = [];

/** Put an open overlay on top (again, if it was already on the stack). */
export function pushOverlay(id: string, close: () => void): void {
  popOverlay(id);
  stack.push({ id, close });
}

export function popOverlay(id: string): void {
  const i = stack.findIndex((o) => o.id === id);
  if (i >= 0) stack.splice(i, 1);
}

/** Close the topmost overlay; false when none is open. */
export function closeTopOverlay(): boolean {
  const top = stack.at(-1);
  if (!top) return false;
  popOverlay(top.id);
  top.close();
  return true;
}

/** Keep an overlay on the stack while `open`; `close` is what `Esc` calls. */
export function useOverlay(id: string, open: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    pushOverlay(id, () => closeRef.current());
    return () => popOverlay(id);
  }, [id, open]);
}

/**
 * While `open`, remember what had focus when it opened, and give focus back to it on close, unless
 * the operator has since put focus somewhere else that is still on the page. Call it before the
 * effect that moves focus into the overlay, so the opener is what it remembers.
 */
export function useReturnFocus(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement;
    return () => {
      const now = document.activeElement;
      // Focus inside something now hidden (the Dock drawer's own Hide button) is as good as lost.
      const lost =
        now === null ||
        now === document.body ||
        (now instanceof Element && !!now.closest("[hidden]"));
      if (lost && opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [open]);
}

const FOCUSABLE =
  "button, a[href], input, select, textarea, summary, [contenteditable], [tabindex]";

/** Reachable by Tab: enabled, not tabindex < 0, not hidden (or inside something hidden). */
const tabbable = (el: HTMLElement): boolean =>
  !el.hasAttribute("disabled") &&
  el.tabIndex >= 0 &&
  !el.closest("[hidden]") &&
  !(el instanceof HTMLInputElement && el.type === "hidden");

/**
 * Keep Tab and Shift+Tab inside an overlay: on its last control Tab goes to the first, and on its
 * first Shift+Tab goes to the last. Use it as the `onKeyDown` of the overlay's root element.
 */
export function trapTab(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== "Tab") return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(tabbable);
  const first = items.at(0);
  const last = items.at(-1);
  if (!first || !last) return;
  // Focus on the root itself, or on <body> after a click on plain text, is not one of the stops.
  const active = document.activeElement;
  const edge = e.shiftKey ? first : last;
  if (active === edge || !items.some((el) => el === active)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  }
}

// ---------- help, Away mode, Item panel ----------

const help = store(false);
export const openHelp = (): void => help.set(true);
export const closeHelp = (): void => help.set(false);
export const useHelpOpen = (): boolean => useStore(help);

const away = store(false);
export const openAway = (): void => away.set(true);
export const closeAway = (): void => away.set(false);
export const useAwayOpen = (): boolean => useStore(away);

/**
 * The attention item (its `key`) the Item panel shows; null when closed. Opening one also puts it
 * in the URL as `?item={key}` (a new history entry, so Back closes it). Closing undoes the open:
 * Back when the open pushed that entry, else (a page loaded with `?item=`, or a key that has gone)
 * the parameter is replaced out of the URL.
 */
const item = store<string | null>(null);
/** The open pushed the history entry that holds `?item=`. */
let pushed = false;
export function openItem(key: string): void {
  item.set(key);
  const to = withItemParam(key);
  if (to === null) return; // the URL already names it
  if (itemParam(window.location.search) !== null) {
    // Another item is open (the flyout has no scrim): swap it in the same entry, so Close still
    // undoes the one open, and `pushed` stays as the first open left it.
    window.history.replaceState(null, "", to);
    return;
  }
  pushed = true;
  window.history.pushState(null, "", to);
}
export function closeItem(): void {
  item.set(null);
  const was = pushed;
  pushed = false;
  if (was && itemParam(window.location.search) !== null) {
    window.history.back();
    return;
  }
  const to = withItemParam(null);
  if (to !== null) window.history.replaceState(null, "", to);
}
/** Show or hide an item whose key the URL already names (a page load, Back, Forward). */
export function syncItem(key: string | null): void {
  pushed = false;
  item.set(key);
}
export const useItem = (): string | null => useStore(item);

// ---------- build status ----------

let buildOn: boolean | undefined; // undefined: not read from storage yet
const buildListeners = new Set<() => void>();
const buildStatusOn = (): boolean => {
  buildOn ??= readBool(BUILD_STATUS_KEY, false);
  return buildOn;
};
function setBuildStatus(on: boolean): void {
  writeBool(BUILD_STATUS_KEY, on);
  buildOn = on;
  for (const fn of [...buildListeners]) fn();
}
function subscribeBuild(fn: () => void): () => void {
  buildListeners.add(fn);
  return () => {
    buildListeners.delete(fn);
  };
}
export function useBuildStatus(): [boolean, (on: boolean) => void] {
  return [useSyncExternalStore(subscribeBuild, buildStatusOn), setBuildStatus];
}

// ---------- FLIGHT's dock ----------

/**
 * ≥1200 px the dock is a right-hand column, shown or hidden and remembered (default shown); below
 * that it is a drawer, closed by default, not remembered, that `Esc` closes. Crossing the
 * breakpoint closes the drawer (catalogue §1.4).
 */
const WIDE_QUERY = "(min-width: 1200px)";
const DRAWER = "dock";

export interface DockState {
  /** The dock is on screen (the column, or the open drawer). */
  visible: boolean;
  /** At least 1200 px wide: a column rather than a drawer. */
  wide: boolean;
}

let query: MediaQueryList | null | undefined; // undefined: not looked up yet
let shown: boolean | undefined; // the column, remembered; undefined: not read yet
let drawerOpen = false;
let snap: DockState = { visible: true, wide: true };
const dockListeners = new Set<() => void>();

function wideQuery(): MediaQueryList | null {
  if (query === undefined) {
    query = typeof window.matchMedia === "function" ? window.matchMedia(WIDE_QUERY) : null;
    query?.addEventListener?.("change", onBreakpoint);
  }
  return query;
}

const isWide = (): boolean => wideQuery()?.matches ?? true;

function columnShown(): boolean {
  if (shown === undefined) shown = readBool(DOCK_KEY, true);
  return shown;
}

/** The current state, keeping the same object while nothing changed; true when it changed. */
function recompute(): boolean {
  const wide = isWide();
  const visible = wide ? columnShown() : drawerOpen;
  if (visible === snap.visible && wide === snap.wide) return false;
  snap = { visible, wide };
  return true;
}

function refresh(): void {
  if (recompute()) for (const fn of [...dockListeners]) fn();
}

function dockSnapshot(): DockState {
  recompute();
  return snap;
}

function setDrawer(open: boolean): void {
  drawerOpen = open;
  if (open) pushOverlay(DRAWER, () => setDrawer(false));
  else popOverlay(DRAWER);
  refresh();
}

function onBreakpoint(): void {
  if (drawerOpen) setDrawer(false);
  else refresh();
}

/** Show or hide the dock (`f`, the header's chat button, its Hide button). */
export function toggleDock(force?: boolean): void {
  if (isWide()) {
    shown = force ?? !columnShown();
    writeBool(DOCK_KEY, shown);
    refresh();
  } else {
    setDrawer(force ?? !drawerOpen);
  }
}

function subscribeDock(fn: () => void): () => void {
  dockListeners.add(fn);
  return () => {
    dockListeners.delete(fn);
  };
}

export function useDock(): DockState & { toggle: () => void } {
  const s = useSyncExternalStore(subscribeDock, dockSnapshot);
  return { ...s, toggle: () => toggleDock() };
}

/** FLIGHT's replies the operator has not seen on the dock's Chat tab; the header badges it. */
const flightUnread = store(0);
export const setFlightUnread = (n: number): void => flightUnread.set(n);
export const useFlightUnread = (): number => useStore(flightUnread);

/** Forget every overlay (the tests' reset: these are module singletons). */
export function resetOverlays(): void {
  flightUnread.set(0);
  stack.length = 0;
  help.set(false);
  away.set(false);
  item.set(null);
  buildOn = undefined;
  query?.removeEventListener?.("change", onBreakpoint);
  query = undefined;
  shown = undefined;
  drawerOpen = false;
  snap = { visible: true, wide: true };
}
