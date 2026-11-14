import { act, render } from "@testing-library/react";
import { vi } from "vitest";
import { App } from "../src/App.tsx";
import { hub } from "../src/data.ts";
import { setDemo } from "../src/demo/mode.ts";
import { resetMarkedSeen } from "../src/shell/operatorMessages.ts";
import { closeItem, resetOverlays } from "../src/shell/overlays.ts";
import { resetSelection } from "../src/shell/selection.ts";
import { resetSession } from "../src/shell/session.ts";
import { resetTheme } from "../src/theme.ts";

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
const words = (el: Element): string => {
  const said = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || "")
    .replace(/\s+/g, " ")
    .trim();
  // A picture link has no text: name it by the picture's alt.
  const picture = el.querySelector("img")?.getAttribute("alt");
  return said || (picture ? `picture: ${picture}` : "");
};

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
    // SVG elements have no click(); a dispatched event reaches React's handlers the same way
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
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
  // Demo's data is relative to now; a frozen clock keeps every render of the page the same.
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  try {
    return await crawlFrozen(route);
  } finally {
    vi.useRealTimers();
  }
}

async function crawlFrozen(route: string): Promise<Click[]> {
  const out: Click[] = [];
  const pick = () =>
    [
      ...document.querySelectorAll<HTMLElement>(
        "a[href], button:not([disabled]), [role=button]:not(button):not([aria-disabled=true]), [role=link]:not(a), [role=tab]:not(button), [role=option]",
      ),
    ].filter((el) => !el.closest("[data-crawl-skip]"));
  /** The clickable words, numbers left out so a ticking "5m" is not a change. */
  const list = () =>
    pick()
      .map((el) => words(el).replace(/\d+/g, "N"))
      .sort();
  /** Every render starts from the same state: storage, stores and Demo as a first visit has them. */
  const open = async () => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    hub.clear();
    resetMarkedSeen();
    resetTheme();
    closeItem();
    resetOverlays();
    resetSelection();
    resetSession();
    setDemo(true);
    window.history.replaceState(null, "", route);
    const view = render(<App />);
    await settle();
    // Wait until the page stops adding things to click.
    let last = list();
    let same = 0;
    for (let tries = 0; tries < 40 && same < 3; tries++) {
      await act(async () => void (await new Promise((r) => setTimeout(r, 150))));
      const now = list();
      same = now.join("\n") === last.join("\n") ? same + 1 : 0;
      last = now;
    }
    return view;
  };
  let view = await open();
  const first = list();
  const done = new Set<string>();
  for (let i = 0; i < pick().length; i++) {
    const el = pick()[i] as HTMLElement;
    const kind = el.tagName === "A" ? "a" : "button"; // role=button and the like count as buttons
    const text = words(el);
    const cls = el.getAttribute("class") ?? "";
    // Buttons of one kind (the same words, numbers aside) are clicked once: the map's rules are
    // patterns, and each click can cost a fresh render. Anchors are all clicked.
    if (kind === "button") {
      const key = `${text.replace(/\d+/g, "N")}|${cls}`;
      if (done.has(key)) continue;
      done.add(key);
    }
    const before = document.body.innerHTML;
    const target = await act(async () => clickOnce(el));
    out.push({ route, text, cls, kind, target });
    if (document.body.innerHTML !== before) {
      view.unmount();
      view = await open();
      if (list().join("\n") !== first.join("\n"))
        throw new Error(
          `${route}: the page changed after clicking "${text}" ${JSON.stringify({ gone: first.filter((w) => !list().includes(w)), added: list().filter((w) => !first.includes(w)) })}`,
        );
    }
  }
  view.unmount();
  window.history.replaceState(null, "", "/");
  return out;
}
