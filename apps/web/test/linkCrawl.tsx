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

/** Every in-page anchor on `route` in Demo, clicked once; buttons only when `buttons` matches. */
export async function crawlRoute(route: string, buttons: RegExp | null): Promise<Click[]> {
  setDemo(true);
  window.history.replaceState(null, "", route);
  const view = render(<App />);
  await settle();
  const out: Click[] = [];
  const pick = [...document.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")];
  for (const el of pick) {
    const kind = el.tagName === "A" ? "a" : "button";
    const text = words(el);
    if (kind === "button" && !(buttons?.test(text) ?? false)) continue;
    out.push({ route, text, cls: el.className, kind, target: clickOnce(el) });
  }
  view.unmount();
  window.history.replaceState(null, "", "/");
  return out;
}
