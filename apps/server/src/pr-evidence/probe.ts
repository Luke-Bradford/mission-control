/**
 * Renders every evidence page, light and dark, against one running hub and prints how long each
 * took and which failed. For finding the page that hangs a capture (#1409). Start a preview hub
 * first (see CLAUDE.md: MC_PORT, MC_DB=<copy of the DB>, MC_NO_LOOP_WRITES=1), then:
 *
 *   node --experimental-strip-types apps/server/src/pr-evidence/probe.ts http://127.0.0.1:<port>
 *
 * Run it once per side (main and the PR head) to see which side a page fails on.
 */
import { EVIDENCE_PAGE_PATHS, EVIDENCE_PAGES, EVIDENCE_SCHEMES } from "@mc/core";
import { hudRenderRequest, renderHudInHelper } from "../flight/hud-render.ts";

const origin = process.argv[2];
if (!origin) {
  console.error("usage: probe.ts <hub origin>");
  process.exit(2);
}
const guard = hudRenderRequest(origin);
const started = Date.now();
let failed = 0;
for (const page of EVIDENCE_PAGES) {
  for (const scheme of EVIDENCE_SCHEMES) {
    const t = Date.now();
    try {
      const png = await renderHudInHelper(guard.page(EVIDENCE_PAGE_PATHS[page]), guard, {
        colorScheme: scheme,
      });
      console.log(`ok     ${page} ${scheme} ${Date.now() - t} ms ${png.byteLength} bytes`);
    } catch (e) {
      failed += 1;
      console.log(
        `FAILED ${page} ${scheme} ${Date.now() - t} ms: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
console.log(`${failed} failed; total ${Date.now() - started} ms`);
process.exit(failed === 0 ? 0 : 1);
