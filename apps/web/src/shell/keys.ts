/**
 * Keyboard shortcuts (catalogue §1.6): `g` then a page letter within 900 ms, `f` the dock, `j`/`k`
 * the selected agent, `/` the Agent page, `i` interrupt (the page may take it over), `?` help, and
 * `Esc` closes the topmost overlay. All are ignored while typing, where `Esc` blurs the field.
 */
import { PAGE_PATHS, type Page } from "../router.ts";
import { closeTopOverlay } from "./overlays.ts";

const G_MS = 900;

const G_PAGES: Record<string, Page> = {
  o: "overview",
  f: "flight",
  b: "board",
  a: "agent",
  c: "comms",
  t: "telemetry",
  s: "setup",
};

export interface KeyApp {
  navigate: (to: string) => void;
  toggleDock: () => void;
  help: () => void;
  selectNext: () => void;
  selectPrev: () => void;
  toast: (msg: string) => void;
}

type PageKey = "i";
const pageKeys = new Map<PageKey, () => void>();

/** Let the mounted page handle `key` itself (null hands it back). */
export function setPageKey(key: PageKey, fn: (() => void) | null): void {
  if (fn) pageKeys.set(key, fn);
  else pageKeys.delete(key);
}

function typing(t: EventTarget | null): t is HTMLElement {
  return t instanceof HTMLElement && (t.matches("input, select, textarea") || t.isContentEditable);
}

/** How long `/` waits for the Agent page's message box to mount before giving up. */
const FOCUS_WAIT_MS = 2000;

export function installKeys(app: KeyApp): () => void {
  let gAt: number | null = null;
  let focus: MutationObserver | null = null;
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  const stopFocus = () => {
    focus?.disconnect();
    focus = null;
    clearTimeout(focusTimer);
  };
  const focusMessage = () => {
    const input = document.querySelector<HTMLElement>("#streamP #agentInput");
    if (!input) return;
    input.focus();
    stopFocus();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (typing(e.target)) {
      if (e.key === "Escape") e.target.blur();
      return;
    }
    if (e.key === "Escape") {
      closeTopOverlay();
      return;
    }
    if (gAt !== null) {
      const fresh = Date.now() - gAt <= G_MS;
      gAt = null;
      const page = G_PAGES[e.key];
      if (fresh) {
        if (page) app.navigate(PAGE_PATHS[page]);
        return;
      }
    }
    switch (e.key) {
      case "g":
        gAt = Date.now();
        return;
      case "f":
        app.toggleDock();
        return;
      case "j":
        app.selectNext();
        return;
      case "k":
        app.selectPrev();
        return;
      case "/":
        e.preventDefault();
        stopFocus();
        focus = new MutationObserver(focusMessage);
        focus.observe(document.body, { childList: true, subtree: true });
        focusTimer = setTimeout(stopFocus, FOCUS_WAIT_MS);
        app.navigate(PAGE_PATHS.agent);
        focusMessage();
        return;
      case "?":
        app.help();
        return;
      case "i": {
        const own = pageKeys.get("i");
        if (own) own();
        else app.toast("Open an agent to interrupt it.");
        return;
      }
    }
  };

  document.addEventListener("keydown", onKey);
  return () => {
    document.removeEventListener("keydown", onKey);
    stopFocus();
  };
}
