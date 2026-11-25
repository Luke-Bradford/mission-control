// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CmuxSessionRow, CmuxSessionState, CmuxSessionsView } from "@mc/core";
import { expect, it } from "vitest";
import {
  BROWSER_TEST_TIMEOUT_MS,
  browserSession,
  describeRendered,
  type RenderedPage,
} from "./browserRunner.ts";
import { desktopFixture } from "./desktopFixtures.ts";
import { NOW } from "./fixtures.ts";

const { renderAt } = browserSession();
const evidence = process.env.MC_QA_EVIDENCE_DIR;
const MIN = 60_000;
const LONG =
  "Reworking the basket summary so the totals line up with the new price breakdown on mobile, then the receipt email, then the invoice PDF, then the order history page.";

const STATES: CmuxSessionState[] = ["waiting", "working", "working", "idle", "idle", "no-agent"];
const NAMES = ["pricing", "storefront", "GUIDO-1 · #2235", "FLIGHT · crew", "notes", "api server"];

function row(i: number, long: boolean): CmuxSessionRow {
  const state = STATES[i % STATES.length] as CmuxSessionState;
  const crew = i % 6 === 2 || i % 6 === 3;
  return {
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    name: i < NAMES.length ? (NAMES[i] as string) : `session ${i + 1}`,
    owner: crew ? "crew" : "operator",
    folder: crew
      ? `/Users/op/Dev/mc-crew/worktrees/mission-control/guido-1-${2200 + i}`
      : "/Users/op/Dev/shop-app/pricing",
    repo: crew ? "mission-control" : "shop-app",
    state,
    since: NOW - (4 + i * 7) * MIN,
    lastLine: long && i === 0 ? LONG : `Line ${i + 1}: moved 3 of 4 price tables`,
    status: i % 2 ? "Basket redesign" : null,
    app:
      i === 1
        ? { url: "http://localhost:5173", answers: true }
        : i === 5
          ? { url: "http://localhost:8080", answers: false }
          : null,
    inbox: { unread: i === 1 ? 1 : 0, newest: i === 1 ? "The pricing API is back." : null },
  };
}

const view = (n: number, long = false): CmuxSessionsView => ({
  ok: true,
  at: NOW,
  sessions: Array.from({ length: n }, (_, i) => row(i, long)),
});

async function open(
  width: number,
  height: number,
  colorScheme: "light" | "dark",
  sessions: CmuxSessionsView,
): Promise<RenderedPage> {
  const page = await renderAt({
    page: "test/desktopBrowser.html",
    width,
    height,
    colorScheme,
    search: "?path=/sessions",
    api: { ...desktopFixture().api, "/api/sessions": sessions },
  });
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)), undefined);
  if (page.errors().length) throw new Error(page.errors().join("; "));
  await page.box("#page-sessions");
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, undefined);
  return page;
}

const metrics = (page: RenderedPage) =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>("#page-sessions tr.sess-row")];
    const visible = rows.filter((r) => r.getBoundingClientRect().bottom <= innerHeight);
    const small = [
      ...document.querySelectorAll<HTMLElement>(
        "#page-sessions button, #page-sessions tr.sess-row",
      ),
    ]
      .map((e) => e.getBoundingClientRect())
      .filter((b) => b.width < 24 || b.height < 24).length;
    const last = document.querySelector<HTMLElement>("#page-sessions .sess-last");
    const page = document.querySelector<HTMLElement>("#page-sessions") as HTMLElement;
    const dock = document.querySelector<HTMLElement>("#dock");
    return {
      docWidth: document.documentElement.scrollWidth,
      docHeight: document.documentElement.scrollHeight,
      rows: rows.length,
      firstScreen: visible.length,
      rowHeights: rows.map((r) => Math.round(r.getBoundingClientRect().height)),
      small,
      lastClipped: last ? last.scrollWidth > last.clientWidth : false,
      lastEllipsis: last ? getComputedStyle(last).textOverflow : "",
      lastTitle: last?.title ?? "",
      pageBottom: page.getBoundingClientRect().bottom,
      dockLeft: dock?.getBoundingClientRect().left ?? null,
      pageRight: page.getBoundingClientRect().right,
      // Words that must read whole: each state pill, owner tag, unread control and each app's
      // address and health, inside
      // their own box and inside their cell's content box.
      clippedLabels: [
        ...document.querySelectorAll<HTMLElement>(
          [
            "#page-sessions tr.sess-row .pill",
            "#page-sessions .sess-ans",
            "#page-sessions .sess-applink",
            "#page-sessions .sess-tag",
            "#page-sessions .sess-inbox",
          ].join(", "),
        ),
      ]
        .filter((el) => {
          const cell = el.closest("td") as HTMLElement;
          const cs = getComputedStyle(cell);
          const c = cell.getBoundingClientRect();
          const b = el.getBoundingClientRect();
          const left = c.left + Number.parseFloat(cs.paddingLeft) - 0.5;
          const right = c.right - Number.parseFloat(cs.paddingRight) + 0.5;
          return el.scrollWidth > el.clientWidth || b.left < left || b.right > right;
        })
        .map((el) => el.textContent),
    };
  }, undefined);

