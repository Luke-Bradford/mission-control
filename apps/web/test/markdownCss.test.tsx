import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown, MD_CODE_CLASS } from "../src/components/Markdown.tsx";
import { readStyles } from "./styles.ts";

const css = readStyles();
const rule = (sel: string) => css.match(new RegExp(`\\n${sel} \\{([^}]*)\\}`))?.[1] ?? "";

describe("Markdown layout (hud.css)", () => {
  it("a code block scrolls inside its own box, under the class the renderer sets", () => {
    const c = render(<Markdown text={"```\nx\n```"} />).container;
    const cls = c.querySelector("pre")?.className ?? "";
    expect(cls).toBe(MD_CODE_CLASS);
    const r = rule(String.raw`\.md pre\.${cls}`);
    expect(r).toContain("overflow-x: auto");
    expect(r).toContain("white-space: pre");
    expect(r).toContain("max-width: 100%");
  });

  it("the brief's containers can shrink, so a long code line cannot widen the panel", () => {
    expect(rule(String.raw`\.brief`)).toContain("minmax(0, 1fr)");
    expect(rule(String.raw`\.qtext`)).toContain("min-width: 0");
    expect(rule(String.raw`\.md`)).toContain("min-width: 0");
  });

  it("a collapsed tool row is one line and its result avoids the global .res grid", () => {
    expect(rule(String.raw`\.ev\.tool summary`)).toContain("white-space: nowrap");
    expect(rule(String.raw`\.ev\.tool summary`)).toContain("text-overflow: ellipsis");
    expect(rule(String.raw`\.ev\.tool \.tres`)).toContain("color");
    expect(css).not.toMatch(/\.ev\.tool \.res\b/);
  });

  it("inline code outside .md is styled like code inside it", () => {
    const sels = [".md", ".rsummary", ".nrow", ".nowt", ".needpart", ".arow", ".btitle", ".opt"];
    const r = rule(sels.map((s) => `${s} code`).join(",\\n"));
    expect(r).toContain("font-family: var(--mono)");
    expect(r).toContain("font-size: 0.92em");
  });

  it("a long token in the loop's text wraps instead of widening the Loop panel", () => {
    expect(rule(String.raw`\.vsteps`)).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(css).toMatch(
      /\n\.vnow,\n\.vhold > span:last-child \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere/,
    );
  });

  it("the current step's dot pulses unless motion is reduced", () => {
    expect(css).toMatch(
      /prefers-reduced-motion: no-preference\) \{\s*\.vstep\.cur \.tdot \{\s*animation: po 3\.2s/,
    );
  });

  it("the ticket description is a shrinkable grid item, so a long code line cannot widen the pane", () => {
    expect(rule(String.raw`\.tbody`)).toContain("min-width: 0");
  });
});
