// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { CONFIG, crewRow, item, NOW } from "./fixtures.ts";

const { renderAt } = browserSession();
const row = crewRow({
  id: "studio",
  kind: "loop",
  hudState: "idle",
  run: null,
  ticket: null,
  loop: null,
});
const items = Array.from({ length: 50 }, (_, i) =>
  item({ key: `loop:${i}`, agentId: "studio", ticket: null, kind: "decision", owner: "loop" }),
);
const old = {
  id: "comms:91",
  at: NOW - 60_000,
  from: "ended-seat",
  to: "crew",
  ticket: null,
  text: "Earlier handoff from an ended run",
  operator: false,
  reactions: [],
  mentions: [],
};
const api = {
  "/api/config": CONFIG,
  "/api/crew?shape=summary": { rows: [row], firstRunToday: null },
  "/api/attention": items,
  "/api/limits": [],
  "/api/test-lock": { holder: null, waiting: [] },
  "/api/crew/status": { enabled: true },
  "/api/crew/changes": { sessions: [] },
  "/api/repos/shop-app/prs?linked=1&shape=summary": [],
  "/api/flight": { seat: null, decisions: [] },
  "/api/comms/crew": { messages: [], hasEarlier: true, unread: 0 },
  "/api/comms/crew?history=1": { messages: [old], hasMore: false, unread: 0 },
  "/api/comms/mentions": { mentions: [] },
  "/api/comms/pins": { messages: [] },
  "/api/comms/agents/studio?summary=1": { contacts: [], unread: 0 },
  "/api/comms/flight": { messages: [] },
  "/api/comms/read": { ok: true },
};
const cases = [
  ...[1280, 1600, 1920].flatMap((width) =>
    ["light", "dark"].map((theme) => ({ width, height: 1000, theme: theme as "light" | "dark" })),
  ),
  ...["light", "dark"].map((theme) => ({
    width: 1600,
    height: 700,
    theme: theme as "light" | "dark",
  })),
];
describeRendered("Attention lifecycle ownership and archive", () => {
  it.each(cases)(
    "is reachable at $width × $height in $theme",
    async ({ width, height, theme }) => {
      const page = await renderAt({
        page: "test/attentionLifecycleBrowser.html",
        width,
        height,
        colorScheme: theme,
        api,
      });
      await page.box("#needBanner .banner");
      expect(await page.reachable("#needBanner .banner button")).not.toContain(false);
      expect(await page.unclipped("#needBanner .banner")).not.toContain(false);
      expect(
        await page.evaluate(
          () => ({
            text: document.querySelector("#needBanner")?.textContent,
            buttons: [...document.querySelectorAll("#needBanner button")].map((b) => b.textContent),
          }),
          null,
        ),
      ).toMatchObject({ buttons: ["Open", "Ack"] });
      const text = await page.evaluate(() => document.body.textContent ?? "", null);
      expect(text).toContain("50 items");
      expect(text).toContain("has an item to resolve");
      expect(text).not.toContain("Decision for you");
      const shots = process.env.MC_ATTENTION_SHOTS;
      if (shots) {
        mkdirSync(shots, { recursive: true });
        await page.screenshot(join(shots, `owners-${width}-${height}-${theme}.png`));
      }
      await page.close();
      const comms = await renderAt({
        page: "test/commsBrowser.html",
        width,
        height,
        colorScheme: theme,
        api,
      });
      await comms.box(".comms-older button");
      expect(
        await comms.evaluate(() => document.querySelector("#convo")?.textContent, null),
      ).not.toContain(old.text);
      await comms.click(".comms-older button");
      await comms.box(".comms-bubble");
      expect(await comms.evaluate(() => document.body.textContent ?? "", null)).not.toContain(
        "Could not mark this conversation read",
      );
      expect(
        await comms.evaluate(() => document.querySelector("#convo")?.textContent, null),
      ).toContain(old.text);
      expect(await comms.reachable(".comms-older button")).not.toContain(false);
      expect(await comms.unclipped("#chatP")).not.toContain(false);
      if (shots) await comms.screenshot(join(shots, `earlier-${width}-${height}-${theme}.png`));
      await comms.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
