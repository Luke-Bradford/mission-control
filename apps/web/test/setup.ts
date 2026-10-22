import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { hub } from "../src/data.ts";
import { resetOverlays } from "../src/shell/overlays.ts";
import { resetSelection } from "../src/shell/selection.ts";
import { resetSession } from "../src/shell/session.ts";
import { clearToast } from "../src/shell/Toast.tsx";
import { resetTheme } from "../src/theme.ts";

/** In-memory Web Storage for tests. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    key: (i) => [...items.keys()][i] ?? null,
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => void items.set(k, String(v)),
    removeItem: (k) => void items.delete(k),
    clear: () => items.clear(),
  };
}

// Node 25 has its own global localStorage which, without --localstorage-file, has no methods and
// shadows jsdom's; each test gets a fresh working one instead.
beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

// Vitest globals are off, so Testing Library cannot register its own cleanup.
afterEach(() => {
  cleanup();
  hub.clear(); // the hub is a module singleton: no cached data crosses tests
  // so are the shell's stores (overlays, session, selection, toast)
  resetOverlays();
  resetSession();
  resetSelection();
  clearToast();
  resetTheme();
  // viteConfig.test.ts runs in node, with no window
  if (typeof window !== "undefined") window.history.replaceState(null, "", "/");
});
