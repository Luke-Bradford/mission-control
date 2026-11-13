// @vitest-environment node
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { desktopFixture } from "./desktopFixtures.ts";

const { renderAt } = browserSession();

const PAGES = [
  "/",
  "/needs",
  "/flight",
  "/board",
  "/agent",
  "/comms",
  "/qa",
  "/telemetry",
  "/audit",
  "/setup",
] as const;

describeRendered("Polish list, part two: fit at 1920x940", () => {
  it(
    "clips no text without an ellipsis on any page",
    async () => {
      const clipped: string[] = [];
      for (const path of PAGES) {
        const page = await renderAt({
          page: "test/desktopBrowser.html",
          width: 1920,
          height: 940,
          search: `?path=${encodeURIComponent(path)}`,
          api: desktopFixture().api,
        });
        try {
          await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise((resolve) => setTimeout(resolve, 300));
          }, undefined);
          const found = await page.evaluate(() => {
            const out: string[] = [];
            for (const el of document.querySelectorAll<HTMLElement>("body *")) {
              const box = el.getBoundingClientRect();
              if (box.width === 0 || box.height === 0) continue;
              const style = getComputedStyle(el);
              const hides = ["hidden", "clip"].includes(style.overflowX);
              if (!hides || el.scrollWidth <= el.clientWidth + 1) continue;
              // only an element that holds text of its own can clip text
              const ownText = [...el.childNodes].some(
                (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "",
              );
              if (!ownText) continue;
              if (style.textOverflow === "ellipsis") continue;
              if (style.getPropertyValue("-webkit-line-clamp") !== "none") continue;
              out.push(
                `${el.tagName.toLowerCase()}.${el.className}: ${el.textContent?.trim().slice(0, 40)}`,
              );
            }
            return out;
          }, undefined);
          clipped.push(...found.map((f) => `${path} ${f}`));
        } finally {
          await page.close();
        }
      }
      expect(clipped).toEqual([]);
    },
    BROWSER_TEST_TIMEOUT_MS * 4,
  );

  for (const scheme of ["light", "dark"] as const) {
    it(
      `makes every Overview control at least 24x24 and keeps the chat clear of its right column: ${scheme}`,
      async () => {
        const page = await renderAt({
          page: "test/desktopBrowser.html",
          width: 1920,
          height: 940,
          colorScheme: scheme,
          api: desktopFixture().api,
        });
        try {
          await page.boxes("#page-overview");
          await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise((resolve) => setTimeout(resolve, 300));
          }, undefined);
          const result = await page.evaluate(() => {
            const visible = (el: Element) => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            };
            const small = [
              ...document.querySelectorAll(
                "#page-overview button, #page-overview a[href], #page-overview summary, #page-overview input, #page-overview select",
              ),
            ]
              .filter(visible)
              .filter((el) => {
                const r = el.getBoundingClientRect();
                return r.width < 24 || r.height < 24;
              })
              .map((el) => `${el.tagName.toLowerCase()}: ${el.textContent?.trim().slice(0, 40)}`);
            const right = document.querySelector(".overview-secondary")?.getBoundingClientRect();
            const covering = [
              ...document.querySelectorAll<HTMLElement>(".comms-bell, #dock, .dockrail"),
            ]
              .filter(visible)
              .filter((el) => {
                const r = el.getBoundingClientRect();
                return (
                  right !== undefined &&
                  r.left < right.right &&
                  r.right > right.left &&
                  r.top < right.bottom &&
                  r.bottom > right.top
                );
              })
              .map((el) => el.className || el.id);
            return { small, covering };
          }, undefined);
          expect(result.small).toEqual([]);
          expect(result.covering).toEqual([]);
          expect(page.errors()).toEqual([]);
        } finally {
          await page.close();
        }
      },
      BROWSER_TEST_TIMEOUT_MS,
    );
  }
});
