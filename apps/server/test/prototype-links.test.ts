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
  ])("accepts a prototype in this repository, even on a slash-named branch: %s", (link) => {
    expect(prototypeLinkProblem(`Prototype: [working copy](${link})`, "o/mc")).toBeNull();
  });

  it.each([
    "Judge against the mockup and [system](https://github.com/o/mc/blob/main/docs/design/system.md)",
    "Build what the mockup shows; see https://github.com/o/mc/pull/1360",
    "The mockup is settled, see [the spec](docs/superpowers/specs/design.md)",
  ])("leaves an ordinary in-repository link beside the word alone: %s", (line) => {
    expect(prototypeLinkProblem(line, "o/mc")).toBeNull();
  });

  it("still flags an outside link that only shares a line with the word", () => {
    expect(
      prototypeLinkProblem("Build what the mockup shows; see https://private.example/doc", "o/mc"),
    ).toBe(PRIVATE_PROTOTYPE_TEXT);
  });

  it.each([
    "## Prototype\n\nhttps://claude.ai/public/artifacts/abc",
    "### Prototype\n- [working copy](https://private.example/hud.html)",
    "## Mockups\n\n[view](https://github.com/o/mc/blob/main/docs/design/system.md)",
  ])("flags a link under a prototype heading: %s", (body) => {
    expect(prototypeLinkProblem(body, "o/mc")).toBe(PRIVATE_PROTOTYPE_TEXT);
  });

  it("stops treating links as prototype links at the next heading of the same level", () => {
    const body =
      "## Prototype\n\n[copy](docs/prototype/hud.html)\n\n## Notes\n\nhttps://example.com/x";
    expect(prototypeLinkProblem(body, "o/mc")).toBeNull();
  });
});
