// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CmuxSessionRow, CmuxSessionState, CmuxSessionsView } from "@mc/core";
import { afterAll, expect, it } from "vitest";
import {
  BROWSER_TEST_TIMEOUT_MS,
  browserSession,
  describeRendered,
  type RenderedPage,
  type ScreenshotClip,
} from "./browserRunner.ts";
import { desktopFixture } from "./desktopFixtures.ts";
import { NOW } from "./fixtures.ts";

const { renderAt } = browserSession();
const evidence = process.env.MC_QA_EVIDENCE_DIR;
const MIN = 60_000;
const LONG =
  "Reworking the basket summary so the totals line up with the new price breakdown on mobile, then the receipt email, then the invoice PDF, then the order history page.";

const LONG_COMMAND =
  "pnpm -s vitest run apps/server/test/cmux-session-checks.test.ts apps/server/test/cmux-sessions-api.test.ts apps/web/test/CmuxSessions.test.tsx";

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
    repoKey: crew ? "/Users/op/Dev/mission-control" : "/Users/op/Dev/shop-app",
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
    check:
      i === 0
        ? {
            state: "failed",
            at: NOW - 5 * MIN,
            command: long ? LONG_COMMAND : "pnpm test",
            why: "idle",
          }
        : i === 1
          ? { state: "running", at: NOW - MIN, command: "pnpm test", why: "operator" }
          : null,
    branch: `feature/${2262 + i}-cmux-sidebar-${"review-state-".repeat(3)}`,
    ticket: { number: 2262 + i, repoId: crew ? "mission-control" : "shop-app" },
    pr: {
      number: 2258 + i,
      url: `https://github.com/acme/${crew ? "mission-control" : "shop-app"}/pull/${2258 + i}`,
      isDraft: false,
      ci: i % 3 === 0 ? "pending" : i % 3 === 1 ? "passing" : "failing",
      review: i % 3 === 0 ? "requested" : i % 3 === 1 ? "approved" : "changes",
    },
  };
}

