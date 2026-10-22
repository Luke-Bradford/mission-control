import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Import for its side effect, before anything reads `~`: points HOME at an empty temp folder so a
// config that says `~/code/...` resolves there, never to the machine's real folders (where the
// crew guard would trip over a checkout living under `~/code/mc-crew`, and git would be run).
// The temp folder comes from `os.tmpdir()`, which must lie outside the checkout.
const realHome = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), "mc-home-"));
process.env.HOME = home;

afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});
