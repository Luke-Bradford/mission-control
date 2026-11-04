// @vitest-environment node

import type { CrewChanges } from "@mc/core";
import { expect, it } from "vitest";
import { RESOURCES } from "../src/data.ts";
import {
  BROWSER_TEST_TIMEOUT_MS,
  browserSession,
  describeRendered,
  type RenderedPage,
} from "./browserRunner.ts";
import { CREW_CONFIG } from "./fixtures.ts";

const { renderAt } = browserSession();

const seat = CREW_CONFIG.crew?.sessions[0]?.seats[0];
const changes: CrewChanges = {
  sessions: [
    {
      id: "s1",
      seats: seat
        ? [
            {
              id: seat.id,
              role: seat.role,
              accountId: seat.accountId,
              model: seat.model,
              area: seat.area,
            },
          ]
        : [],
    },
  ],
  pending: [],
  restartNeeded: [],
  checkedAt: 1792756800000,
  error: null,
};
const api = {
  [RESOURCES.config.path]: CREW_CONFIG,
  [RESOURCES.limits.path]: [],
  [RESOURCES.accountStatus.path]: [],
  [RESOURCES.crewChanges.path]: changes,
  [RESOURCES.crewSessions.path]: [],
  [RESOURCES.attention.path]: [],
  [RESOURCES.crew.path]: { rows: [], firstRunToday: null },
};

/** The five inventoried forms: where each opens, the control that opens it, and its width cap. */
const FORMS = [
  {
    id: "F01",
    tab: "sessions",
    open: "Add agent",
    form: 'form[aria-label^="Add agent"]',
    cap: 480,
  },
  { id: "F02", tab: "sessions", open: "Edit", form: 'form[aria-label^="Edit "]', cap: 480 },
  {
    id: "F03",
    tab: "sessions",
    open: "Add session",
    form: 'form[aria-label="Add session"]',
    cap: 640,
  },
  { id: "F04", tab: "accounts", open: "+ Add account", form: ".account-dialog", cap: 640 },
  { id: "F05", tab: "accounts", open: "Edit", form: ".account-dialog", cap: 640 },
] as const;

async function render(
  form: (typeof FORMS)[number],
  width: number,
  height: number,
  colorScheme: "light" | "dark",
) {
  const page = await renderAt({
    page: "test/setupBrowser.html",
    width,
    height,
    search: `?tab=${form.tab}`,
    colorScheme,
    api,
  });
  await page.box("#page-setup, main");
  await page.evaluate((label) => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    return (async () => {
      for (let i = 0; i < 100; i++) {
        const button = [...document.querySelectorAll("button")].find(
          (b) => b.textContent === label && !b.disabled,
        );
        if (button) return void button.click();
        await wait(50);
      }
    })();
  }, form.open);
  await page.box(form.form);
  return page;
}

/** The box of an element as the person sees it: the part of it inside the window. */
const inWindow = (page: RenderedPage, selector: string) =>
  page.evaluate((css) => {
    const rect = document.querySelector(css)?.getBoundingClientRect();
    return rect
      ? {
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          width: window.innerWidth,
          height: window.innerHeight,
        }
      : null;
  }, selector);

/** Every pair of fields shares one top and its controls are exactly 32px tall. */
const pairsAligned = (page: RenderedPage, scope: string) =>
  page.evaluate((root) => {
    const pairs = [...document.querySelectorAll(`${root} .fpair`)];
    return pairs.every((pair) => {
      const controls = [...pair.querySelectorAll("input, select")].map((c) =>
        c.getBoundingClientRect(),
      );
      return (
        controls.length > 0 &&
        controls.every((c) => Math.abs(c.height - 32) < 0.5 && Math.abs(c.top - controls[0].top) < 0.5)
      );
    });
  }, scope);

