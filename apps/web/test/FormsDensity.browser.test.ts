// @vitest-environment node

import type { ConfigView, CrewChanges } from "@mc/core";
import { expect, it } from "vitest";
import { ACTIONS, RESOURCES } from "../src/data.ts";
import {
  BROWSER_TEST_TIMEOUT_MS,
  browserSession,
  describeRendered,
  type RenderedPage,
} from "./browserRunner.ts";
import { CREW_CONFIG } from "./fixtures.ts";

const { renderAt } = browserSession();

/** What the page is showing: the form's data, from nothing to a crowded list. */
type World = "empty" | "one" | "long" | "fifty";
const LONG_ACCOUNT = `codex-${"a".repeat(33)}`;
const LONG_MODEL = `gpt-${"x".repeat(60)}`;

function world(kind: World) {
  const ids =
    kind === "empty"
      ? ["codex-main"]
      : kind === "long"
        ? ["codex-main", LONG_ACCOUNT, "claude-main"]
        : kind === "fifty"
          ? [
              "codex-main",
              ...Array.from({ length: 48 }, (_, i) => `codex-${String(i + 1).padStart(2, "0")}`),
              "claude-main",
            ]
          : ["codex-main", "codex-spare", "claude-main"];
  const accounts = ids.map((id) => ({
    id,
    vendor: id.startsWith("claude") ? ("claude" as const) : ("codex" as const),
    alertAt: 80,
    stopAt: 100,
  }));
  const count = kind === "empty" ? 0 : kind === "fifty" ? 50 : 1;
  const seats = Array.from({ length: count }, (_, i) => ({
    id: kind === "long" ? `guido-${"z".repeat(24)}` : `guido-${i + 1}`,
    role: "GUIDO",
    accountId: "codex-main",
    model: kind === "long" ? LONG_MODEL : "sonnet",
    area: ["apps/**"],
  }));
  const crew = CREW_CONFIG.crew;
  if (!crew) throw new Error("fixture has no crew");
  const config: ConfigView = {
    ...CREW_CONFIG,
    accounts,
    crew: {
      ...crew,
      sessions: crew.sessions.map((session, i) =>
        i === 0
          ? { ...session, seats: seats.map((seat) => ({ ...seat, mode: "writer" })) }
          : session,
      ),
    },
  };
  const changes: CrewChanges = {
    sessions: [{ id: "s1", seats }],
    pending: [],
    restartNeeded: [],
    checkedAt: 1792756800000,
    error: null,
  };
  return {
    [RESOURCES.config.path]: config,
    [RESOURCES.limits.path]: [],
    [RESOURCES.accountStatus.path]: accounts
      .filter((a) => a.id !== "codex-main")
      .map((a) => ({
        accountId: a.id,
        provider: a.vendor,
        binding: "profile",
        status: "logged-in",
      })),
    [RESOURCES.allAccountModels.path]: accounts.map((a) => ({
      accountId: a.id,
      models: [{ model: kind === "long" ? LONG_MODEL : "sonnet", efforts: ["low", "high"] }],
    })),
    [RESOURCES.crewChanges.path]: changes,
    [RESOURCES.crewSessions.path]: [],
    [RESOURCES.attention.path]: [],
    [RESOURCES.crew.path]: { rows: [], firstRunToday: null },
  };
}

const PREVIEW = {
  github: "octo-org/mission",
  project: 4,
  defaultBranch: "main",
  projectTitle: "Mission Control",
  items: 37,
  fields: [{ name: "Status", options: ["Todo", "Done"] }],
  statusOptions: ["Todo", "Done"],
  proposedStatusMap: { Todo: "planned", Done: "done" },
  columns: [],
  missingColumns: [],
  priority: "labels",
  budget: { boardPerHour: 500, sweepPerHour: 12, flowPerHour: 2, totalPerHour: 514 },
  budgetNow: 1234,
  loops: [],
};

/** Every write is answered from this map; a write it does not list is refused (404) with no effect. */
const writes = (checkoutPasses: boolean) => ({
  [ACTIONS.previewRepo]: PREVIEW,
  ...(checkoutPasses ? { [ACTIONS.previewCheckout]: { ok: true } } : {}),
});

type Step = ["type", string, string] | ["click", string] | ["css", string] | ["field", string];

