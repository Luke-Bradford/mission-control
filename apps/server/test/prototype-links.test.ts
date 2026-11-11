import { describe, expect, it } from "vitest";
import { PRIVATE_PROTOTYPE_TEXT, prototypeLinkProblem } from "../src/prototype-links.ts";

describe("repository prototype links", () => {
  it.each([
    "https://private.example/docs/prototype/mockup.html",
    "//private.example/docs/prototype/mockup.html",
    "\\\\private.example/docs/prototype/mockup.html",
    "https://github.com/another/repo/blob/main/docs/prototype/mockup.html",
    "https://github.com/o/mc.evil/blob/main/docs/prototype/mockup.html",
    "https://github.com/o/mc/blob/main/private/docs/prototype/mockup.html",
    "https://github.com.evil/o/mc/blob/main/docs/prototype/mockup.html",
    "https://github.com@private.example/o/mc/blob/main/docs/prototype/mockup.html",
    "docs/prototype/../private/mockup.html",
  ])("flags an inaccessible prototype: %s", (link) => {
    expect(prototypeLinkProblem(`Prototype: [working copy](${link})`, "o/mc")).toBe(
      PRIVATE_PROTOTYPE_TEXT,
    );
  });

  it.each([
    "docs/prototype/mockup.html",
    "./docs/prototype/mockup.html#agents",
    "/docs/prototype/mockup.html?view=board",
    "https://github.com/o/mc/blob/main/docs/prototype/mockup.html",
    "https://raw.githubusercontent.com/o/mc/main/docs/prototype/mockup.html",
    "https://github.com/o/mc/blob/feature/prototype-polish/docs/prototype/mockup.html",
    "https://raw.githubusercontent.com/o/mc/feature/prototype-polish/docs/prototype/mockup.html",
  ])("accepts a prototype in the configured repository: %s", (link) => {
    expect(prototypeLinkProblem(`Prototype: [working copy](${link})`, "o/mc")).toBeNull();
  });
});
