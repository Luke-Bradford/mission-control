import { readFileSync } from "node:fs";
import { DEMO_MARKER_LABEL, DEMO_SESSION_KEY } from "@mc/core";
import { expect, it } from "vitest";

/** The Demo render turns Demo on by the web app's storage key and waits for its marker. */
const source = (path: string): string =>
  readFileSync(new URL(`../../web/src/${path}`, import.meta.url), "utf8");

it("the web app still uses the Demo key and marker text the evidence render expects", () => {
  expect(source("storage.ts")).toContain(`export const DEMO_KEY = "${DEMO_SESSION_KEY}";`);
  expect(source("demo/mode.ts")).toContain(DEMO_MARKER_LABEL);
});
