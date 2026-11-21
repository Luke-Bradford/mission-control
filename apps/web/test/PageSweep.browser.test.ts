// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { EVIDENCE_PAGE_PATHS } from "@mc/core";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { desktopFixture } from "./desktopFixtures.ts";

const { renderAt } = browserSession();
const evidence = process.env.MC_QA_EVIDENCE_DIR;
const SIZES = [
  [1920, 940],
  [2560, 1145],
] as const;

/** What the operator reads on a page, judged in a real browser at the sizes the crew uses. */
describeRendered("Every header page at 1920x940 and 2560x1145", () => {
  for (const [name, path] of Object.entries(EVIDENCE_PAGE_PATHS)) {
    for (const [width, height] of SIZES) {
      it(
        `${name} shows no raw markup or internal id, no empty panel and no cut-off page at ${width}x${height}`,
        async () => {
          const page = await renderAt({
            page: "test/desktopBrowser.html",
            width,
            height,
            search: `?path=${encodeURIComponent(path)}`,
            api: desktopFixture().api,
          });
          try {
            await page.evaluate(async () => {
              await document.fonts.ready;
              await new Promise((resolve) => setTimeout(resolve, 400));
            }, undefined);
            const found = await page.evaluate(() => {
              const problems: string[] = [];
              const shown = (el: Element) => {
                const r = el.getBoundingClientRect();
                const s = getComputedStyle(el);
                return r.width > 0 && r.height > 0 && s.visibility !== "hidden";
              };
              const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
              // raw markup and ids are read off the text nodes a person sees
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                const el = n.parentElement;
                const t = (n.textContent ?? "").trim();
                if (!el || !t || !shown(el)) continue;
                if (el.closest("script, style, .sr-only, code, pre, textarea, input")) continue;
                const tag = el.tagName.toLowerCase();
                if (/<\/?[a-z][^>]*>/i.test(t) || /&(amp|lt|gt|quot|#\d+);/.test(t))
                  problems.push(`raw markup in ${tag}: ${t.slice(0, 60)}`);
                if (/\*\*\S|\]\(https?:|`[^`]+`/.test(t))
                  problems.push(`raw markdown in ${tag}: ${t.slice(0, 60)}`);
                if (/\brun-[0-9a-f]{6,}|\b[0-9a-f]{32,}\b|\bnull\b|\bundefined\b|\[object /.test(t))
                  problems.push(`internal id or value in ${tag}: ${t.slice(0, 60)}`);
              }
              // a panel that carries a heading and nothing else is an empty tile
              for (const panel of document.querySelectorAll(".panel")) {
                if (!shown(panel)) continue;
                const body = [...panel.children].filter((c) => !c.matches(".ph, .panel-head"));
                const bodyText = body.map(text).join("");
                const media = panel.querySelector("svg, canvas, img, input, select, button, a");
                if (!bodyText && !media) problems.push(`empty panel: ${text(panel).slice(0, 40)}`);
              }
              const root = document.documentElement;
              if (root.scrollWidth > root.clientWidth + 1)
                problems.push(`page is wider than the window: ${root.scrollWidth}`);
              return problems;
            }, undefined);
            if (evidence) {
              mkdirSync(evidence, { recursive: true });
              await page.screenshot(join(evidence, `${name}-${width}.png`));
            }
            expect(found).toEqual([]);
            expect(page.errors()).toEqual([]);
          } finally {
            await page.close();
          }
        },
        BROWSER_TEST_TIMEOUT_MS,
      );
    }
  }
});
