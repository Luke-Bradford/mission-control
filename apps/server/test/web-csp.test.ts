import { describe, expect, it } from "vitest";
import { WEB_CSP } from "../src/web.ts";

const directives = WEB_CSP.split("; ");

describe("WEB_CSP", () => {
  it("allows no frames", () => {
    expect(directives.filter((d) => d.startsWith("frame-src"))).toEqual(["frame-src 'none'"]);
  });

  it("keeps the page from being framed and everything else on its own origin", () => {
    expect(directives).toContain("frame-ancestors 'none'");
    expect(directives).toContain("default-src 'self'");
  });
});