const CARD = "article[aria-label='shop-app']";
const TO_STEP_2: Step[] = [
  ["click", "+ Add repo"],
  ["type", "GitHub repo", "octo-org/mission"],
  ["type", "Project number", "4"],
  ["type", "Repo id", "mission"],
  ["click", "Next: checkout"],
];
const TO_STEP_3: Step[] = [
  ...TO_STEP_2,
  ["type", "Checkout folder", "/work/a/fictional/checkout/folder/that/is/rather/long"],
  ["click", "Next: live checks"],
];

/** The seven forms: how each is reached, and the width the approved contract caps it at. */
const FORMS = [
  {
    id: "F06",
    form: 'form[aria-label="Switch account"]',
    cap: 480,
    steps: [
      ["css", ".agent-v2-actions details summary"],
      ["click", "Switch account"],
    ],
  },
  {
    id: "F07",
    form: 'form[aria-label="Add repo"]',
    cap: 800,
    steps: [["click", "+ Add repo"]],
  },
  { id: "F08", form: 'form[aria-label="Add repo"]', cap: 800, steps: TO_STEP_2 },
  { id: "F09", form: 'form[aria-label="Add repo"]', cap: 800, steps: TO_STEP_3 },
  {
    id: "F10",
    form: 'form[aria-label="Add repo"]',
    cap: 800,
    steps: [...TO_STEP_3, ["click", "Run live checks"], ["field", "Mode"]],
  },
  {
    id: "F11",
    form: 'form[aria-label="Add seat"]',
    cap: 640,
    steps: [
      ["css", `${CARD} .repo-card-title`],
      ["click", "+ Add seat to this repo"],
    ],
  },
  {
    id: "F12",
    form: 'form[aria-label^="Edit "]',
    cap: 640,
    steps: [
      ["css", `${CARD} .repo-card-title`],
      ["css", `${CARD} .repo-seats tbody tr button`],
    ],
  },
] as const satisfies readonly {
  id: string;
  form: string;
  cap: number;
  steps: readonly Step[];
}[];
type Form = (typeof FORMS)[number];
const pageOf = (form: Form) => (form.id === "F06" ? "F06" : "repos");

/** Runs the steps a person would take, inside the page, waiting for each control to appear. */
const drive = (page: RenderedPage, steps: readonly Step[]) =>
  page.evaluate(async (list) => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const until = async <T>(find: () => T | null | undefined | false, what: string): Promise<T> => {
      for (let i = 0; i < 120; i++) {
        const found = find();
        if (found) return found;
        await wait(50);
      }
      throw new Error(`timed out waiting for ${what}`);
    };
    const field = (label: string) =>
      until(() => {
        const l = [...document.querySelectorAll("label")].find(
          (x) => x.textContent === label && x.htmlFor,
        );
        return l ? document.getElementById(l.htmlFor) : null;
      }, label);
    for (const step of list) {
      if (step[0] === "field") await field(step[1]);
      else if (step[0] === "type") {
        const input = (await field(step[1])) as HTMLInputElement;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          input,
          step[2],
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        const target = await until(
          () =>
            step[0] === "css"
              ? document.querySelector<HTMLElement>(step[1])
              : [...document.querySelectorAll("button")].find(
                  (b) => b.textContent === step[1] && !b.disabled,
                ),
          step[1],
        );
        // A real click focuses its button; a scripted one does not, and focus returns to the opener.
        target.focus();
        target.click();
      }
      await wait(60);
    }
  }, steps as Step[]);

interface RenderOpts {
  kind?: World;
  state?: "loading" | "error" | "status-loading" | "disconnected";
  width: number;
  height: number;
  colorScheme?: "light" | "dark";
  checkoutPasses?: boolean;
}

async function open(form: Form, o: RenderOpts) {
  const query = new URLSearchParams({ form: pageOf(form) });
  if (o.state) query.set("state", o.state);
  const page = await renderAt({
    page: "test/formsBrowser.html",
    width: o.width,
    height: o.height,
    search: `?${query}`,
    colorScheme: o.colorScheme ?? "light",
    api: { ...world(o.kind ?? "one"), ...writes(o.checkoutPasses ?? true) },
  });
  await page.box("#page-setup, main");
  if (o.state === "loading" || o.state === "error") {
    // the account switch lives in the More menu, which is where its load state shows
    if (form.id === "F06") await drive(page, form.steps.slice(0, 1));
    return page;
  }
  await drive(page, form.steps);
  await page.box(form.form);
  return page;
}

