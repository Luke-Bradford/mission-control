import { afterAll } from "vitest";

// Import for its side effect, before anything reads `~`: points HOME at an inert folder outside
// the checkout. A sandbox can place TMPDIR inside the checkout, which production correctly
// refuses as a crew worktree; this fixture must exercise neither that path nor a real home.
const realHome = process.env.HOME;
const home = "/var/empty";
process.env.HOME = home;

afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
});