/** Make the form's own invalid attempt: bad values, then the submit button. */
const attempt = (page: RenderedPage, form: (typeof FORMS)[number]) =>
  page.evaluate(
    async (arg) => {
      const root = document.querySelector(arg.scope);
      const field = (label: string) => {
        const id = [...(root?.querySelectorAll("label") ?? [])].find(
          (l) => l.textContent === label,
        )?.htmlFor;
        return id ? (document.getElementById(id) as HTMLInputElement | null) : null;
      };
      const set = (label: string, value: string) => {
        const input = field(label);
        if (!input) return;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      if (arg.id === "F01") set("Call sign", "Bad Name");
      if (arg.id === "F02") set("Model", " ");
      if (arg.id === "F05") {
        set("Alert at", "95");
        set("Stop at", "90");
      }
      await new Promise((r) => setTimeout(r, 50));
      root?.querySelector<HTMLButtonElement>(".fact button[type=submit]")?.click();
      await new Promise((r) => setTimeout(r, 50));
    },
    { scope: form.form, id: form.id },
  );

describeRendered("Setup agent, session and account forms, rendered", () => {
  for (const colorScheme of ["light", "dark"] as const) {
    for (const [width, height] of [
      [1280, 900],
      [1440, 900],
      [1600, 1000],
      [1920, 1080],
      [2560, 1440],
    ] as const) {
      for (const form of FORMS) {
        it(
          `${form.id} is capped at ${form.cap}px, keeps controls usable and does not clip at ${width}x${height} ${colorScheme}`,
          async () => {
            const page = await render(form, width, height, colorScheme);
            const box = await page.box(form.form);
            expect(box.width).toBeLessThanOrEqual(form.cap + 1);
            expect(box.width).toBeGreaterThan(0);
            for (const control of await page.boxes(
              `${form.form} input:not([type=checkbox]), ${form.form} select`,
            ))
              expect(control.height).toBeGreaterThanOrEqual(32);
            expect((await page.unclipped(`${form.form} .fgroup`)).every(Boolean)).toBe(true);
            // the action follows the final field, in the same column
            const actions = await page.box(`${form.form} .fact`);
            const fields = await page.boxes(`${form.form} .fgroup`);
            const last = fields[fields.length - 1];
            expect(actions.y).toBeGreaterThanOrEqual((last?.y ?? 0) + (last?.height ?? 0) - 1);
            expect(await pairsAligned(page, form.form)).toBe(true);
            await attempt(page, form);
            expect(await pairsAligned(page, form.form)).toBe(true);
            if (form.form === ".account-dialog") {
              const opaque = await page.evaluate(
                () => getComputedStyle(document.querySelector(".account-dialog") as Element).backgroundColor,
                null,
              );
              expect(opaque).not.toBe("rgba(0, 0, 0, 0)");
              expect(opaque).not.toBe("transparent");
            }
            expect(page.errors()).toEqual([]);
            await page.close();
          },
          BROWSER_TEST_TIMEOUT_MS,
        );
      }
    }
  }

  for (const colorScheme of ["light", "dark"] as const) {
    for (const form of FORMS) {
      it(
        `${form.id}: an invalid attempt focuses the summary, the action stays reachable and Cancel returns focus at 1600x700 ${colorScheme}`,
        async () => {
          const page = await render(form, 1600, 700, colorScheme);
          await attempt(page, form);
          await page.box(".fsum");
          expect(
            await page.evaluate(() => document.activeElement?.classList.contains("fsum"), null),
          ).toBe(true);
          const painted = await page.evaluate((scope) => {
            const root = document.querySelector(scope);
            const action = root?.querySelector<HTMLElement>(".fact button[type=submit]");
            action?.scrollIntoView({ block: "nearest" });
            const rect = action?.getBoundingClientRect();
            if (!action || !rect) return false;
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return rect.top >= 0 && rect.bottom <= window.innerHeight && action.contains(hit);
          }, form.form);
          expect(painted).toBe(true);
          const returned = await page.evaluate(
            async (arg) => {
              const root = document.querySelector(arg.scope);
              const cancel = [...(root?.querySelectorAll("button") ?? [])].find(
                (b) => b.textContent === "Cancel",
              );
              cancel?.click();
              await new Promise((r) => setTimeout(r, 100));
              return document.activeElement?.textContent === arg.opener;
            },
            { scope: form.form, opener: form.open },
          );
          expect(returned).toBe(true);
          await page.close();
        },
        BROWSER_TEST_TIMEOUT_MS,
      );
    }
  }

  for (const colorScheme of ["light", "dark"] as const) {
    it(
      `the account editor keeps its summary and last action in view and reachable at 1600x700 ${colorScheme}`,
      async () => {
        const form = FORMS[4];
        const page = await render(form, 1600, 700, colorScheme);
        await page.evaluate(() => {
          const set = (label: string, value: string) => {
            const input = [...document.querySelectorAll<HTMLInputElement>("input")].find(
              (i) => document.querySelector(`label[for="${i.id}"]`)?.textContent === label,
            );
            if (!input) throw new Error(label);
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
              input,
              value,
            );
            input.dispatchEvent(new Event("input", { bubbles: true }));
          };
          set("Alert at", "95");
          set("Stop at", "90");
          const save = [...document.querySelectorAll("button")].find(
            (b) => b.textContent === "Save account",
          );
          save?.click();
        }, null);
        await page.box(".fsum");
        const focused = await page.evaluate(
          () => document.activeElement?.classList.contains("fsum") ?? false,
          null,
        );
        expect(focused).toBe(true);
        const summary = await inWindow(page, ".fsum");
        expect(summary && summary.top >= 0 && summary.bottom <= summary.height).toBe(true);
        // native scroll to the final action: it ends inside the window and nothing paints over it
        const painted = await page.evaluate(() => {
          const save = [...document.querySelectorAll("button")].find(
            (b) => b.textContent === "Save account",
          );
          save?.scrollIntoView({ block: "nearest" });
          const rect = save?.getBoundingClientRect();
          if (!save || !rect) return false;
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return rect.top >= 0 && rect.bottom <= window.innerHeight && save.contains(hit);
        }, null);
        expect(painted).toBe(true);
        await page.close();
      },
      BROWSER_TEST_TIMEOUT_MS,
    );
  }

  it(
    "reflows the forms with no sideways clipping when the window is a 200% zoom of 1280x900",
    async () => {
      // 200% browser zoom halves the CSS-pixel window; a real zoom is not drivable from this harness.
      for (const form of FORMS) {
        const page = await render(form, 640, 450, "light");
        const box = await page.box(form.form);
        expect(box.width).toBeLessThanOrEqual(640);
        expect((await page.unclipped(`${form.form} .fgroup`)).every(Boolean)).toBe(true);
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 2,
  );
});
