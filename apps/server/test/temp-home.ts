import { afterAll } from "vitest";

// Import for its side effect, before anything reads `~`: points HOME at a synthetic path so a
// config that says `~/code/...` never resolves to the machine's real folders (where the crew
// guard would trip over a checkout living under `~/code/mc-crew`, and git would be run). It must
// stay outside the checkout: the harness may set TMPDIR beneath it, and production rejects that.
const realHome = process.env.HOME;
const home = "/mc-test-home";
process.env.HOME = home;

afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
});
