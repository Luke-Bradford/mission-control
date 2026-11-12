import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { setDemo } from "../src/demo/mode.ts";
import { demoMisses } from "../src/demo/source.ts";
import { SETUP_TABS } from "../src/router.ts";

/**
 * Every page, then every tab, segmented choice and select on it, one at a time: Demo must answer
 * every read they make, with no alert. The views it visited are printed so a reviewer can read them.
 */
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener() {}
      close() {}
    },
  );
  setDemo(true);
});
afterEach(() => vi.unstubAllGlobals());

const ROUTES = [
  "/",
  "/flight",
  "/board",
  "/board/shop-app",
  "/tickets/shop-app/102",
  "/agent/dev-1",
  "/agent/flight-1",
  "/comms",
  "/comms/crew",
  "/comms/agents/dev-1",
  "/qa",
  "/qa?view=history",
  "/telemetry",
  "/audit",
  ...SETUP_TABS.map((tab) => `/setup/${tab}`),
];
const CHOICE =
  "main [role=tab], main [role=tablist] button, main .seg button, main .tabs button, main nav button";
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 350))));
const alerts = () =>
  [...document.querySelectorAll("[role=alert]")].map((e) => e.textContent?.slice(0, 100));

it("every page, tab, choice and select ends in data", { timeout: 600_000 }, async () => {
  const visited: string[] = [];
  const problems: string[] = [];
  for (const route of ROUTES) {
    window.history.replaceState(null, "", route);
    const view = render(<App />);
    await settle();
    visited.push(route);
    let seen = demoMisses().length;
    const check = (what: string) => {
      const misses = demoMisses().slice(seen);
      seen = demoMisses().length;
      const bad = alerts();
      if (misses.length || bad.length)
        problems.push(`${what}: ${JSON.stringify({ misses: [...misses], bad })}`);
    };
    check(route);
    const labels = [...document.querySelectorAll<HTMLElement>(CHOICE)].map((e) =>
      (e.textContent ?? "").trim(),
    );
    for (const label of [...new Set(labels)].filter(Boolean)) {
      const target = [...document.querySelectorAll<HTMLElement>(CHOICE)].find(
        (e) => (e.textContent ?? "").trim() === label,
      );
      if (!target) continue;
      await act(async () => void fireEvent.click(target));
      await settle();
      visited.push(`${route} › ${label}`);
      check(`${route} › ${label}`);
    }
    for (const select of [...document.querySelectorAll<HTMLSelectElement>("main select")]) {
      const index = [...document.querySelectorAll("main select")].indexOf(select);
      for (const option of [...select.options]) {
        const live = document.querySelectorAll<HTMLSelectElement>("main select")[index];
        if (!live) continue;
        await act(async () => void fireEvent.change(live, { target: { value: option.value } }));
        await settle();
        visited.push(`${route} › select ${index} = ${option.value}`);
        check(`${route} › select ${index} = ${option.value}`);
      }
    }
    view.unmount();
    window.history.replaceState(null, "", "/");
  }
  console.info(`DemoCrawl visited ${visited.length} views:\n${visited.join("\n")}`);
  expect(problems).toEqual([]);
});
