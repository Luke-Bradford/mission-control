// @vitest-environment node

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CHROME = [
  process.env.MC_BROWSER_EXECUTABLE,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((path): path is string => path !== undefined && existsSync(path));

// A cold Vite and Chrome start on a loaded CI runner can exceed Vitest's 10 s hook default.
const COLD_START_TIMEOUT_MS = 60_000;
// The test's first page load makes Vite transform the page cold, which outlasts Vitest's 5 s test default on a loaded runner.
const BROWSER_TEST_TIMEOUT_MS = 60_000;

interface Browser {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}
interface Page {
  route(url: string | RegExp, handler: (route: Route) => Promise<void>): Promise<void>;
  goto(url: string, options: { waitUntil: "load" }): Promise<unknown>;
  locator(selector: string): Locator;
  close(): Promise<void>;
}
interface Route {
  fulfill(options: { contentType: string; body: string }): Promise<void>;
}
interface Locator {
  first(): Locator;
  nth(index: number): Locator;
  waitFor(): Promise<void>;
  boundingBox(): Promise<{ width: number } | null>;
}
interface Chromium {
  launch(options: { executablePath: string; headless: boolean }): Promise<Browser>;
}

const { chromium } = createRequire(new URL("../../server/package.json", import.meta.url))(
  "playwright-core",
) as { chromium: Chromium };

const audit = {
  range: { since: 0, until: 1 },
  longRunners: [],
  deathLoops: [],
  reworkRounds: [],
  refusalsByRule: [],
  refusals: [],
  refusalSpikes: [],
  spendOutliers: [],
  costPerMergedTicket: [],
  prSizes: {
    prs: [
      {
        repoId: "large-repo",
        number: 1,
        ticket: "large-repo#1",
        mergedAt: 0,
        additions: 665_702,
        deletions: 0,
        changedFiles: 1,
      },
      {
        repoId: "small-repo",
        number: 2,
        ticket: "small-repo#2",
        mergedAt: 0,
        additions: 2_833,
        deletions: 0,
        changedFiles: 1,
      },
    ],
    outliers: [],
  },
  modelPromptTimeline: [],
  questions: { asked: 0, answered: 0, answerMs: null },
  chatter: [],
  flakes: [],
  changes: [],
  surgeonProposals: [],
};

const config = { loops: [], crew: { sessions: [] } };

let server: ViteDevServer | undefined;
let browser: Browser | undefined;
let origin: string | undefined;

beforeAll(async () => {
  if (!CHROME) return;
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: new URL("../vite.config.ts", import.meta.url).pathname,
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Vite did not open a TCP port");
  origin = `http://127.0.0.1:${address.port}`;
  if (!CHROME) return;
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
}, COLD_START_TIMEOUT_MS);

afterAll(async () => {
  await browser?.close();
  await server?.close();
}, COLD_START_TIMEOUT_MS);

describe.skipIf(!CHROME)("Audit PR bars in a browser", () => {
  it("uses the production stylesheet's logarithmic fill widths", async () => {
    if (!browser || !origin) throw new Error("browser test did not start");
    const page = await browser.newPage();
    await page.route(/\/api\/audit\?range=30d$/, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(audit) }),
    );
    await page.route(/\/api\/config$/, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(config) }),
    );
    await page.goto(`${origin}/test/auditBarBrowser.html`, { waitUntil: "load" });
    await page.locator(".audit-bar").first().waitFor();

    const fills = page.locator(".audit-bar");
    const tracks = page.locator(".audit-bar-track");
    const [largestFill, smallerFill, largestTrack, smallerTrack] = await Promise.all([
      fills.nth(0).boundingBox(),
      fills.nth(1).boundingBox(),
      tracks.nth(0).boundingBox(),
      tracks.nth(1).boundingBox(),
    ]);
    if (!largestFill || !smallerFill || !largestTrack || !smallerTrack)
      throw new Error("expected rendered Audit PR bars");

    expect(largestFill.width / largestTrack.width).toBeCloseTo(1, 3);
    expect(smallerFill.width / smallerTrack.width).toBeCloseTo(
      Math.log1p(2_833) / Math.log1p(665_702),
      3,
    );
    await page.close();
  }, BROWSER_TEST_TIMEOUT_MS);
});
