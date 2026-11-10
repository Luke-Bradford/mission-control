// @vitest-environment node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DEMO_REFUSED } from "../src/demo/mode.ts";
import { PAGE_PATHS, SETUP_TABS } from "../src/router.ts";
import {
  BROWSER_TEST_TIMEOUT_MS,
  browserSession,
  describeRendered,
  type RenderedPage,
} from "./browserRunner.ts";
import { demoSeed, overviewDensityFixture } from "./overviewDensityFixtures.ts";

const { renderAt } = browserSession();
const HARNESS = "test/demoBrowser.html";
const SENTINEL = "LIVE-SENTINEL";
const evidence = process.env.MC_QA_EVIDENCE_DIR;

declare global {
  interface Window {
    __demoSetBeatMs(ms: number): Promise<void>;
    __demoMisses(): Promise<string[]>;
    __noReload?: boolean;
  }
}

const open = (at: string, extra: Partial<Parameters<typeof renderAt>[0]> = {}) =>
  renderAt({
    page: HARNESS,
    width: 1600,
    height: 900,
    search: `?demo=1&at=${encodeURIComponent(at)}`,
    ...extra,
  });

/** Polls the page until `read` is true; throws with the last page errors if it never is. */
async function eventually(
  page: RenderedPage,
  read: () => Promise<boolean>,
  what: string,
  ms = 20_000,
): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (page.errors().length) throw new Error(page.errors().join("; "));
    if (await read()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const text = (page: RenderedPage, selector: string) =>
  page.evaluate((css) => document.querySelector(css)?.textContent ?? "", selector);
const count = (page: RenderedPage, selector: string) =>
  page.evaluate((css) => document.querySelectorAll(css).length, selector);
const bodyHas = (page: RenderedPage, needle: string) =>
  page.evaluate((n) => document.body.textContent?.includes(n) ?? false, needle);
const apiRequests = (page: RenderedPage) =>
  page.requests().filter((r) => r.path.startsWith("/api/"));

interface PageCase {
  name: string;
  at: string;
  /** The least text `main` holds once it is busy, from the same page rendered in jsdom. */
  minText: number;
  /** A selector and the fewest of it the page shows. */
  populated?: [string, number];
}

const PAGES: PageCase[] = [
  { name: "Overview", at: "/", minText: 2000, populated: ["#agentsList .trow:not(.head)", 10] },
  { name: "Flight", at: "/flight", minText: 800, populated: ["#decisions .fp-drow", 3] },
  { name: "Board", at: "/board", minText: 700 },
  { name: "a ticket", at: "/tickets/shop-app/101", minText: 150 },
  { name: "an agent", at: "/agent/dev-1", minText: 500 },
  { name: "Comms", at: "/comms/crew", minText: 2000 },
  { name: "QA", at: "/qa", minText: 500 },
  { name: "Telemetry", at: "/telemetry", minText: 3000 },
  { name: "Audit", at: "/audit", minText: 1000 },
  ...SETUP_TABS.map((tab) => ({ name: `Setup ${tab}`, at: `/setup/${tab}`, minText: 100 })),
];

describeRendered("Demo, rendered", () => {
  it.each(PAGES)(
    "$name is busy, error-free and marked",
    async ({ at, minText, populated }) => {
      const page = await open(at);
      await page.box(".demo-marker");
      expect(await text(page, ".demo-marker")).toBe("DEMO");
      await eventually(
        page,
        async () => (await text(page, "main")).length >= minText,
        `${at} to fill`,
      );
      if (populated) {
        const [selector, least] = populated;
        await eventually(
          page,
          async () => (await count(page, selector)) >= least,
          `${selector} x${least}`,
        );
      }
      await page.evaluate(() => new Promise((r) => setTimeout(r, 500)), undefined);
      expect(page.errors()).toEqual([]);
      expect(await count(page, "[role=alert]")).toBe(0);
      expect(await page.evaluate(() => window.__demoMisses(), undefined)).toEqual([]);
      expect(apiRequests(page)).toEqual([]);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "marks a popout",
    async () => {
      const page = await open("/agent/dev-1?popout=1");
      await page.box(".demo-marker-popout");
      expect(await text(page, ".demo-marker-popout")).toBe("DEMO");
      expect(await page.evaluate(() => document.title, undefined)).toBe(
        "dev-1 · DEMO · Mission Control",
      );
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it.each([
    ["Overview", "/", "#agentsList"],
    ["Board", "/board", "main"],
    ["Comms", "/comms/crew", "main"],
  ] as const)(
    "%s moves on its own at a quick beat",
    async (_name, at, selector) => {
      const page = await open(at);
      await page.box(".demo-marker");
      await eventually(page, async () => (await text(page, selector)).length > 100, "content");
      await page.evaluate(() => window.__demoSetBeatMs(100), undefined);
      const read = () =>
        page.evaluate(([css]) => {
          const el = document.querySelector(css);
          return el?.textContent ?? "";
        }, selector);
      const before = await read();
      await eventually(page, async () => (await read()) !== before, `${at} to change`, 40_000);
      await page.close();
    },
    90_000,
  );

  it(
    "sends no write and no real /api read from the browser, whatever the person does",
    async () => {
      const page = await open("/");
      await page.box(".demo-marker");
      // Walk every page by its tab, then Setup.
      for (const to of Object.values(PAGE_PATHS).filter((p) => p !== PAGE_PATHS.setup)) {
        const link = `nav[aria-label=Pages] a[href="${to}"]`;
        if ((await count(page, link)) > 0) await page.click(link);
        await page.evaluate(() => new Promise((r) => setTimeout(r, 400)), undefined);
      }
      await page.click("button[aria-label=Setup]");
      await page.evaluate(() => new Promise((r) => setTimeout(r, 400)), undefined);
      // One write, from the Away modal.
      await page.click("button[title^='Away mode']");
      await page.click(".awaypanel .sw input");
      // a change is only a draft: Save sends it, and the demo refuses it in the form's summary
      await page.click(".awaypanel button[type=submit]");
      await eventually(
        page,
        async () => (await text(page, ".awaypanel .fsum")).includes(DEMO_REFUSED),
        "the refusal on screen",
      );
      // One click on a same-origin /api/ link.
      const prevented = await page.evaluate(() => {
        const link = document.createElement("a");
        link.href = "/api/qa-report-assets/abc";
        link.target = "_blank";
        document.body.append(link);
        const click = new MouseEvent("click", { bubbles: true, cancelable: true });
        link.dispatchEvent(click);
        return click.defaultPrevented;
      }, undefined);
      expect(prevented).toBe(true);
      expect(await text(page, "#toast")).toBe(DEMO_REFUSED);
      expect(apiRequests(page)).toEqual([]);
      expect(page.requests().filter((r) => r.method !== "GET")).toEqual([]);
      expect(page.errors()).toEqual([]);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "switches to Demo and back without a reload, and sends nothing to the hub in between",
    async () => {
      const live = demoSeed();
      const rows = (live.api["/api/crew?shape=summary"] as { rows: { ticketTitle: string }[] })
        .rows;
      const api = {
        ...live.api,
        "/api/crew?shape=summary": {
          ...(live.api["/api/crew?shape=summary"] as object),
          rows: rows.map((row, i) => (i === 1 ? { ...row, ticketTitle: SENTINEL } : row)),
        },
      };
      const page = await renderAt({ page: HARNESS, width: 1600, height: 900, search: "", api });
      await eventually(page, () => bodyHas(page, SENTINEL), "the Live sentinel");
      expect(await count(page, ".demo-marker")).toBe(0);
      expect(
        await page.evaluate(
          () => performance.getEntriesByType("resource").some((e) => /simulator-/.test(e.name)),
          undefined,
        ),
      ).toBe(false);
      await page.evaluate(() => {
        window.__noReload = true;
      }, undefined);
      const clickedAt = page.requests().length;

      await page.click(".demo-switch");
      await page.box(".demo-marker");
      await eventually(page, async () => !(await bodyHas(page, SENTINEL)), "the sentinel to go");
      await page.evaluate(() => new Promise((r) => setTimeout(r, 800)), undefined);
      const inDemo = page.requests().slice(clickedAt);
      expect(inDemo.filter((r) => r.path.startsWith("/api/"))).toEqual([]);
      expect(inDemo.some((r) => /\/simulator-[^/]*\.js$/.test(r.path))).toBe(true);

      const backAt = page.requests().length;
      expect(await text(page, ".demo-switch")).toBe("Back to Live");
      await page.click(".demo-switch");
      await eventually(
        page,
        async () => (await count(page, ".demo-marker")) === 0,
        "the marker to go",
      );
      await eventually(page, () => bodyHas(page, SENTINEL), "the Live sentinel back");
      const back = page
        .requests()
        .slice(backAt)
        .map((r) => r.path);
      expect(back).toContain("/api/stream");
      expect(back).toContain("/api/crew?shape=summary");
      expect(await page.evaluate(() => window.__noReload, undefined)).toBe(true);
      expect(page.errors()).toEqual([]);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "plays Demo when the hub has no runs",
    async () => {
      // The live API answers as an empty hub: no runs, no seats working.
      const empty = overviewDensityFixture("empty");
      expect(empty.rows).toEqual([]);
      const page = await renderAt({
        page: HARNESS,
        width: 1600,
        height: 900,
        search: "?demo=1&at=%2F",
        api: empty.api,
      });
      await page.box(".demo-marker");
      expect(await text(page, ".demo-marker")).toBe("DEMO");
      await eventually(
        page,
        async () => (await count(page, "#agentsList .trow:not(.head)")) >= 10,
        "the Demo crew",
      );
      expect(apiRequests(page)).toEqual([]);
      await page.click(".demo-switch");
      await eventually(
        page,
        async () => (await count(page, ".demo-marker")) === 0,
        "the marker to go",
      );
      await page.evaluate(() => new Promise((r) => setTimeout(r, 800)), undefined);
      expect(await count(page, "[role=alert]")).toBe(0);
      expect(page.errors()).toEqual([]);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the idle cost of Overview low (held to 5% only with MC_DEMO_CPU_BUDGET=1)",
    async () => {
      const page = await open("/");
      await page.box(".demo-marker");
      await eventually(
        page,
        async () => (await count(page, "#agentsList .trow:not(.head)")) >= 10,
        "the crew",
      );
      const WALL_MS = 20_000;
      const busyMs = await page.evaluate(
        (wall) =>
          new Promise<number>((resolve) => {
            let total = 0;
            const observer = new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) total += entry.duration;
            });
            observer.observe({ entryTypes: ["longtask"] });
            setTimeout(() => {
              observer.disconnect();
              resolve(total);
            }, wall);
          }),
        WALL_MS,
      );
      const share = busyMs / WALL_MS;
      console.info(
        `Demo idle: ${busyMs.toFixed(0)} ms of long tasks in ${WALL_MS} ms (${(share * 100).toFixed(1)}%)`,
      );
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        writeFileSync(
          join(evidence, "demo-idle-cpu.json"),
          JSON.stringify({ busyMs, wallMs: WALL_MS, share }),
        );
      }
      if (process.env.MC_DEMO_CPU_BUDGET === "1") expect(share).toBeLessThanOrEqual(0.05);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