async function capture(page: RenderedPage, name: string) {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  await page.screenshot(join(evidence, `${name}.png`));
}

describeRendered("Sessions page in the app, beside the FLIGHT dock", () => {
  for (const [width, height] of [
    [1920, 940],
    [2560, 1145],
    [1600, 700],
    [1280, 800],
  ] as const)
    for (const scheme of ["light", "dark"] as const)
      it(
        `fits six sessions with a long last line at ${width}×${height} in ${scheme}`,
        async () => {
          const page = await open(width, height, scheme, view(6, true));
          try {
            await capture(page, `sessions-${width}x${height}-${scheme}-6`);
            const m = await metrics(page);
            expect(m.docWidth).toBeLessThanOrEqual(width);
            expect(m.docHeight).toBeLessThanOrEqual(height);
            expect(m.rows).toBe(6);
            // The question's answer: every one of six sessions on the first screen.
            if (height >= 900) expect(m.firstScreen).toBe(6);
            for (const h of m.rowHeights) expect(h).toBeLessThanOrEqual(40);
            expect(m.clippedLabels).toEqual([]);
            expect(m.small).toBe(0);
            // The long last line is cut with an ellipsis and its full text stays in the title.
            expect(m.lastEllipsis).toBe("ellipsis");
            expect(m.lastClipped).toBe(true);
            expect(m.lastTitle).toBe(LONG);
            expect(m.pageBottom).toBeLessThanOrEqual(height);
            if (m.dockLeft !== null) expect(m.pageRight).toBeLessThanOrEqual(m.dockLeft);
          } finally {
            await page.close();
          }
        },
        BROWSER_TEST_TIMEOUT_MS,
      );

  for (const scheme of ["light", "dark"] as const)
    it(
      `reads the newest inbox message from the keyboard at 1920×940 in ${scheme}`,
      async () => {
        const page = await open(1920, 940, scheme, view(6));
        try {
          await page.evaluate(() => {
            document.querySelector<HTMLElement>("#page-sessions button.sess-inbox")?.focus();
          }, undefined);
          await page.press("Enter");
          await page.evaluate(
            () => new Promise((resolve) => requestAnimationFrame(() => resolve(null))),
            undefined,
          );
          await capture(page, `sessions-1920x940-${scheme}-inbox-open`);
          const m = await page.evaluate(() => {
            const button = document.querySelector<HTMLElement>("button.sess-inbox");
            const panel = document.getElementById(button?.getAttribute("aria-controls") ?? "");
            const box = panel?.getBoundingClientRect();
            return {
              focused: document.activeElement === button,
              expanded: button?.getAttribute("aria-expanded"),
              text: panel?.textContent ?? "",
              onScreen: box ? box.height > 0 && box.bottom <= innerHeight : false,
              clipped: panel ? panel.scrollWidth > panel.clientWidth : true,
            };
          }, undefined);
          expect(m.focused).toBe(true);
          expect(m.expanded).toBe("true");
          expect(m.text).toContain("The pricing API is back.");
          expect(m.onScreen).toBe(true);
          expect(m.clipped).toBe(false);
          // Enter on the disclosure never opens the session.
          expect(page.requests().some((r) => r.path.endsWith("/focus"))).toBe(false);
        } finally {
          await page.close();
        }
      },
      BROWSER_TEST_TIMEOUT_MS,
    );

  const LONG_NAME = `basket-${"and-receipts-".repeat(25)}`.slice(0, 300);
  for (const scheme of ["light", "dark"] as const)
    it(
      `reads a 300-character session name in full from the keyboard at 1280×800 in ${scheme}`,
      async () => {
        const base = view(6);
        const sessions: CmuxSessionsView = base.ok
          ? {
              ...base,
              sessions: base.sessions.map((s, i) => (i === 0 ? { ...s, name: LONG_NAME } : s)),
            }
          : base;
        const page = await open(1280, 800, scheme, sessions);
        try {
          const before = await page.evaluate(() => {
            const name = document.querySelector<HTMLElement>("tr.sess-row .sess-name");
            return name ? name.scrollWidth > name.clientWidth : false;
          }, undefined);
          // Truncated until the row has focus.
          expect(before).toBe(true);
          let onRow = false;
          for (let i = 0; i < 80 && !onRow; i++) {
            await page.press("Tab");
            onRow = await page.evaluate(
              () => document.activeElement === document.querySelector("tr.sess-row"),
              undefined,
            );
          }
          expect(onRow).toBe(true);
          await capture(page, `sessions-1280x800-${scheme}-long-name-focused`);
          const m = await page.evaluate(() => {
            const row = document.querySelector<HTMLElement>("tr.sess-row") as HTMLElement;
            const name = row.querySelector<HTMLElement>(".sess-name") as HTMLElement;
            const scroll = document.querySelector<HTMLElement>(".sess-scroll") as HTMLElement;
            const cell = name.closest("td") as HTMLElement;
            const c = cell.getBoundingClientRect();
            const labels = [...row.querySelectorAll<HTMLElement>(".sess-tag, .sess-inbox")];
            return {
              text: name.textContent,
              clipped:
                name.scrollWidth > name.clientWidth || name.scrollHeight > name.clientHeight + 1,
              inCell: name.getBoundingClientRect().bottom <= c.bottom + 0.5,
              inScroller:
                name.getBoundingClientRect().bottom <= scroll.getBoundingClientRect().bottom,
              labelsClipped: labels.filter(
                (l) =>
                  l.scrollWidth > l.clientWidth || l.getBoundingClientRect().right > c.right + 0.5,
              ).length,
            };
          }, undefined);
          expect(m.text).toBe(LONG_NAME);
          expect(m.clipped).toBe(false);
          expect(m.inCell).toBe(true);
          expect(m.inScroller).toBe(true);
          expect(m.labelsClipped).toBe(0);
        } finally {
          await page.close();
        }
      },
      BROWSER_TEST_TIMEOUT_MS,
    );

  const LONG_FOLDER = `/Users/op/Dev/${"client-projects/".repeat(10)}storefront-checkout`;
  const LONG_REPO = `storefront-${"checkout-".repeat(8)}service`;
  const LONG_URL = `http://localhost:5173/${"basket/receipts/".repeat(10)}preview`;
  for (const scheme of ["light", "dark"] as const)
    it(
      `reads a long folder, repo and app address in full from the keyboard at 1280×800 in ${scheme}`,
      async () => {
        const base = view(6);
        const sessions: CmuxSessionsView = base.ok
          ? {
              ...base,
              sessions: base.sessions.map((s, i) =>
                i === 1
                  ? {
                      ...s,
                      folder: LONG_FOLDER,
                      repo: LONG_REPO,
                      app: { url: LONG_URL, answers: true },
                    }
                  : s,
              ),
            }
          : base;
        const page = await open(1280, 800, scheme, sessions);
        const cells = () =>
          page.evaluate((repo) => {
            // the rows are sorted by state, so find the long one by its repo
            const row = [...document.querySelectorAll<HTMLElement>("tr.sess-row")].find((r) =>
              r.textContent?.includes(repo),
            ) as HTMLElement;
            const scroll = document.querySelector<HTMLElement>(".sess-scroll") as HTMLElement;
            const folder = row.querySelector<HTMLElement>(".sess-folder") as HTMLElement;
            const link = row.querySelector<HTMLElement>(".sess-applink") as HTMLElement;
            const clipped = (el: HTMLElement) => {
              const c = (el.closest("td") as HTMLElement).getBoundingClientRect();
              const b = el.getBoundingClientRect();
              return (
                el.scrollWidth > el.clientWidth ||
                el.scrollHeight > el.clientHeight + 1 ||
                b.right > c.right + 0.5 ||
                b.bottom > c.bottom + 0.5 ||
                b.bottom > scroll.getBoundingClientRect().bottom
              );
            };
            return {
              focused: document.activeElement === row || row.contains(document.activeElement),
              folderText: folder.textContent,
              linkText: link.textContent,
              folderClipped: clipped(folder),
              linkClipped: clipped(link),
              answerClipped: clipped(row.querySelector<HTMLElement>(".sess-ans") as HTMLElement),
            };
          }, LONG_REPO);
        try {
          const before = await cells();
          // Cut short until the row has focus.
          expect(before.folderClipped).toBe(true);
          expect(before.linkClipped).toBe(true);
          let m = before;
          for (let i = 0; i < 80 && !m.focused; i++) {
            await page.press("Tab");
            m = await cells();
          }
          expect(m.focused).toBe(true);
          await capture(page, `sessions-1280x800-${scheme}-long-folder-app-focused`);
          expect(m.folderText).toBe(`${LONG_FOLDER.replace("/Users/op", "~")} · ${LONG_REPO}`);
          expect(m.linkText).toBe(LONG_URL.replace("http://", ""));
          expect(m.folderClipped).toBe(false);
          expect(m.linkClipped).toBe(false);
          expect(m.answerClipped).toBe(false);
        } finally {
          await page.close();
        }
      },
      BROWSER_TEST_TIMEOUT_MS,
    );

  for (const n of [0, 1, 50])
    it(
      `shows ${n} sessions at 1920×940 without page scroll`,
      async () => {
        const page = await open(1920, 940, "dark", view(n));
        try {
          await capture(page, `sessions-1920x940-dark-${n}`);
          const m = await metrics(page);
          expect(m.docWidth).toBeLessThanOrEqual(1920);
          expect(m.docHeight).toBeLessThanOrEqual(940);
          expect(m.rows).toBe(n);
          if (n === 0) {
            const text = await page.evaluate(
              () => document.querySelector("#page-sessions")?.textContent ?? "",
              undefined,
            );
            expect(text).toContain("No cmux workspaces are open.");
          }
          if (n === 50) {
            // The table scrolls inside its panel; the last row can be brought into view.
            expect((await page.reachable("tr.sess-row:last-child", ".sess-scroll"))[0]).toBe(true);
            expect(m.firstScreen).toBeGreaterThanOrEqual(8);
          }
        } finally {
          await page.close();
        }
      },
      BROWSER_TEST_TIMEOUT_MS,
    );
});
