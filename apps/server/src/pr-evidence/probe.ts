/**
 * Renders every evidence page, light and dark, against one running hub, saves each PNG, and prints
 * how long each took and which failed. For finding the page that hangs a capture (#1409) and for
 * looking at what a capture would store. Start a preview hub first (see CLAUDE.md: MC_PORT,
 * MC_DB=<copy of the DB>, MC_NO_LOOP_WRITES=1), then:
 *
 *   node --experimental-strip-types apps/server/src/pr-evidence/probe.ts http://127.0.0.1:<port> [out dir]
 *
 * The images go to `out dir` (default: a new folder under the temp dir) as `<page>-<scheme>.png`.
 * Run it once per side (main and the PR head) to see which side a page fails on.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVIDENCE_PAGE_PATHS,
  EVIDENCE_PAGES,
  EVIDENCE_SCHEMES,
  type EvidenceScheme,
} from "@mc/core";
import { hudRenderRequest, renderHudInHelper } from "../flight/hud-render.ts";

export interface ProbeOptions {
  origin: string;
  /** Where each PNG is saved. */
  out: string;
  render?: (url: string, scheme: EvidenceScheme) => Promise<Buffer>;
  log?: (line: string) => void;
}

/** Renders every page in both schemes; returns how many failed. */
export async function probeEvidencePages(o: ProbeOptions): Promise<number> {
  const log = o.log ?? console.log;
  const guard = hudRenderRequest(o.origin);
  const render =
    o.render ??
    ((url: string, colorScheme: EvidenceScheme) => renderHudInHelper(url, guard, { colorScheme }));
  mkdirSync(o.out, { recursive: true });
  const started = Date.now();
  let failed = 0;
  for (const page of EVIDENCE_PAGES) {
    for (const scheme of EVIDENCE_SCHEMES) {
      const t = Date.now();
      try {
        const png = await render(guard.page(EVIDENCE_PAGE_PATHS[page]), scheme);
        const file = join(o.out, `${page}-${scheme}.png`);
        writeFileSync(file, png);
        log(`ok     ${page} ${scheme} ${Date.now() - t} ms ${png.byteLength} bytes ${file}`);
      } catch (e) {
        failed += 1;
        log(
          `FAILED ${page} ${scheme} ${Date.now() - t} ms: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
  log(`${failed} failed; total ${Date.now() - started} ms`);
  return failed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const origin = process.argv[2];
  if (!origin) {
    console.error("usage: probe.ts <hub origin> [out dir]");
    process.exit(2);
  }
  const out = process.argv[3] ?? mkdtempSync(join(tmpdir(), "mc-evidence-probe-"));
  process.exit((await probeEvidencePages({ origin, out })) === 0 ? 0 : 1);
}
