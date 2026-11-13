import { act, render } from "@testing-library/react";
import { vi } from "vitest";
import { App } from "../src/App.tsx";
import { setDemo } from "../src/demo/mode.ts";

/** One clickable thing on a page, and where clicking it went. */
export interface Click {
  route: string;
  /** Its accessible words, trimmed. */
  text: string;
  /** Its classes. */
  cls: string;
  /** What kind of element: an anchor or a button. */
  kind: "a" | "button";
  /** Where it went: path, query and fragment; `external` for another site; `stays` when nothing moved. */
  target: string;
}

export const EXTERNAL = "external";
export const STAYS = "stays";

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 350))));
const words = (el: Element): string =>
  (el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Click one element and say where it went. History writes are caught, not made, so the page stays
 * put and the next click starts from the same screen.
 */
function clickOnce(el: HTMLElement): string {
  let moved: string | null = null;
  const push = vi.spyOn(window.history, "pushState").mockImplementation((_s, _t, url) => {
    moved = String(url);
  });
  const replace = vi.spyOn(window.history, "replaceState").mockImplementation((_s, _t, url) => {
    moved = String(url);
  });
  let handled = false;
  // The app's own handler calls preventDefault (followLink does); note it, and stop the browser
  // following the href either way.
  const before = (e: Event) => {
    const prevent = e.preventDefault.bind(e);
    e.preventDefault = () => {
      handled = true;
      prevent();
    };
    prevent();
  };
  window.addEventListener("click", before, true);
  try {
    el.click();
  } finally {
    window.removeEventListener("click", before, true);
    push.mockRestore();
    replace.mockRestore();
  }
  const href = el instanceof HTMLAnchorElement ? el.href : null;
  if (handled && moved !== null) return moved;
  if (href) {
    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin || el.getAttribute("target") === "_blank")
      return EXTERNAL;
    return url.pathname + url.search + url.hash;
  }
  return moved ?? STAYS;
}

/**
 * Every anchor and enabled button on `route` in Demo, clicked once. A button that moves history
 * went somewhere and is reported; one that does not is an action in place and is left out. After a
 * click that changed the page the route is rendered afresh, so the next click starts from the same
 * screen.
 */
export async function crawlRoute(route: string): Promise<Click[]> {
  setDemo(true);
  const out: Click[] = [];
  const open = async () => {
    window.history.replaceState(null, "", route);
    const view = render(<App />);
    await settle();
    return view;
  };
  const pick = () =>
    [...document.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")].filter(
      (el) => !el.closest("[data-crawl-skip]"),
    );
  let view = await open();
  for (let i = 0; i < pick().length; i++) {
    const el = pick()[i] as HTMLElement;
    const kind = el.tagName === "A" ? "a" : "button";
    const text = words(el);
    const cls = el.className;
    const before = document.body.innerHTML;
    const target = await act(async () => clickOnce(el));
    if (kind === "a" || target !== STAYS) out.push({ route, text, cls, kind, target });
    if (document.body.innerHTML !== before) {
      view.unmount();
      view = await open();
    }
  }
  view.unmount();
  window.history.replaceState(null, "", "/");
  return out;
}