const view = (n: number, long = false): CmuxSessionsView => ({
  ok: true,
  at: NOW,
  sessions: Array.from({ length: n }, (_, i) => row(i, long)),
  repos:
    n === 0
      ? []
      : [
          {
            repo: "/Users/op/Dev/shop-app",
            name: "shop-app",
            on: true,
            source: "page",
            commands: long ? [LONG_COMMAND] : ["pnpm lint", "pnpm test"],
            pageCommands: long ? [LONG_COMMAND] : ["pnpm lint", "pnpm test"],
          },
          {
            repo: "/Users/op/Dev/mission-control",
            name: "mission-control",
            on: false,
            source: "repo",
            commands: ["pnpm -s lint", "pnpm -s typecheck"],
            pageCommands: [],
          },
        ],
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
        "#page-sessions button, #page-sessions tr.sess-row, #page-sessions .sess-sidebar-toggle",
      ),
    ]
      .map((e) => e.getBoundingClientRect())
      .filter((b) => b.width < 24 || b.height < 24).length;
    const last = document.querySelector<HTMLElement>("#page-sessions .sess-last");
    const page = document.querySelector<HTMLElement>("#page-sessions") as HTMLElement;
    const dock = document.querySelector<HTMLElement>("#dock");
    const clipped = (el: HTMLElement) => {
      const cs = getComputedStyle(el);
      const b = el.getBoundingClientRect();
      const right = b.right - Number.parseFloat(cs.paddingRight) + 0.5;
      return (
        el.scrollWidth > el.clientWidth ||
        (el.firstElementChild?.getBoundingClientRect().right ?? 0) > right
      );
    };
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
      clippedHeadings: [...document.querySelectorAll<HTMLElement>("#page-sessions th")]
        .filter((el) => !el.querySelector(".sr-only"))
        .filter(clipped)
        .map((el) => el.textContent),
      clippedAges: [
        ...document.querySelectorAll<HTMLElement>("#page-sessions tr.sess-row td.num[title]"),
      ]
        .filter((el) => el.scrollWidth > el.clientWidth)
        .map((el) => el.textContent),
      // Words that must read whole: each state pill, owner tag, unread control and each app's
      // address and health, inside
      // their own box and inside their cell's content box.
      clippedLabels: [
        ...document.querySelectorAll<HTMLElement>(
          [
            "#page-sessions tr.sess-row .pill",
            "#page-sessions .sess-ans",
            "#page-sessions .sess-tag",
            "#page-sessions .sess-inbox",
            "#page-sessions .sess-prline > a",
            "#page-sessions .sess-prline > span",
            "#page-sessions .sess-acts button",
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

/** What each kept image is, for the evidence manifest (see docs/runbooks/visual-qa.md). */
interface Shot {
  image: string;
  phase: "before" | "after";
  scope: "viewport" | "focused";
  width: number;
  height: number;
  scheme: "light" | "dark" | "browser default";
  state: string;
  clip?: ScreenshotClip;
  source?: string;
}
const shots: Shot[] = [];

async function capture(
  page: RenderedPage,
  name: string,
  about: Omit<Shot, "image"> | null = null,
  clip?: ScreenshotClip,
) {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  await page.screenshot(join(evidence, `${name}.png`), clip);
  if (about !== null) shots.push({ image: `${name}.png`, ...about, ...(clip ? { clip } : {}) });
}

const head = () => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
};

// The manifest binds every kept image to the commit it was rendered from.
afterAll(() => {
  if (!evidence || shots.length === 0) return;
  writeFileSync(
    join(evidence, "sessions-manifest.json"),
    `${JSON.stringify(
      {
        page: "/sessions",
        renderedSource: head(),
        harness:
          "apps/web/test/CmuxSessions.browser.test.ts in the real app shell (test/desktopBrowser.html)",
        browser: "headless Chromium via the repo's browser runner, device scale 1, zoom 100%",
        data: "fixture rows from this test; the desktop fixture for the rest of the shell",
        clock: new Date(NOW).toISOString(),
        capturedAt: new Date().toISOString(),
        baseline:
          "The /sessions address is new: on main it renders the shell's Page not found panel. The before images are that panel, rendered by this head's shell at an address with no page (so the header already shows the Sessions tab, which main's does not).",
        shots,
      },
      null,
      2,
    )}\n`,
  );
});

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
            await capture(page, `sessions-${width}x${height}-${scheme}-6`, {
              phase: "after",
              scope: "viewport",
              width,
              height,
              scheme,
              state: "six sessions across two repos, one waiting, two apps, a long last line",
            });
            const m = await metrics(page);
            expect(m.docWidth).toBeLessThanOrEqual(width);
            expect(m.docHeight).toBeLessThanOrEqual(height);
            expect(m.rows).toBe(6);
            // The question's answer: every one of six sessions on the first screen.
            if (height >= 900) expect(m.firstScreen).toBe(6);
            for (const h of m.rowHeights) expect(h).toBeLessThanOrEqual(40);
            expect(m.clippedHeadings).toEqual([]);
            expect(m.clippedAges).toEqual([]);
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
      `reads a long branch in full from the keyboard at 1280×800 in ${scheme}`,
      async () => {
        const page = await open(1280, 800, scheme, view(6, true));
        try {
          const branch = await page.evaluate(() => {
            const button = document.querySelector<HTMLElement>(
              ".sess-branch-toggle",
            ) as HTMLElement;
            return button.textContent ?? "";
          }, undefined);
          let open = false;
          for (let i = 0; i < 80 && !open; i++) {
            await page.press("Tab");
            open = await page.evaluate(
              () => document.activeElement?.classList.contains("sess-branch-toggle") ?? false,
              undefined,
            );
          }
          expect(open).toBe(true);
          await page.press("Enter");
          const detail = await page.evaluate(() => {
            const button = document.activeElement as HTMLElement;
            const panel = document.getElementById(button.getAttribute("aria-controls") ?? "");
            const row = button.closest("tr") as HTMLElement;
            return {
              expanded: button.getAttribute("aria-expanded"),
              text: panel?.textContent ?? "",
              onScreen: (panel?.getBoundingClientRect().height ?? 0) > 0,
              rowHeight: row.getBoundingClientRect().height,
            };
          }, undefined);
          expect(detail.expanded).toBe("true");
          expect(detail.text).toContain(branch);
          expect(detail.onScreen).toBe(true);
          expect(detail.rowHeight).toBeLessThanOrEqual(40);
          const layout = await metrics(page);
          expect(layout.clippedHeadings).toEqual([]);
          expect(layout.clippedLabels).toEqual([]);
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
            const folder = row.querySelector<HTMLElement>(".sess-folder-toggle") as HTMLElement;
            const link = row.querySelector<HTMLElement>(".sess-applink") as HTMLElement;
            const detail = row.nextElementSibling?.classList.contains("sess-folder-detail")
              ? row.nextElementSibling
              : null;
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
              folderFocused: document.activeElement === folder,
              folderText: folder.textContent,
              linkText: link.textContent,
              folderClipped: clipped(folder),
              linkClipped: clipped(link),
              answerClipped: clipped(row.querySelector<HTMLElement>(".sess-ans") as HTMLElement),
              detailText: detail?.textContent ?? "",
              detailHeight: detail?.firstElementChild?.getBoundingClientRect().height ?? 0,
              rowHeight: row.getBoundingClientRect().height,
            };
          }, LONG_REPO);
        try {
          const before = await cells();
          // Cut short until the row has focus.
          expect(before.folderClipped).toBe(true);
          expect(before.linkClipped).toBe(true);
          let m = before;
          for (let i = 0; i < 80 && !m.folderFocused; i++) {
            await page.press("Tab");
            m = await cells();
          }
          expect(m.folderFocused).toBe(true);
          await page.press("Enter");
          m = await cells();
          await capture(page, `sessions-1280x800-${scheme}-long-folder-app-focused`);
          expect(m.linkText).toBe(LONG_URL.replace("http://", ""));
          expect(m.answerClipped).toBe(false);
          expect(m.detailText).toContain(LONG_FOLDER.replace("/Users/op", "~"));
          expect(m.detailText).toContain(LONG_REPO);
          expect(m.detailText).toContain(LONG_URL.replace("http://", ""));
          expect(m.detailHeight).toBeLessThanOrEqual(96);
          expect(m.rowHeight).toBeLessThanOrEqual(40);
          const layout = await metrics(page);
          expect(layout.clippedHeadings).toEqual([]);
          expect(layout.clippedLabels).toEqual([]);
        } finally {
          await page.close();
        }
      },
      BROWSER_TEST_TIMEOUT_MS,
    );

  for (const scheme of ["light", "dark"] as const)
    it(
      `reads a long check command and its time, row and repo line, from the keyboard at 1280×800 in ${scheme}`,
      async () => {
        const page = await open(1280, 800, scheme, view(6, true));
        const read = () =>
          page.evaluate((command) => {
            const scroll = document.querySelector<HTMLElement>(".sess-scroll") as HTMLElement;
            const row = [...document.querySelectorAll<HTMLElement>("tr.sess-row")].find((r) =>
              r.querySelector(".sess-check span")?.getAttribute("title")?.includes(command),
            ) as HTMLElement;
            const detail = row.querySelector<HTMLElement>(".sess-check-detail") as HTMLElement;
            const cell = (detail.closest("td") as HTMLElement).getBoundingClientRect();
            const d = detail.getBoundingClientRect();
            const line = [...document.querySelectorAll<HTMLElement>(".sess-repo")].find((l) =>
              l.querySelector(".sess-repo-cmds")?.textContent?.includes(command),
            ) as HTMLElement;
            const cmds = line.querySelector<HTMLElement>(".sess-repo-cmds") as HTMLElement;
            const active = document.activeElement;
            return {
              rowFocused: active === row || row.contains(active),
              lineFocused: line.contains(active),
              detailText: detail.textContent ?? "",
              detailShown:
                d.width > 0 &&
                d.height > 0 &&
                detail.scrollWidth <= detail.clientWidth &&
                d.right <= cell.right + 0.5 &&
                d.bottom <= cell.bottom + 0.5 &&
                d.bottom <= scroll.getBoundingClientRect().bottom,
              cmdsText: cmds.textContent ?? "",
              cmdsClipped:
                cmds.scrollWidth > cmds.clientWidth || cmds.scrollHeight > cmds.clientHeight + 1,
            };
          }, LONG_COMMAND);
        try {
          let m = await read();
          // Hidden or cut short until the keyboard reaches them.
          expect(m.detailShown).toBe(false);
          expect(m.cmdsClipped).toBe(true);
          for (let i = 0; i < 80 && !m.rowFocused; i++) {
            await page.press("Tab");
            m = await read();
          }
          expect(m.rowFocused).toBe(true);
          await capture(page, `sessions-1280x800-${scheme}-long-check-focused`);
          expect(m.detailText).toContain(LONG_COMMAND);
          expect(m.detailText).toMatch(/ · \S/);
          expect(m.detailShown).toBe(true);
          for (let i = 0; i < 80 && !m.lineFocused; i++) {
            await page.press("Tab");
            m = await read();
          }
          expect(m.lineFocused).toBe(true);
          await capture(page, `sessions-1280x800-${scheme}-long-repo-checks-focused`);
          expect(m.cmdsText).toBe(LONG_COMMAND);
          expect(m.cmdsClipped).toBe(false);
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

describeRendered("Sessions page review evidence: before, after and the Write route", () => {
  for (const [width, height] of [
    [1920, 940],
    [2560, 1145],
  ] as const)
    for (const scheme of ["light", "dark"] as const) {
      it(
        `before: main had no page at this address, at ${width}×${height} in ${scheme}`,
        async () => {
          const page = await renderAt({
            page: "test/desktopBrowser.html",
            width,
            height,
            colorScheme: scheme,
            search: "?path=/sessions-before-2235",
            api: desktopFixture().api,
          });
          try {
            await page.box("#page-not-found");
            await page.evaluate(() => document.fonts.ready.then(() => null), undefined);
            await capture(page, `sessions-before-${width}x${height}-${scheme}`, {
              phase: "before",
              scope: "viewport",
              width,
              height,
              scheme,
              state: "Page not found: the address had no page before this change",
              source: "reconstructed with this head's shell at an address with no page",
            });
            const text = await page.evaluate(
              () => document.querySelector("#page-not-found")?.textContent ?? "",
              undefined,
            );
            expect(text).toContain("Page not found");
          } finally {
            await page.close();
          }
        },
        BROWSER_TEST_TIMEOUT_MS,
      );

      it(
        `the table up close with Write open, at ${width}×${height} in ${scheme}`,
        async () => {
          const page = await open(width, height, scheme, view(6, true));
          try {
            const table = await page.box("#page-sessions");
            const clip = {
              x: Math.floor(table.x),
              y: Math.floor(table.y),
              width: Math.ceil(table.width),
              height: Math.ceil(table.height),
            };
            await capture(
              page,
              `sessions-${width}x${height}-${scheme}-table`,
              {
                phase: "after",
                scope: "focused",
                width,
                height,
                scheme,
                state: "the Sessions panel at normal density, long last line cut with an ellipsis",
                source: `crop of sessions-${width}x${height}-${scheme}-6.png's page`,
              },
              clip,
            );
            await page.click("tr.sess-row button.sess-write");
            await page.box("tr.sess-composer input");
            await capture(page, `sessions-${width}x${height}-${scheme}-write-open`, {
              phase: "after",
              scope: "viewport",
              width,
              height,
              scheme,
              state: "Write clicked on the first row: its one-line composer is open and focused",
            });
            const m = await page.evaluate(() => {
              const input = document.querySelector<HTMLElement>("tr.sess-composer input");
              const b = input?.getBoundingClientRect();
              return {
                focused: document.activeElement === input,
                onScreen: b ? b.height > 0 && b.bottom <= innerHeight : false,
                docHeight: document.documentElement.scrollHeight,
              };
            }, undefined);
            expect(m.focused).toBe(true);
            expect(m.onScreen).toBe(true);
            expect(m.docHeight).toBeLessThanOrEqual(height);
            // opening the composer sends nothing
            expect(page.requests().some((r) => r.path.endsWith("/send"))).toBe(false);
          } finally {
            await page.close();
          }
        },
        BROWSER_TEST_TIMEOUT_MS,
      );
    }
});
