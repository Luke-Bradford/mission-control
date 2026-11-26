// @vitest-environment node
// A sessions-only hub (no repository) in the real App and the full shell: `/` arrives on Sessions,
// and Board, Planner and QA keep their address and show the one-line repository-required page with
// its link to Setup › Repos, which a keyboard reaches. With MC_NO_REPO_EVIDENCE_DIR set it also
// writes a PNG per case and a manifest.json to that folder (the retained evidence for this state).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CmuxSessionsView, REPO_REQUIRED_LINK, REPO_REQUIRED_TEXT } from "@mc/core";
import { afterAll, expect, it } from "vitest";
import {
  BROWSER_TEST_TIMEOUT_MS,
  browserSession,
  describeRendered,
  type RenderedPage,
} from "./browserRunner.ts";
import { desktopFixture } from "./desktopFixtures.ts";
import { CONFIG, NOW } from "./fixtures.ts";

const { renderAt } = browserSession();
const evidence = process.env.MC_NO_REPO_EVIDENCE_DIR;
const manifest: Record<string, unknown>[] = [];
const MIN = 60_000;

const SESSIONS: CmuxSessionsView = {
  ok: true,
  at: NOW,
  sessions: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      name: "pricing",
      owner: "operator",
      folder: "/Users/op/Dev/shop-app/pricing",
      repo: "shop-app",
      repoKey: "/Users/op/Dev/shop-app",
      state: "waiting",
      since: NOW - 4 * MIN,
      lastLine: "Line 1: moved 3 of 4 price tables",
      status: "Basket redesign",
      app: null,
      inbox: { unread: 0, newest: null },
      check: null,
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      name: "notes",
      owner: "operator",
      folder: "/Users/op/Dev/notes",
      repo: "notes",
      repoKey: "/Users/op/Dev/notes",
      state: "idle",
      since: NOW - 30 * MIN,
      lastLine: "Line 2: saved the meeting notes",
      status: null,
      app: null,
      inbox: { unread: 0, newest: null },
      check: null,
    },
  ],
  repos: [],
};

/** The desktop fixture as a sessions-only hub: no accounts, repositories, loops or crew. */
function noRepoApi(): Record<string, unknown> {
  const { crew: _crew, ...config } = CONFIG;
  return {
    ...desktopFixture("empty").api,
    "/api/config": { ...config, accounts: [], repos: [], loops: [] },
    "/api/repos": [],
    "/api/sessions": SESSIONS,
  };
}

async function open(
  path: string,
  width: number,
  height: number,
  colorScheme: "light" | "dark",
  selector: string,
): Promise<RenderedPage> {
  const page = await renderAt({
    page: "test/desktopBrowser.html",
    width,
    height,
    colorScheme,
    search: `?path=${encodeURIComponent(path)}`,
    api: noRepoApi(),
  });
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)), undefined);
  if (page.errors().length) throw new Error(page.errors().join("; "));
  await page.box(selector);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, undefined);
  return page;
}

async function capture(page: RenderedPage, name: string, facts: Record<string, unknown>) {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  await page.screenshot(join(evidence, `${name}.png`));
  manifest.push({ file: `${name}.png`, ...facts });
}

afterAll(() => {
  if (!evidence || manifest.length === 0) return;
  writeFileSync(
    join(evidence, "manifest.json"),
    `${JSON.stringify(
      {
        ticket: "mission-control#2265",
        fixture:
          "sessions-only hub: /api/repos is [], config has no accounts, repos, loops or crew",
        harness: "apps/web/test/desktopBrowser.html (the real App with the full shell)",
        captures: manifest,
      },
      null,
      2,
    )}\n`,
  );
});

const VIEWPORTS = [
  [1280, 900],
  [1920, 1080],
] as const;

describeRendered("A sessions-only hub (no repository)", () => {
  for (const scheme of ["light", "dark"] as const) {
    for (const [width, height] of VIEWPORTS) {
      it(
        `/ arrives on Sessions: ${width}x${height} ${scheme}`,
        async () => {
          const page = await open("/", width, height, scheme, "#page-sessions");
          try {
            const facts = await page.evaluate(
              () => ({
                path: location.pathname,
                rows: document.querySelectorAll("#page-sessions tr.sess-row").length,
                docWidth: document.documentElement.scrollWidth,
              }),
              undefined,
            );
            expect(facts.path).toBe("/sessions");
            expect(facts.rows).toBe(2);
            expect(facts.docWidth).toBeLessThanOrEqual(width);
            expect(page.errors()).toEqual([]);
            await capture(page, `root-to-sessions-${width}x${height}-${scheme}`, {
              opened: "/",
              ...facts,
              width,
              height,
              scheme,
            });
          } finally {
            await page.close();
          }
        },
        BROWSER_TEST_TIMEOUT_MS,
      );

      for (const path of ["/board", "/planner", "/qa"]) {
        it(
          `${path} shows the repository-required line: ${width}x${height} ${scheme}`,
          async () => {
            const page = await open(path, width, height, scheme, "#page-repo-required");
            try {
              const facts = await page.evaluate(
                () => ({
                  path: location.pathname,
                  h1: [...document.querySelectorAll("h1")].map((h) => h.textContent),
                  line: document.querySelector("#page-repo-required p")?.textContent ?? null,
                  href:
                    document.querySelector("#page-repo-required p a")?.getAttribute("href") ?? null,
                  docWidth: document.documentElement.scrollWidth,
                }),
                undefined,
              );
              expect(facts.path).toBe(path);
              expect(facts.h1).toHaveLength(1);
              expect(facts.line).toBe(REPO_REQUIRED_TEXT);
              expect(facts.href).toBe("/setup/repos");
              expect(facts.docWidth).toBeLessThanOrEqual(width);
              expect(page.errors()).toEqual([]);
              const name = `${path.slice(1)}-repo-required-${width}x${height}-${scheme}`;
              await capture(page, name, { opened: path, ...facts, width, height, scheme });

              // The keyboard reaches the link: focus it as Tab would and show the focus ring.
              await page.evaluate(() => {
                (document.querySelector("#page-repo-required p a") as HTMLElement).focus({
                  focusVisible: true,
                } as FocusOptions);
              }, undefined);
              await page.press("Shift+Tab");
              await page.press("Tab");
              const focused = await page.evaluate(
                () => document.activeElement?.textContent ?? null,
                undefined,
              );
              expect(focused).toBe(REPO_REQUIRED_LINK);
              await capture(page, `${name}-link-focused`, {
                opened: path,
                focused,
                width,
                height,
                scheme,
              });
            } finally {
              await page.close();
            }
          },
          BROWSER_TEST_TIMEOUT_MS,
        );
      }
    }
  }
});