/** The checks every form meets at every size, state and theme. */
async function expectDense(page: RenderedPage, form: Form, checkErrors = true) {
  const measured = await page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) return null;
    const doc = document.documentElement;
    return {
      width: root.getBoundingClientRect().width,
      controls: [
        ...root.querySelectorAll("input:not([type=checkbox]):not([type=radio]), select, textarea"),
      ].map((c) => c.getBoundingClientRect().height),
      formOverflow: root.scrollWidth - root.clientWidth,
      pageOverflow: doc.scrollWidth - doc.clientWidth,
    };
  }, form.form);
  expect(measured).not.toBeNull();
  if (!measured) return;
  expect(measured.width).toBeGreaterThan(0);
  expect(measured.width).toBeLessThanOrEqual(form.cap + 1);
  for (const height of measured.controls) expect(Math.abs(height - 32)).toBeLessThan(0.5);
  expect(measured.formOverflow).toBeLessThanOrEqual(1);
  expect(measured.pageOverflow).toBeLessThanOrEqual(1);
  expect((await page.unclipped(`${form.form} .fgroup`)).every(Boolean)).toBe(true);
  if (checkErrors) expect(page.errors()).toEqual([]);
}

const VIEWPORTS = [
  [1280, 900],
  [1440, 900],
  [1600, 1000],
  [1920, 1080],
  [2560, 1440],
  [1600, 700],
] as const;

