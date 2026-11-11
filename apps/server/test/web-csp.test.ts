import { describe, expect, it } from "vitest";
import { DESIGN_PREVIEW_PORT } from "../src/design-preview/previews.ts";
import { WEB_CSP } from "../src/web.ts";

const directives = WEB_CSP.split("; ");

describe("WEB_CSP", () => {
  it("allows frames from the design preview origin and no other", () => {
    expect(directives.filter((d) => d.startsWith("frame-src"))).toEqual([
      `frame-src http://127.0.0.1:${DESIGN_PREVIEW_PORT}`,
    ]);
    expect(DESIGN_PREVIEW_PORT).toBe(7440);
  });

  it("keeps the page from being framed and everything else on its own origin", () => {
    expect(directives).toContain("frame-ancestors 'none'");
    expect(directives).toContain("default-src 'self'");
  });
});
