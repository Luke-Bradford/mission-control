// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { EVIDENCE_PAGE_PATHS } from "@mc/core";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { desktopFixture } from "./desktopFixtures.ts";
import { NOW } from "./fixtures.ts";

const { renderAt } = browserSession();
const evidence = process.env.MC_QA_EVIDENCE_DIR;
const SIZES = [
  [1920, 940],
  [2560, 1145],
] as const;

/** One long, unbroken title: where text can only fit by being cut, it must say so with an ellipsis. */
const LONG_TITLE = `Unbroken${"x".repeat(300)}`;

/** The busy desktop fixture plus a very long ticket title and activity text, to stress every fit. */
function sweepApi() {
  const api = desktopFixture().api;
  const crew = api["/api/crew?shape=summary"] as { rows: Record<string, unknown>[] };
  crew.rows[1] = { ...crew.rows[1], ticketTitle: LONG_TITLE };
  api["/api/activity"] = [
    {
      runId: "run-1",
      at: NOW - 60_000,
      who: "guido-1",
      kind: "state",
      text: LONG_TITLE,
      ref: "shop-app#101",
      url: null,
      status: null,
      prs: [],
      summary: null,
    },
  ];
  return api;
}

/** What the operator reads on a page, judged in a real browser at the sizes the crew uses. */
describeRendered("Every header page at 1920x940 and 2560x1145", () => {
  for (const [name, path] of Object.entries(EVIDENCE_PAGE_PATHS)) {
    for (const [width, height] of SIZES) {
      it(
        `${name} shows no raw markup, internal id, empty panel, clipped text or bare name at ${width}x${height}`,
        async () => {
          const page = await renderAt({
            page: "test/desktopBrowser.html",
            width,
            height,
            search: `?path=${encodeURIComponent(path)}`,
            api: sweepApi(),
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
              // every seat and ticket name is a link (or a control) to somewhere
              const NAME = /\b[a-z][\w.-]*#\d+\b|\b[A-Z]{3,}-\d+\b/;
              const CONTROL =
                "button, summary, label, option, select, input, textarea, code, pre, h1, h2, h3, [role=button], [role=option], [role=tab], [role=link]";
              const names = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              for (let n = names.nextNode(); n; n = names.nextNode()) {
                const el = n.parentElement;
                const t = (n.textContent ?? "").trim();
                if (!el || !NAME.test(t) || !shown(el)) continue;
                // the Setup notification examples are fictional copy, not live names, and the Needs-you question band holds no links by design
                if (
                  el.closest("script, style, .sr-only, [aria-hidden=true], .notif, .needs-band-who")
                )
                  continue;
                if (el.closest(CONTROL)) continue;
                const link = el.closest("a");
                const href = link?.getAttribute("href") ?? "";
                if (!link || href === "" || href === "#")
                  problems.push(
                    `name is not a link in ${el.tagName.toLowerCase()} in ${el.parentElement?.className} / ${el.parentElement?.parentElement?.className}: ${t.slice(0, 60)}`,
                  );
              }
              // text cut by an ancestor that hides overflow, with no ellipsis and no scroll to reach it
              const hides = (v: string) => v === "hidden" || v === "clip";
              const scrolls = (v: string) => v === "auto" || v === "scroll";
              for (const el of document.querySelectorAll<HTMLElement>("body *")) {
                if (el.closest(".sr-only")) continue;
                if (parseFloat(getComputedStyle(el).textIndent) !== 0) continue;
                const own = [...el.childNodes].filter(
                  (c) => c.nodeType === Node.TEXT_NODE && (c.textContent ?? "").trim() !== "",
                );
                if (own.length === 0) continue;
                const range = document.createRange();
                range.setStartBefore(own[0] as Node);
                range.setEndAfter(own[own.length - 1] as Node);
                const text = range.getBoundingClientRect();
                if (text.width === 0 || text.height === 0) continue;
                let xScrolls = false;
                let yScrolls = false;
                let ellipsis = false;
                let cut = false;
                for (
                  let a: HTMLElement | null = el;
                  a && a !== document.body;
                  a = a.parentElement
                ) {
                  const s = getComputedStyle(a);
                  if (s.textOverflow === "ellipsis") ellipsis = true;
                  if (s.getPropertyValue("-webkit-line-clamp") !== "none") ellipsis = true;
                  if (scrolls(s.overflowX)) xScrolls = true;
                  if (scrolls(s.overflowY)) yScrolls = true;
                  const box = a.getBoundingClientRect();
                  if (
                    (!xScrolls &&
                      hides(s.overflowX) &&
                      (text.right > box.right + 1 || text.left < box.left - 1)) ||
                    (!yScrolls &&
                      hides(s.overflowY) &&
                      (text.bottom > box.bottom + 1 || text.top < box.top - 1))
                  ) {
                    cut = true;
                    break;
                  }
                }
                if (cut && !ellipsis)
                  problems.push(
                    `clipped text in ${el.tagName.toLowerCase()}.${el.className}: ${el.textContent?.trim().slice(0, 40)}`,
                  );
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
