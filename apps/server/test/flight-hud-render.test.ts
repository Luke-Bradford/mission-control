import { describe, expect, it } from "vitest";
import { hudRenderRequest } from "../src/flight/hud-render.ts";

describe("hudRenderRequest", () => {
  it("permits only GET requests to the hub origin", () => {
    const guard = hudRenderRequest("http://127.0.0.1:7420");
    expect(guard("GET", "http://127.0.0.1:7420/map")).toBe(true);
    expect(guard("POST", "http://127.0.0.1:7420/api/board")).toBe(false);
    expect(guard("GET", "https://example.test/")).toBe(false);
  });

  it("rejects non-HUD pages before launching a browser", () => {
    const guard = hudRenderRequest("http://127.0.0.1:7420");
    expect(guard.page("/map")).toBe("http://127.0.0.1:7420/map");
    expect(() => guard.page("/mcp")).toThrow("HUD page");
    expect(() => guard.page("https://example.test/")).toThrow("HUD page");
  });
});
