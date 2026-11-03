// @vitest-environment node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { type InstructionScenario, instructionsFixture } from "./instructionsFixture.ts";

const { renderAt } = browserSession();
const BEFORE = process.env.MC_INSTRUCTION_BEFORE === "1";
const OUT = process.env.MC_INSTRUCTION_QA_DIR;
const PRODUCT_SOURCE = process.env.MC_INSTRUCTION_SOURCE ?? "uncommitted author stage";
const HARNESS_SOURCE = process.env.MC_INSTRUCTION_HARNESS ?? PRODUCT_SOURCE;
const scenarios: InstructionScenario[] =
  process.env.MC_INSTRUCTION_QA_FULL === "1"
    ? ["empty", "one", "many", "long", "boundary"]
    : ["one", "many"];
const cases = [
  { width: 1280, height: 1000 },
  { width: 1600, height: 1000 },
  { width: 1920, height: 1080 },
  { width: 1600, height: 700 },
].flatMap((size) =>
  ["orders", "crew", "agent"].map((view) => ({
    ...size,
    view,
    label: `${view}-${size.width}x${size.height}`,
  })),
);

describeRendered("Standing instructions in the actual App", () => {
  it.each(cases)(
    "retains full readable instructions at $label",
    async ({ width, height, view, label }) => {
      for (const theme of ["light", "dark"] as const)
        for (const scenario of scenarios) {
          const fixture = instructionsFixture(scenario);
          const at =
            view === "agent"
              ? "/agent/guido-1"
              : view === "crew"
                ? "/flight#wifP"
                : "/flight#ordersP";
          const page = await renderAt({
            page: "test/agentV2Browser.html",
            width,
            height,
            colorScheme: theme,
            search: `?dock=folded&at=${encodeURIComponent(at)}`,
            api: fixture.api,
          });
          const stem = `${label}-${scenario}-${theme}`;
          try {
            await page.box(view === "agent" ? "#page-agent" : "#page-flight");
            await page.evaluate(async () => {
              await document.fonts.ready;
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              );
            }, null);
            if (OUT) {
              mkdirSync(OUT, { recursive: true });
              await page.screenshot(join(OUT, `${stem}-initial.png`));
            }
            if (!BEFORE) {
              if (view === "agent") await page.click(".instruction-disclosure > summary");
              if (view === "crew") {
                await page.click("#wifP .seg button:last-child");
                await page.box(".instruction-index .instruction-seat > summary");
                await page.click(".instruction-index .instruction-seat > summary");
              }
              await page.box(".instruction-manager");
            }
            const expected =
              view === "orders" ? fixture.orders.length : fixture.index.seats[0].active.length;
            const facts = await page.evaluate(
              async ({ before, expected }) => {
                const start = performance.now();
                const read = () => {
                  const manager = document.querySelector(".instruction-manager");
                  const active = manager?.querySelector('[aria-label="Active instructions"]');
                  return {
                    documentWidth: document.documentElement.scrollWidth,
                    viewport: innerWidth,
                    active: active?.querySelectorAll("article").length ?? null,
                    text: manager?.textContent ?? null,
                    manager: manager?.getBoundingClientRect().toJSON() ?? null,
                  };
                };
                let value = read();
                while (
                  !before &&
                  (value.active !== expected ||
                    (expected === 0 && !value.text?.includes("No active"))) &&
                  performance.now() - start < 1500
                ) {
                  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                  value = read();
                }
                return value;
              },
              { before: BEFORE, expected },
            );
            if (OUT) {
              mkdirSync(OUT, { recursive: true });
              await page.screenshot(join(OUT, `${stem}.png`));
              writeFileSync(
                join(OUT, `${stem}.json`),
                JSON.stringify(
                  {
                    baseline: BEFORE,
                    productSource: PRODUCT_SOURCE,
                    harnessSource: HARNESS_SOURCE,
                    fixture: scenario,
                    view,
                    width,
                    height,
                    theme,
                    zoom: 1,
                    deviceScale: 1,
                    dock: "folded",
                    ...facts,
                    errors: page.errors(),
                  },
                  null,
                  2,
                ),
              );
            }
            expect(page.errors()).toEqual([]);
            expect(facts.documentWidth).toBeLessThanOrEqual(width + 1);
            if (!BEFORE) {
              expect(facts.active).toBe(expected);
              const controls = await page.evaluate(
                () =>
                  [
                    ...document.querySelectorAll<HTMLElement>(
                      ".instruction-manager button,.instruction-manager a,.instruction-disclosure > summary,.instruction-seat > summary",
                    ),
                  ]
                    .filter((node) => node.getClientRects().length > 0)
                    .map((node) => {
                      const box = node.getBoundingClientRect();
                      return { text: node.textContent, width: box.width, height: box.height };
                    }),
                null,
              );
              expect(controls.length).toBeGreaterThan(0);
              expect(
                controls.filter((control) => control.width < 24 || control.height < 24),
              ).toEqual([]);
              expect(
                await page.reachable(".instruction-manager button,.instruction-manager a"),
              ).not.toContain(false);
              if (scenario === "one") {
                await page.click(".instruction-manager > button");
                await page.box(".instruction-form textarea");
                const inputFocused = await page.evaluate(async () => {
                  const start = performance.now();
                  while (
                    document.activeElement !==
                      document.querySelector(".instruction-form textarea") &&
                    performance.now() - start < 1000
                  )
                    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                  return (
                    document.activeElement === document.querySelector(".instruction-form textarea")
                  );
                }, null);
                expect(inputFocused).toBe(true);
                await page.press("Tab");
                const save = await page.evaluate(() => {
                  const button = document.activeElement as HTMLElement,
                    box = button.getBoundingClientRect();
                  return {
                    text: button.textContent,
                    box: box.toJSON(),
                    painted:
                      box.top >= 0 &&
                      box.bottom <= innerHeight + 1 &&
                      button.contains(
                        document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
                      ),
                  };
                }, null);
                if (OUT) {
                  await page.screenshot(join(OUT, `${stem}-editor.png`));
                  writeFileSync(join(OUT, `${stem}-editor.json`), JSON.stringify(save, null, 2));
                }
                expect(save.text).toBe("Save instruction");
                expect(save.painted).toBe(true);
                await page.press("Tab");
                await page.press("Enter");
              }
              if (scenario === "many") {
                await page.evaluate(
                  () =>
                    document
                      .querySelector<HTMLElement>(
                        '.instruction-manager [aria-label="Active instructions"]',
                      )
                      ?.focus(),
                  null,
                );
                await page.press("End");
                const bottom = await page.evaluate(async () => {
                  const region = document.querySelector<HTMLElement>(
                    '.instruction-manager [aria-label="Active instructions"]',
                  );
                  if (!region) throw new Error("Active instruction region missing");
                  const start = performance.now();
                  const read = () => {
                    const last = region.querySelector<HTMLElement>("article:last-child");
                    if (!last) throw new Error("Last active instruction missing");
                    const box = last.getBoundingClientRect(),
                      clip = region.getBoundingClientRect();
                    return {
                      remaining: region.scrollHeight - region.clientHeight - region.scrollTop,
                      text: last.textContent,
                      painted:
                        box.bottom <= Math.min(clip.bottom, innerHeight) + 1 &&
                        box.top >= Math.max(clip.top, 0) - 1 &&
                        last.contains(
                          document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
                        ),
                    };
                  };
                  let result = read();
                  while (
                    (result.remaining > 2 || !result.painted) &&
                    performance.now() - start < 1000
                  ) {
                    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                    result = read();
                  }
                  return result;
                }, null);
                if (OUT) {
                  await page.screenshot(join(OUT, `${stem}-last-row.png`));
                  writeFileSync(
                    join(OUT, `${stem}-last-row.json`),
                    JSON.stringify(bottom, null, 2),
                  );
                }
                expect(bottom.remaining).toBeLessThanOrEqual(2);
                expect(bottom.painted).toBe(true);
              }
              if (scenario === "long" || scenario === "boundary") {
                const entry =
                  view === "orders"
                    ? fixture.orders[0]
                    : fixture.index.seats[0].active.find((entry) => entry.kind === "text");
                if (entry?.kind !== "text") throw new Error("Full-text fixture missing");
                const fullLabel = `Full instruction #${entry.id}`;
                await page.click(`[aria-label="Show more, instruction #${entry.id}"]`);
                await page.press("Shift+Tab");
                const focused = await page.evaluate(
                  () => document.activeElement?.getAttribute("aria-label"),
                  null,
                );
                expect(focused).toBe(fullLabel);
                await page.press("End");
                const full = await page.evaluate(async (label) => {
                  const region = document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
                  if (!region) throw new Error("Full instruction reader missing");
                  const start = performance.now();
                  const read = () => {
                    const range = document.createRange();
                    range.selectNodeContents(region);
                    const last = [...range.getClientRects()].at(-1),
                      box = region.getBoundingClientRect();
                    return {
                      length: region.textContent?.length,
                      remaining: region.scrollHeight - region.clientHeight - region.scrollTop,
                      painted:
                        !!last &&
                        last.bottom <= Math.min(box.bottom, innerHeight) + 1 &&
                        region.contains(
                          document.elementFromPoint(
                            last.x + Math.min(10, last.width / 2),
                            last.y + last.height / 2,
                          ),
                        ),
                    };
                  };
                  let result = read();
                  while (
                    (result.remaining > 2 || !result.painted) &&
                    performance.now() - start < 1000
                  ) {
                    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                    result = read();
                  }
                  return result;
                }, fullLabel);
                if (OUT) {
                  await page.screenshot(join(OUT, `${stem}-full-text.png`));
                  writeFileSync(join(OUT, `${stem}-full-text.json`), JSON.stringify(full, null, 2));
                }
                expect(full.length).toBe(entry.text.length);
                expect(full.remaining).toBeLessThanOrEqual(2);
                expect(full.painted).toBe(true);
              }
            }
          } finally {
            await page.close();
          }
        }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
