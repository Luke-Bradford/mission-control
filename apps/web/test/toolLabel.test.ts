import { describe, expect, it } from "vitest";
import { toolLabel } from "../src/toolLabel.ts";

describe("toolLabel", () => {
  it("gives an mcp tool with a known name a plain label", () => {
    expect(toolLabel("mcp__mc__screenshot_hud")).toBe("Taking a screenshot");
  });

  it("drops the mcp prefix and the underscores from an mcp tool with no label", () => {
    expect(toolLabel("mcp__mc__report_evidence")).toBe("Report evidence");
    expect(toolLabel("mcp__other__do_a_thing")).toBe("Do a thing");
  });

  it("reads a server name that holds an underscore", () => {
    expect(toolLabel("mcp__my_server__screenshot_hud")).toBe("Taking a screenshot");
    expect(toolLabel("mcp__my_server__list_files")).toBe("List files");
  });

  it("leaves a built-in tool as it is", () => {
    expect(toolLabel("Bash")).toBe("Bash");
    expect(toolLabel("Read")).toBe("Read");
  });

  it("leaves an unknown tool as it is", () => {
    expect(toolLabel("SomethingNew")).toBe("SomethingNew");
    expect(toolLabel("mcp__broken")).toBe("mcp__broken");
  });
});
