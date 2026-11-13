// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { rosterApi, rosterRows } from "./agentRosterFixture.ts";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";

const { renderAt } = browserSession();

/** The operator's real CSS viewports (dashboard-layout.md) plus the common laptop one. */
const SIZES = [
  [1600, 1000],
  [1920, 940],
  [2560, 1145],
] as const;

const seatAt = `?at=${encodeURIComponent("/agent/flight-1")}`;
const chosen = `#roster [aria-current="true"]`;

describeRendered("Agents roster in a browser", () => {
  for (const [width, height] of SIZES) {
    for (const theme of ["dark", "light"] as const) {
      it(
        `fits nine seats in its frame with no cut text at ${width}x${height}, ${theme}`,
        async () => {
          const rows = rosterRows(9);
          const page = await renderAt({
            page: "test/agentV2Browser.html",
            width,
            height,
            colorScheme: theme,
            search: seatAt,
            api: rosterApi(rows),
          });
          await page.box(".seat-card");
          const r = await page.evaluate(() => {
            const frame = document.querySelector<HTMLElement>(".roster-list");
            const cut = (e: Element) =>
              e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1;
            return {
              cards: document.querySelectorAll(".seat-card").length,
              scrolls: frame ? frame.scrollHeight > frame.clientHeight + 1 : true,
              pageScrolls: document.documentElement.scrollWidth > innerWidth + 1,
              cutText: [...document.querySelectorAll(".seat-name, .seat-role, .seat-work, .pill")]
                .filter((e) => cut(e))
                .map((e) => e.textContent),
              outside: [...document.querySelectorAll(".seat-card")]
                .filter((c) => {
                  const a = c.getBoundingClientRect();
                  const f = (frame as HTMLElement).getBoundingClientRect();
                  return a.top < f.top - 1 || a.bottom > f.bottom + 1 || a.right > f.right + 1;
                })
                .map((c) => (c as HTMLElement).dataset.seat),
            };
          }, null);
          const where = `${width}x${height}, ${theme}`;
          expect(r.cards, where).toBe(9);
          expect(r.cutText, `${where}: no cut text`).toEqual([]);
          expect(r.scrolls, `${where}: nine seats fit without scrolling`).toBe(false);
          expect(r.outside, `${where}: every card sits inside the frame`).toEqual([]);
          expect(r.pageScrolls, `${where}: the page does not scroll sideways`).toBe(false);
          const shots = process.env.MC_AGENT_ROSTER_SHOTS;
          if (shots) {
            mkdirSync(shots, { recursive: true });
            await page.screenshot(join(shots, `roster-${width}x${height}-${theme}.png`));
          }
          await page.close();
        },
        BROWSER_TEST_TIMEOUT_MS,
      );
    }
  }

  it(
    "click, Enter, j, k and the address each choose a seat, and Back returns to the last one",
    async () => {
      const rows = rosterRows(5);
      const page = await renderAt({
        page: "test/agentV2Browser.html",
        width: 1600,
        height: 1000,
        search: seatAt,
        api: rosterApi(rows),
      });
      await page.box(".seat-card");
      const state = () =>
        page.evaluate(
          () => ({
            path: location.pathname,
            on: document.querySelector<HTMLElement>('#roster [aria-current="true"]')?.dataset.seat,
            count: history.length,
          }),
          null,
        );
      expect((await state()).on, "the address chooses the first seat").toBe("flight-1");

      await page.click('[data-seat="fao-2"]');
      expect(await state(), "click").toMatchObject({ path: "/agent/fao-2", on: "fao-2" });

      await page.press("Enter"); // the focused card is the one just clicked
      expect(await state(), "Enter keeps that seat").toMatchObject({ on: "fao-2" });

      await page.press("j");
      const afterJ = await state();
      expect(afterJ.on, "j steps down the roster").toBe("guido-3");
      expect(afterJ.path).toBe("/agent/guido-3");

      await page.press("k");
      expect((await state()).on, "k steps back up").toBe("fao-2");

      await page.press("j");
      await page.press("j");
      expect((await state()).on).toBe("inco-4");
      await page.evaluate(() => history.back(), null);
      await page.box(chosen);
      expect((await state()).on, "Back returns to the last seat").toBe("guido-3");
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "tabs to a card and Enter chooses it",
    async () => {
      const page = await renderAt({
        page: "test/agentV2Browser.html",
        width: 1600,
        height: 1000,
        search: seatAt,
        api: rosterApi(rosterRows(4)),
      });
      await page.box(".seat-card");
      await page.evaluate(
        () => document.querySelector<HTMLElement>('[data-seat="fao-2"]')?.focus(),
        null,
      );
      await page.press("Enter");
      const on = await page.evaluate(
        () => document.querySelector<HTMLElement>('#roster [aria-current="true"]')?.dataset.seat,
        null,
      );
      expect(on).toBe("fao-2");
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "groups 25 seats over three repos, folds a group and scrolls with the chosen seat in view",
    async () => {
      const rows = rosterRows(25, ["alpha", "beta", "gamma"]);
      const page = await renderAt({
        page: "test/agentV2Browser.html",
        width: 1600,
        height: 1000,
        search: seatAt,
        api: rosterApi(rows),
      });
      await page.box(".seat-card");
      const frame = () =>
        page.evaluate(() => {
          const list = document.querySelector<HTMLElement>(".roster-list");
          const on = document.querySelector<HTMLElement>('#roster [aria-current="true"]');
          const f = list?.getBoundingClientRect();
          const c = on?.getBoundingClientRect();
          return {
            repos: [...document.querySelectorAll(".roster-repo")].map((e) => e.textContent),
            scrolls: list ? list.scrollHeight > list.clientHeight + 1 : false,
            overflowY: list ? getComputedStyle(list).overflowY : "",
            pageScrolls: document.documentElement.scrollHeight > innerHeight + 1,
            inView: !!(f && c && c.top >= f.top - 1 && c.bottom <= f.bottom + 1),
            on: on?.dataset.seat,
          };
        }, null);
      const first = await frame();
      expect(first.repos).toEqual(["alpha", "beta", "gamma"]);
      expect(first.scrolls, "25 seats scroll inside the roster").toBe(true);
      expect(first.overflowY).toBe("auto");
      expect(first.pageScrolls, "the page itself does not scroll").toBe(false);

      // j down the whole roster: the chosen seat is in the frame every step
      for (let i = 0; i < 24; i++) {
        await page.press("j");
        const s = await frame();
        expect(s.inView, `step ${i + 1}: ${s.on} stays in view`).toBe(true);
      }
      // choosing the first seat, then k wraps to the last one, far down the list
      await page.click('[data-seat="flight-1"]');
      await page.press("k");
      const last = await frame();
      expect(last.on).toBe("retro-15");
      expect(last.inView, "wrapping to the last seat scrolls it into view").toBe(true);

      // fold the first group (the chosen seat is in the last one), then j wraps into the folded group
      await page.click('.roster-fold[aria-expanded="true"]');
      const folded = await page.evaluate(
        () => document.querySelectorAll('.roster-fold[aria-expanded="false"]').length,
        null,
      );
      expect(folded).toBeGreaterThanOrEqual(1);
      await page.press("j");
      const after = await frame();
      expect(after.inView, "the chosen seat's group opens and shows it").toBe(true);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the chosen seat in the roster frame when the page narrows below 1000px",
    async () => {
      const page = await renderAt({
        page: "test/agentV2Browser.html",
        width: 1280,
        height: 800,
        search: seatAt,
        api: rosterApi(rosterRows(25, ["alpha", "beta", "gamma"])),
      });
      await page.box(".seat-card");
      await page.click('[data-seat="flight-1"]');
      await page.press("k"); // wraps to the last seat, far down the list
      const inFrame = () =>
        page.evaluate(() => {
          const f = document.querySelector(".roster-list")?.getBoundingClientRect();
          const c = document
            .querySelector('#roster [aria-current="true"]')
            ?.getBoundingClientRect();
          return !!(f && c && c.top >= f.top - 1 && c.bottom <= f.bottom + 1);
        }, null);
      const measured = () =>
        page.evaluate(() => {
          const box = (selector: string) => {
            const r = document.querySelector(selector)?.getBoundingClientRect();
            return r ? [Math.round(r.top), Math.round(r.bottom)] : null;
          };
          const list = document.querySelector<HTMLElement>(".roster-list");
          return JSON.stringify({
            window: innerHeight,
            shell: box(".control-shell"),
            roster: box("#roster"),
            frame: box(".roster-list"),
            card: box('#roster [aria-current="true"]'),
            scrollTop: list?.scrollTop,
            scrollHeight: list?.scrollHeight,
          });
        }, null);
      expect(await inFrame(), `beside the content ${await measured()}`).toBe(true);
      await page.resize(980, 800);
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
        null,
      );
      expect(await inFrame(), "after the page narrows and the roster stacks").toBe(true);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "caps the stacked roster so the seat's content starts on the first screen at 900x900",
    async () => {
      const page = await renderAt({
        page: "test/agentV2Browser.html",
        width: 900,
        height: 900,
        search: seatAt,
        api: rosterApi(rosterRows(25, ["alpha", "beta", "gamma"])),
      });
      await page.box(".seat-card");
      const r = await page.evaluate(
        () => ({
          roster: document.querySelector("#roster")?.getBoundingClientRect().height ?? 0,
          mainTop: document.querySelector(".control-main")?.getBoundingClientRect().top ?? 0,
          inner: innerHeight,
        }),
        null,
      );
      expect(r.roster).toBeLessThanOrEqual(0.4 * r.inner + 1);
      expect(r.mainTop).toBeLessThan(r.inner);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