describeRendered("Setup repo and seat forms and the account switch, rendered", () => {
  for (const form of FORMS) {
    for (const [width, height] of VIEWPORTS) {
      it(
        `${form.id} is capped at ${form.cap}px with 32px controls and no clipping at ${width}x${height} light`,
        async () => {
          const page = await open(form, { width, height });
          await expectDense(page, form);
          await page.close();
        },
        BROWSER_TEST_TIMEOUT_MS,
      );
    }
    for (const [width, height] of [
      [1920, 1080],
      [1600, 700],
    ] as const) {
      it(
        `${form.id} holds the same at ${width}x${height} dark`,
        async () => {
          const page = await open(form, { width, height, colorScheme: "dark" });
          await expectDense(page, form);
          await page.close();
        },
        BROWSER_TEST_TIMEOUT_MS,
      );
    }
  }

  // Data states, at one size: nothing to list, a long name, a crowded list, and a down stream.
  for (const form of FORMS) {
    for (const kind of ["empty", "long", "fifty"] as const) {
      if (form.id === "F12" && kind === "empty") continue; // no seat to edit
      it(
        `${form.id} holds its cap and its controls with ${kind} data`,
        async () => {
          const page = await open(form, { kind, width: 1440, height: 900 });
          await expectDense(page, form);
          await page.close();
        },
        BROWSER_TEST_TIMEOUT_MS,
      );
    }
    it(
      `${form.id} holds while the live stream is disconnected`,
      async () => {
        const page = await open(form, { state: "disconnected", width: 1440, height: 900 });
        await expectDense(page, form);
        await page.close();
      },
      BROWSER_TEST_TIMEOUT_MS,
    );
  }

  // Loading and error: no form can open yet; the page says so and does not scroll sideways.
  for (const state of ["loading", "error"] as const) {
    for (const [ids, form, text] of [
      ["F07–F12", FORMS[1], state === "loading" ? "Loading…" : "Controlled config unavailable"],
      ["F06", FORMS[0], state === "loading" ? "Switch account" : "Controlled config unavailable"],
    ] as const) {
      it(
        `${ids} while the config is ${state}: no form opens, the page says why and does not scroll sideways`,
        async () => {
          const page = await open(form, { state, width: 1440, height: 900 });
          const seen = await page.evaluate(
            async (arg) => {
              await new Promise((r) => setTimeout(r, 300));
              const doc = document.documentElement;
              return {
                said: document.body.textContent?.includes(arg.text) ?? false,
                forms: document.querySelectorAll(arg.form).length,
                overflow: doc.scrollWidth - doc.clientWidth,
              };
            },
            { text, form: form.form },
          );
          expect(seen.said).toBe(true);
          expect(seen.forms).toBe(0);
          expect(seen.overflow).toBeLessThanOrEqual(1);
          expect(page.errors()).toEqual([]);
          await page.close();
        },
        BROWSER_TEST_TIMEOUT_MS,
      );
    }
  }

  // Tab through each form: every stop is a visible, 24x24 target, and the final action is in view.
  for (const form of FORMS) {
    it(
      `${form.id}: Tab shows focus on 24x24 targets and brings the final action into view at 1600x700`,
      async () => {
        const page = await open(form, { width: 1600, height: 700 });
        await page.evaluate((selector) => {
          const root = document.querySelector(selector);
          root
            ?.querySelector<HTMLElement>(
              "input:not(:disabled), select:not(:disabled), button:not(:disabled)",
            )
            ?.focus();
        }, form.form);
        const stops: {
          label: string;
          width: number;
          height: number;
          outline: boolean;
          inView: boolean;
          submit: boolean;
        }[] = [];
        for (let i = 0; i < 40; i++) {
          const stop = await page.evaluate((selector) => {
            const el = document.activeElement as HTMLElement | null;
            const root = document.querySelector(selector);
            if (!el || !root?.contains(el)) return null;
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return {
              label: el.textContent || el.getAttribute("id") || el.tagName,
              width: rect.width,
              height: rect.height,
              outline: style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0,
              inView: rect.top >= 0 && rect.bottom <= window.innerHeight,
              submit: el.matches("button[type=submit]"),
            };
          }, form.form);
          if (!stop) break;
          stops.push(stop);
          await page.press("Tab");
        }
        expect(stops.length).toBeGreaterThan(1);
        for (const stop of stops) {
          expect(stop.width).toBeGreaterThanOrEqual(24);
          expect(stop.height).toBeGreaterThanOrEqual(24);
        }
        // the first stop was focused by script, which need not show a ring; every Tab stop must
        for (const stop of stops.slice(1)) expect(stop.outline).toBe(true);
        // Tab scrolls each stop into view, and reaches the final action
        for (const stop of stops) expect(stop.inView).toBe(true);
        expect(stops.find((stop) => stop.submit)?.inView).toBe(true);
        await page.close();
      },
      BROWSER_TEST_TIMEOUT_MS,
    );
  }

  // An explained failure at the shortest window: the summary is focused and in view, and the final
  // action can still be reached and is not painted over.
  const FAIL: Record<Form["id"], { steps: readonly Step[]; checkoutPasses?: boolean }> = {
    F06: { steps: [["click", "Transfer account"]] },
    F07: { steps: [["click", "Next: checkout"]] },
    F08: {
      steps: [
        ["type", "Checkout folder", ""],
        ["click", "Next: live checks"],
      ],
    },
    F09: { steps: [["click", "Run live checks"]], checkoutPasses: false },
    F10: { steps: [["click", "Add repo"]] },
    F11: { steps: [["click", "Save seat"]] },
    F12: { steps: [["click", "Save seat"]] },
  };
  for (const form of FORMS) {
    it(
      `${form.id}: a failed attempt is explained, focused and leaves the final action in view at 1600x700`,
      async () => {
        const fail = FAIL[form.id];
        const page = await open(form, {
          width: 1600,
          height: 700,
          checkoutPasses: fail.checkoutPasses,
        });
        if (form.id === "F12")
          await page.evaluate(async (selector) => {
            const model = [
              ...document.querySelectorAll<HTMLSelectElement>(`${selector} select`),
            ].find((s) => document.querySelector(`label[for="${s.id}"]`)?.textContent === "Model");
            if (!model) throw new Error("Model");
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(
              model,
              "",
            );
            model.dispatchEvent(new Event("change", { bubbles: true }));
            await new Promise((r) => setTimeout(r, 60));
          }, form.form);
        await drive(page, fail.steps);
        await page.box(`${form.form} .fsum`);
        const result = await page.evaluate((selector) => {
          const root = document.querySelector(selector);
          const summary = root?.querySelector<HTMLElement>(".fsum");
          const action = root?.querySelector<HTMLElement>(".fact button[type=submit]");
          if (!summary || !action) return null;
          const inside = summary.getBoundingClientRect();
          action.scrollIntoView({ block: "nearest" });
          const rect = action.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return {
            focused: document.activeElement === summary,
            summaryHasText: (summary.textContent ?? "").trim().length > 0,
            summaryWide: inside.width <= document.documentElement.clientWidth,
            actionInView: rect.top >= 0 && rect.bottom <= window.innerHeight,
            actionFree: action.contains(hit),
          };
        }, form.form);
        expect(result).toEqual({
          focused: true,
          summaryHasText: true,
          summaryWide: true,
          actionInView: true,
          actionFree: true,
        });
        await page.close();
      },
      BROWSER_TEST_TIMEOUT_MS,
    );
  }

  // The account switch inside the Agent page's More menu: the menu grows to hold the 480px form.
  for (const [width, height] of [
    [1280, 900],
    [1600, 700],
  ] as const) {
    for (const state of [undefined, "status-loading"] as const) {
      it(
        `F06 fills most of its 480px cap inside the More menu at ${width}x${height}${state ? " while accounts load" : ""}`,
        async () => {
          const page = await open(FORMS[0], { width, height, state });
          const seen = await page.evaluate((selector) => {
            const form = document.querySelector(selector)?.getBoundingClientRect();
            const menu = document.querySelector(".agent-v2-menu")?.getBoundingClientRect();
            return {
              form: form?.width ?? 0,
              left: menu?.left ?? -1,
              right: menu?.right ?? Number.POSITIVE_INFINITY,
              top: menu?.top ?? -1,
              position: menu
                ? getComputedStyle(document.querySelector(".agent-v2-menu") as Element).position
                : "",
              viewport: window.innerWidth,
              loading: document.body.textContent?.includes("Loading accounts…") ?? false,
            };
          }, FORMS[0].form);
          // the real menu is an absolute panel (Overview.css), which the width rule must widen
          expect(seen.position).toBe("absolute");
          expect(seen.form).toBeGreaterThanOrEqual(400);
          expect(seen.form).toBeLessThanOrEqual(481);
          expect(seen.left).toBeGreaterThanOrEqual(0);
          expect(seen.right).toBeLessThanOrEqual(seen.viewport);
          expect(seen.top).toBeGreaterThanOrEqual(0);
          if (state) expect(seen.loading).toBe(true);
          await page.close();
        },
        BROWSER_TEST_TIMEOUT_MS,
      );
    }
  }

  // A selected option's text must fit its select: native selects clip without an ellipsis.
  for (const form of [FORMS[5], FORMS[6]]) {
    it(
      `${form.id}: every select shows its chosen text whole at 1600x1000`,
      async () => {
        const page = await open(form, { width: 1600, height: 1000 });
        const clipped = await page.evaluate((selector) => {
          const canvas = document.createElement("canvas").getContext("2d");
          if (!canvas) throw new Error("no canvas");
          return [...document.querySelectorAll<HTMLSelectElement>(`${selector} select`)]
            .map((select) => {
              const style = getComputedStyle(select);
              canvas.font = style.font;
              const text = select.selectedOptions[0]?.textContent ?? "";
              const room =
                select.clientWidth -
                Number.parseFloat(style.paddingLeft) -
                Number.parseFloat(style.paddingRight) -
                24; // the arrow
              return { id: select.id, text, need: canvas.measureText(text).width, room };
            })
            .filter((s) => s.need > s.room);
        }, form.form);
        expect(clipped).toEqual([]);
        await page.close();
      },
      BROWSER_TEST_TIMEOUT_MS,
    );
  }

  // Inside the real shell: the rail (FLIGHT folded) and FLIGHT's dock expanded, for the widest form.
  for (const [dock, width, height] of [
    ["folded", 1920, 1080],
    ["open", 1280, 900],
  ] as const) {
    it(
      `F07 keeps its cap and does not clip beside FLIGHT's dock (${dock}) at ${width}x${height}`,
      async () => {
        const page = await renderAt({
          page: "test/agentV2Browser.html",
          width,
          height,
          search: `?dock=${dock}&at=/setup/repos`,
          colorScheme: "light",
          api: { ...world("one"), ...writes(true) },
        });
        await page.box("#page-setup, main");
        await drive(page, FORMS[1].steps);
        await page.box(FORMS[1].form);
        await expectDense(page, FORMS[1], false);
        await page.close();
      },
      BROWSER_TEST_TIMEOUT_MS,
    );
  }
});
