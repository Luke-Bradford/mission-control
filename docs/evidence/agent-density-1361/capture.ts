import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Explicit isolated worktrees/output are required. This script never connects to the live hub.
const [afterArg, beforeArg, outArg] = process.argv.slice(2);
if (!afterArg || !beforeArg || !outArg) throw Error("Usage: capture.ts AFTER_ROOT BASELINE_ROOT OUTPUT");
const afterRoot = resolve(afterArg), beforeRoot = resolve(beforeArg), out = resolve(outArg);
const images = join(out, "images"); mkdirSync(images, { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const { agentDensityFixture } = await import(pathToFileURL(join(afterRoot, "apps/web/test/agentDensityFixture.ts")).href);
const { NOW } = await import(pathToFileURL(join(afterRoot, "apps/web/test/fixtures.ts")).href);
const { decodePng, diffImages } = await import(pathToFileURL(join(afterRoot, "apps/server/src/pr-evidence/png.ts")).href);
const { build } = await import(pathToFileURL(createRequire(join(afterRoot, "apps/web/package.json")).resolve("vite")).href);
const { chromium } = createRequire(join(afterRoot, "apps/server/package.json"))("playwright-core");
const cache = join(homedir(), "Library/Caches/ms-playwright");
const executablePath = process.env.MC_BROWSER_EXECUTABLE ?? readdirSync(cache)
  .filter((name) => name.startsWith("chromium_headless_shell-"))
  .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  .flatMap((name) => readdirSync(join(cache, name)).filter((entry) => entry.startsWith("chrome-headless-shell")).map((entry) => join(cache, name, entry, "chrome-headless-shell")))
  .find(existsSync);
if (!executablePath) throw Error("No headless Chromium");
const sourceHarness = readFileSync(join(afterRoot, "apps/web/test/agentV2Browser.tsx"));
if (hash(sourceHarness) !== hash(readFileSync(join(beforeRoot, "apps/web/test/agentV2Browser.tsx")))) throw Error("Baseline must use the identical controlled harness");

const cases = [];
for (const [width, height] of [[1280, 1000], [1440, 1000], [1600, 1000], [1920, 1080], [2560, 1440], [1600, 700]])
  for (const scheme of ["light", "dark"]) for (const dock of ["folded", "open"])
    cases.push({ key: `agent-default-${width}x${height}-${scheme}-${dock}`, scenario: "default", width, height, scheme, dock, page: "agent" });
for (const scenario of ["empty", "one", "long", "many", "loading", "error", "stale", "disconnected", "queued-paused", "queued-stopped"])
  for (const scheme of ["light", "dark"])
    cases.push({ key: `agent-${scenario}-1280x700-${scheme}-open`, scenario, width: 1280, height: 700, scheme, dock: "open", page: "agent" });
for (const scheme of ["light", "dark"])
  cases.push({ key: `setup-model-1600x1000-${scheme}-open`, scenario: "default", width: 1600, height: 1000, scheme, dock: "open", page: "setup" });

const activeCases = process.env.MC_AGENT_CAPTURE_MATCH ? cases.filter((c) => new RegExp(process.env.MC_AGENT_CAPTURE_MATCH).test(c.key)) : cases;
if (!activeCases.length) throw Error("No selected capture cases");

function fixtureFor(c) {
  const f = agentDensityFixture(c.scenario.startsWith("queued-") ? "default" : c.scenario);
  if (c.scenario.startsWith("queued-")) {
    const paused = c.scenario === "queued-paused", sha = (paused ? "b" : "c").repeat(40);
    f.view.row.hudState = paused ? "idle" : "stopped";
    f.view.row.mode = "read-only";
    f.view.row.role = "RETRO";
    f.view.row.area = [];
    f.view.row.loop = null;
    f.view.steps = [];
    const configured = f.api["/api/config"].crew.sessions[0].seats.find((seat) => seat.id === f.view.row.id);
    Object.assign(configured, { role: "RETRO", mode: "read-only", area: [] });
    const saved = f.api["/api/crew/changes"].sessions[0].seats.find((seat) => seat.id === f.view.row.id);
    Object.assign(saved, { role: "RETRO", area: [] });
    f.view.row.review = null;
    f.view.row.reviewing = null;
    f.view.row.crewPause = paused ? { seats: "all", by: "CAPCOM", reason: "Operator paused the crew", at: NOW } : null;
    f.view.row.queuedReview = { repoId: "shop-app", prNumber: 77, sha, ref: "shop-app#77", position: 1, reason: paused ? "Waiting for this seat to resume after the crew pause" : "Waiting for this stopped seat to restart" };
    f.view.row.run = { ...f.view.row.run, status: "ok", endedAt: NOW - 300000 };
    f.view.awaiting = { label: paused ? "Crew paused" : "Stopped", reason: paused ? "Operator paused the crew" : "The seat has no running CLI turn", since: NOW };
    f.view.health = { label: "Review waiting", blocking: null, failedTools: null };
    f.view.story.report = "The previous run left its evidence saved. No result is recorded for the queued review head.";
    f.view.related = [];
    f.view.nextMove = { owner: "operator", text: paused ? "Resume the crew when ready to process this queued review." : "Restart this seat when ready to process the queued review.", recommendation: null, label: "Open sessions", href: "/setup/sessions" };
  }
  return f;
}

const receipts = [], supplements = [], versions = [], audits = [];
writeFileSync(join(out, "run-start.json"), JSON.stringify({ startedAt: new Date().toISOString(), before: git(beforeRoot, "rev-parse", "HEAD"), after: git(afterRoot, "rev-parse", "HEAD"), helperSha256: hash(readFileSync(import.meta.filename)), harnessSha256: hash(sourceHarness), fixtureClock: new Date(NOW).toISOString(), cases: activeCases }, null, 2));
const selectors = { story: ".agent-v2-story", figures: ".agent-v2-stats", loop: ".agent-v2-steps" };
const focused = (c) => c.page === "agent" && c.scenario === "default" && ((c.width === 1280 && c.dock === "open") || (c.width === 1600 && c.height === 1000 && c.dock === "open") || (c.width === 1920 && c.dock === "folded"));
for (const version of [{ name: "before", root: beforeRoot }, { name: "after", root: afterRoot }]) {
  const source = git(version.root, "rev-parse", "HEAD");
  if (git(version.root, "status", "--porcelain", "--", "apps/web/src")) throw Error("Product source must be clean");
  if (version.name === "after" && git(version.root, "status", "--porcelain")) throw Error("Final capture requires a clean source checkpoint");
  const sourceTree = git(version.root, "rev-parse", "HEAD:apps/web/src");
  versions.push({ version: version.name, source, sourceTree, harnessSha256: hash(sourceHarness), harnessScope: "Identical current test harness in both worktrees; product source unchanged. Frozen clock, controlled GETs, session rail state, real production App/fonts. No CSS injection." });
  const root = join(version.root, "apps/web"), buildDir = join(out, `${version.name}-build`);
  await build({ root, configFile: join(root, "vite.config.ts"), logLevel: "error", build: { outDir: buildDir, emptyOutDir: true, rollupOptions: { input: join(root, "test/agentV2Browser.html") } } });
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    for (const c of activeCases) {
      const context = await browser.newContext({ viewport: { width: c.width, height: c.height }, deviceScaleFactor: 1, colorScheme: c.scheme });
      const page = await context.newPage(), errors = [], requests = [], writes = [];
      page.setDefaultTimeout(5000); page.on("pageerror", (error) => errors.push(error.message));
      const fixture = fixtureFor(c), api = fixture.api, apiSha256 = hash(JSON.stringify(api));
      await page.route("**/*", async (route) => {
        const request = route.request(), url = new URL(request.url()), key = url.pathname + url.search;
        if (request.method() !== "GET") { writes.push(`${request.method()} ${key}`); return route.abort(); }
        if (url.origin !== "http://mc.test") return route.abort();
        if (key.startsWith("/api/")) {
          const known = Object.hasOwn(api, key); requests.push({ path: key, status: known ? 200 : 404 });
          return route.fulfill({ status: known ? 200 : 404, contentType: "application/json", body: JSON.stringify(known ? api[key] : { error: "Unspecified fixture resource" }) });
        }
        const file = normalize(join(buildDir, url.pathname));
        if (file.startsWith(buildDir + "/") && existsSync(file) && statSync(file).isFile()) return route.fulfill({ contentType: ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" })[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
        return route.fulfill({ status: 404, body: "{}" });
      });
      try {
        const at = c.page === "setup" ? "/setup/sessions" : c.scenario === "empty" ? "/agent" : "/agent/guido-1";
        await page.goto(`http://mc.test/test/agentV2Browser.html?dock=${c.dock}&state=${c.scenario}&at=${encodeURIComponent(at)}`);
        const expected = c.page === "setup" ? "claude-opus-4-1 · high" : c.scenario === "empty" ? "No agents in this session." : c.scenario === "loading" ? "Loading…" : c.scenario === "error" ? "Could not load this agent." : c.scenario === "one" ? "No run yet." : "Ask → result → next";
        await page.waitForFunction(({ expected, setup }) => (document.querySelector(setup ? "#page-setup" : "#page-agent")?.textContent ?? "").includes(expected), { expected, setup: c.page === "setup" });
        if (c.scenario === "stale") { await page.evaluate(() => window.dispatchEvent(new Event("fixture-stale-agent"))); await page.waitForFunction(() => document.querySelector("#page-agent")?.textContent?.includes("Showing the last saved agent view.")); }
        await page.evaluate(async () => { await document.fonts.ready; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); });
        await page.evaluate(() => { const original = window.fetch.bind(window); window.__captureReads = []; window.fetch = (input, init) => { window.__captureReads.push(String(typeof input === "string" ? input : input.url ?? input)); return original(input, init); }; });
        const facts = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio, bodyWidth: document.documentElement.scrollWidth, mainScroll: document.querySelector("main")?.scrollTop, agentScroll: document.querySelector("#page-agent")?.scrollTop, pickerCount: document.querySelectorAll("#picker button").length, figures: document.querySelectorAll(".agent-v2-stat").length, steps: document.querySelectorAll(".agent-v2-steps li").length, story: document.querySelector(".agent-v2-story")?.getBoundingClientRect().toJSON(), next: document.querySelector(".agent-v2-next")?.getBoundingClientRect().toJSON(), model: document.querySelector("#ahead .chips")?.textContent, identity: (() => { const el = document.querySelector(".agent-v2-identity"); return el ? { rect: el.getBoundingClientRect().toJSON(), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth } : null; })(), queuedHref: [...document.querySelectorAll("a")].find((a) => a.textContent?.trim() === "Review evidence for this head")?.getAttribute("href"), fonts: [...document.fonts].filter((font) => font.status === "loaded").map((font) => ({ family: font.family, weight: font.weight })) }));
        const shot = async (region, selector = null) => {
          const file = `${c.key}-${region}-${version.name}.png`, capturedAt = new Date().toISOString();
          if (selector) await page.locator(selector).screenshot({ path: join(images, file) }); else await page.screenshot({ path: join(images, file) });
          const bytes = readFileSync(join(images, file)), png = decodePng(bytes);
          receipts.push({ key: c.key, ...c, region, version: version.name, source, apiSha256, file, sha256: hash(bytes), bytes: bytes.length, pixels: { width: png.width, height: png.height }, capturedAt, facts, pageErrors: errors.slice(), writes: writes.slice(), scope: selector ? "Focused region in the same production App; native screenshot scrolling, no injected component/CSS." : "Actual production App initial viewport; not full-page scroll height. Controlled fictional API values." });
        };
        await shot("context");
        if (facts.bodyWidth > c.width + 1 || facts.scale !== 1 || errors.length || writes.length) throw Error(`Render failed ${c.key}: ${JSON.stringify({ facts, errors, writes })}`);
        if (version.name === "after" && c.page === "agent" && c.scenario === "default" && (facts.story.bottom >= c.height || facts.next.top >= c.height || facts.figures !== 5 || facts.steps !== 6)) throw Error("Answer/retained figures/steps failed " + c.key);
        if (version.name === "after" && c.scenario.startsWith("queued-") && !facts.queuedHref?.includes(`head=${fixture.view.row.queuedReview.sha}`)) throw Error("Queued evidence must pin the supplied head");
        if (version.name === "after" && c.scenario === "long" && facts.identity.scrollWidth > facts.identity.clientWidth + 1) throw Error("Long identity must wrap without clipping");
        if (!["IBM Plex Sans", "Barlow Semi Condensed", "IBM Plex Mono"].every((family) => facts.fonts.some((font) => font.family.includes(family)))) throw Error("Production fonts not loaded " + c.key);
        if (focused(c)) for (const [region, selector] of Object.entries(selectors)) await shot(region, selector);
        if (version.name === "after" && c.page === "agent" && c.scenario === "default" && c.width === 1600 && c.height === 1000 && c.dock === "open") {
          const draft = "Preserve this Agent draft while FLIGHT folds and the viewport changes.";
          const input = page.locator("#agentInput"); await input.fill(draft);
          await page.evaluate(() => { window.__draftNode = document.querySelector("#agentInput"); });
          await page.getByTitle("Collapse FLIGHT to its rail").click();
          await page.getByRole("button", { name: /^Expand FLIGHT:/ }).click();
          await page.setViewportSize({ width: 1280, height: 700 }); await page.setViewportSize({ width: 1600, height: 1000 });
          const retained = await page.evaluate(() => ({ sameNode: window.__draftNode === document.querySelector("#agentInput"), draft: document.querySelector("#agentInput")?.value }));
          if (!retained.sameNode || retained.draft !== draft) throw Error("Composer draft or node lost across rail/resize");
          await page.locator("#picker").focus(); const targets = [];
          for (let i = 0; i < 24; i++) {
            await page.keyboard.press("Tab");
            const target = await page.evaluate(async () => { await new Promise((r) => requestAnimationFrame(r)); const el = document.activeElement, box = el.getBoundingClientRect(), css = getComputedStyle(el); return { tag: el.tagName, text: (el.getAttribute("aria-label") ?? el.textContent ?? "").slice(0, 100), width: box.width, height: box.height, box: box.toJSON(), inAgent: !!el.closest("#page-agent"), painted: el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)), outline: css.outlineStyle, outlineWidth: css.outlineWidth }; });
            targets.push(target); if (!target.inAgent || !target.painted || target.width < 24 || target.height < 24 || target.outline === "none") throw Error("Keyboard focus/target failed " + JSON.stringify(target));
          }
          const file = `${c.key}-keyboard-draft-after.png`; await page.screenshot({ path: join(images, file) });
          supplements.push({ key: c.key, kind: "keyboard-draft", file, sha256: hash(readFileSync(join(images, file))), capturedAt: new Date().toISOString(), source, apiSha256, retained, targets, readsAfter: await page.evaluate(() => window.__captureReads), scope: "24 real Tab targets, retained composer node/value through actual FLIGHT fold/open and viewport resize; no sends or seat actions." });
        }
        if (version.name === "after" && c.scenario === "long") {
          await page.getByRole("button", { name: "Read full reported result", exact: true }).click(); await page.keyboard.press("Tab");
          await page.waitForFunction(() => { const el = document.querySelector('[aria-label="Full reported result"]'), box = el.getBoundingClientRect(), clip = document.querySelector("#page-agent").getBoundingClientRect(); return document.activeElement === el && box.top >= clip.top && box.bottom <= clip.bottom; });
          await page.keyboard.press("End");
          await page.waitForFunction(() => { const el = document.querySelector('[aria-label="Full reported result"]'), range = document.createRange(); range.selectNodeContents(el); const last = [...range.getClientRects()].at(-1); return el.scrollHeight - el.clientHeight - el.scrollTop <= 2 && el.contains(document.elementFromPoint(last.x + Math.min(last.width / 2, 20), last.y + last.height / 2)); });
          const file = `${c.key}-full-text-end-after.png`; await page.screenshot({ path: join(images, file) });
          const readerFacts = await page.evaluate(() => { const el = document.querySelector('[aria-label="Full reported result"]'), range = document.createRange(); range.selectNodeContents(el); const last = [...range.getClientRects()].at(-1); return { active: document.activeElement?.getAttribute("aria-label"), region: el.getBoundingClientRect().toJSON(), last: last.toJSON(), remaining: el.scrollHeight - el.clientHeight - el.scrollTop, hit: document.elementFromPoint(last.x + Math.min(last.width / 2, 20), last.y + last.height / 2)?.tagName }; });
          supplements.push({ key: c.key, kind: "full-text-end", facts: readerFacts, file, sha256: hash(readFileSync(join(images, file))), capturedAt: new Date().toISOString(), source, apiSha256, scope: "Real Read full → Tab → End; complete report retained and final text line painted inside the focused reader." });
        }
        if (version.name === "after" && c.scenario === "many") for (const [kind, selector, lastSelector] of [["50th-link", ".agent-v2-deliverables", "li:last-child a"], ["50th-seat", "#picker", "button:last-child"]]) {
          await page.locator(selector).focus(); await page.keyboard.press("End");
          await page.waitForFunction(({ selector, lastSelector }) => { const region = document.querySelector(selector), el = region.querySelector(lastSelector), box = el.getBoundingClientRect(); return region.scrollHeight - region.clientHeight - region.scrollTop <= 2 && el.contains(document.elementFromPoint(box.x + Math.min(box.width / 2, 30), box.y + box.height / 2)); }, { selector, lastSelector });
          const file = `${c.key}-${kind}-after.png`; await page.screenshot({ path: join(images, file) });
          const lastFacts = await page.evaluate(({ selector, lastSelector }) => { const region = document.querySelector(selector), last = region.querySelector(lastSelector), box = last.getBoundingClientRect(); return { count: region.querySelectorAll(selector === "#picker" ? "button" : "a").length, text: last.textContent, remaining: region.scrollHeight - region.clientHeight - region.scrollTop, region: region.getBoundingClientRect().toJSON(), last: box.toJSON(), hit: document.elementFromPoint(box.x + Math.min(box.width / 2, 30), box.y + box.height / 2)?.tagName }; }, { selector, lastSelector });
          supplements.push({ key: c.key, kind, facts: lastFacts, file, sha256: hash(readFileSync(join(images, file))), capturedAt: new Date().toISOString(), source, apiSha256, scope: "Native End reaches the final retained item, with actual viewport paint hit; no pagination/write/fetch action." });
        }
        const readsAfter = await page.evaluate(() => window.__captureReads);
        if (readsAfter.length || errors.length || writes.length) throw Error("Unexpected reads/errors/writes after settlement " + JSON.stringify({ key: c.key, readsAfter, errors, writes }));
        audits.push({ key: c.key, version: version.name, source, apiSha256, networkFixtureGets: requests, fetchCallsAfterSettlement: readsAfter, errors, writes, stateResponses: ["loading", "error", "stale"].includes(c.scenario) ? "The identical harness synthesizes the named loading/503 response; these are not live network failures." : null });
        writeFileSync(join(out, "progress.json"), JSON.stringify({ versions, lastCase: c.key, receipts, supplements, audits }));
      } catch (error) {
        writeFileSync(join(out, "failure.json"), JSON.stringify({ at: new Date().toISOString(), key: c.key, source, apiSha256, error: String(error), pageErrors: errors, writes, requests, completedReceipts: receipts.filter((r) => r.key === c.key && r.version === version.name) }, null, 2));
        throw error;
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
}
const pairs = [];
for (const after of receipts.filter((r) => r.version === "after")) {
  const before = receipts.find((r) => r.version === "before" && r.key === after.key && r.region === after.region);
  if (!before || before.apiSha256 !== after.apiSha256) throw Error("Pair payload mismatch");
  const diff = diffImages(decodePng(readFileSync(join(images, before.file))), decodePng(readFileSync(join(images, after.file))));
  const file = `${after.key}-${after.region}-diff.png`; writeFileSync(join(images, file), diff.png);
  pairs.push({ key: after.key, region: after.region, before: before.file, after: after.file, diff: file, diffSha256: hash(diff.png), changedPixels: diff.changedPixels, changedPercent: diff.changedPercent, scope: "Same payload/clock/viewport/theme/rail, actual source comparison. Focused regions use a common diff canvas if their natural sizes differ." });
}
const proof = { versions, completedAt: new Date().toISOString(), fixtureClock: new Date(NOW).toISOString(), sourceHelperSha256: hash(readFileSync(import.meta.filename)), fixtureSha256: hash(readFileSync(join(afterRoot, "apps/web/test/agentDensityFixture.ts"))), harnessSha256: hash(sourceHarness), cases: activeCases.length, receipts, pairs, supplements, audits, pngs: receipts.length + pairs.length + supplements.length, scope: "Fictional API values in actual production App renders; no live hub/provider/crew/config writes. Normal/context pairs are initial viewport views, not full scroll. New availability panel has no standalone before equivalent; its facts previously lived in identity/metadata. Baseline and frozen current product sources are bound by versions/source-tree hashes. Exact capture times are UTC." };
writeFileSync(join(out, "render-checks.json"), JSON.stringify(proof, null, 2));
console.log(JSON.stringify({ out, versions, cases: proof.cases, pairs: pairs.length, supplements: supplements.length, pngs: proof.pngs, pageErrors: 0, writes: 0 }));
