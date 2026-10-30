import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { readStyle } from "./styles.ts";

/**
 * The HUD design system (docs/design/system.md §2–4) as a lint: hud.css defines the type scale,
 * the spacing scale and the palette; nothing else in src sets a font size, a spacing or a colour.
 * theme.ts and the `:root` blocks of hud.css are the token files and may hold raw values.
 */

const SRC = join(import.meta.dirname, "../src");
const TOKEN_FILES = new Set(["theme.ts"]);

const TYPE_TOKENS = {
  "--fs-title": "20px",
  "--fs-panel": "14px",
  "--fs": "13px",
  "--fs-s": "12px",
  "--fs-micro": "11px",
} as const;
const LINE_TOKENS = {
  "--lh-title": "28px",
  "--lh-panel": "20px",
  "--lh": "20px",
  "--lh-s": "16px",
  "--lh-micro": "16px",
} as const;
const SPACING_TOKENS = {
  "--sp-1": "4px",
  "--sp-2": "8px",
  "--sp-3": "12px",
  "--sp-4": "16px",
  "--sp-5": "24px",
  "--sp-6": "32px",
  "--sp-7": "48px",
} as const;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

const FILES = sourceFiles(SRC)
  .map((file) => relative(SRC, file))
  .filter((file) => /\.(css|tsx?)$/.test(file) && !TOKEN_FILES.has(file));

const blank = (text: string) => text.replace(/[^\n]/g, " ");
/** The stylesheet without its comments and its `:root` token blocks, line numbers kept. */
const stripCss = (css: string) =>
  css.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/:root[^{]*\{[\s\S]*?\n\s*\}/g, blank);
const stripTs = (ts: string) =>
  ts
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

const FONT_SIZE_OK = /^(var\(--fs(-title|-panel|-s|-micro)?\)|inherit)$/;
const LINE_HEIGHT_OK = /^(var\(--lh(-title|-panel|-s|-micro)?\)|inherit)$/;
const SPACING_PROP = /^(padding|margin|gap|row-gap|column-gap)(-[a-z]+)*$/;

/** Every `prop: value` of a stylesheet, with the line it is on. */
function declarations(css: string): { line: number; prop: string; value: string }[] {
  const out: { line: number; prop: string; value: string }[] = [];
  for (const m of css.matchAll(/(^|[{;\s])([a-z-]+)\s*:\s*([^;{}]+)(?=[;}])/g)) {
    const at = (m.index ?? 0) + (m[1]?.length ?? 0);
    out.push({
      line: css.slice(0, at).split("\n").length,
      prop: m[2] as string,
      value: (m[3] as string).trim(),
    });
  }
  return out;
}

/** What is raw in one source file: `file:line text` per offence. */
function offences(file: string, text: string): string[] {
  const found: string[] = [];
  if (file.endsWith(".css")) {
    const css = stripCss(text);
    for (const { line, prop, value } of declarations(css)) {
      const at = `${file}:${line} ${prop}: ${value}`;
      if (prop === "font-size" && !FONT_SIZE_OK.test(value)) found.push(at);
      if (
        prop === "font" &&
        value !== "inherit" &&
        !/var\(--fs(-title|-panel|-s|-micro)?\)/.test(value)
      )
        found.push(at);
      if (prop === "line-height" && !LINE_HEIGHT_OK.test(value)) found.push(at);
      if (prop === "font" && value !== "inherit" && !/\/\s*var\(--lh/.test(value)) found.push(at);
      if (prop === "font" && /\d\s*(px|em|rem)\b/.test(value)) found.push(at);
      if (SPACING_PROP.test(prop) && /\d(px|rem|em)\b/.test(value.replace(/\b0(px)?\b/g, "")))
        found.push(at);
    }
    for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?)\(/g)) {
      found.push(`${file}:${css.slice(0, m.index).split("\n").length} colour ${m[0]}`);
    }
    return found;
  }
  const ts = stripTs(text);
  const lineOf = (index: number | undefined) => ts.slice(0, index).split("\n").length;
  for (const m of ts.matchAll(/\bfontSize\b/g)) found.push(`${file}:${lineOf(m.index)} fontSize`);
  for (const m of ts.matchAll(/\b(padding|margin|gap)[A-Za-z]*\s*:\s*-?\d/g))
    found.push(`${file}:${lineOf(m.index)} ${m[0]}`);
  for (const m of ts.matchAll(
    /["'`]#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3}(?:[0-9a-fA-F]{2})?)?["'`]|\b(rgba?|hsla?)\(/g,
  ))
    found.push(`${file}:${lineOf(m.index)} colour ${m[0]}`);
  return found;
}

/** The `:root { … }` block that opens the file. */
function rootBlock(css: string): string {
  const start = css.indexOf(":root {");
  return css.slice(start, css.indexOf("\n}", start));
}

describe("hud.css tokens", () => {
  const hud = readStyle("hud.css");
  const root = rootBlock(hud);

  it("defines exactly the type scale and its line heights", () => {
    const fs = [...root.matchAll(/^ {2}(--(?:fs|lh)[a-z-]*): ([^;]+);/gm)];
    expect(Object.fromEntries(fs.map((m) => [m[1], m[2]]))).toEqual({
      ...TYPE_TOKENS,
      ...LINE_TOKENS,
    });
  });

  it("defines exactly the spacing scale", () => {
    const sp = [...root.matchAll(/^ {2}(--sp[a-z0-9-]*): ([^;]+);/gm)];
    expect(Object.fromEntries(sp.map((m) => [m[1], m[2]]))).toEqual(SPACING_TOKENS);
  });
});

describe("the web source uses only the tokens", () => {
  it("scans the app's files", () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  it("flags a raw font size, spacing and colour", () => {
    expect(offences("a.css", ".a { font-size: 10px; }")).toHaveLength(1);
    expect(offences("a.css", ".a { padding: 0 var(--sp-2); margin-top: 6px; }")).toHaveLength(1);
    expect(offences("a.css", ".a { color: #fff; box-shadow: 0 0 rgb(0 0 0); }")).toHaveLength(2);
    expect(offences("a.css", ".a { rgba(0, 0, 0, 0.5) }")).toHaveLength(1);
    expect(offences("a.css", ".a { font: 600 10px / 1.2 var(--mono); }")).toHaveLength(3);
    expect(offences("a.css", ".a { font: 600 var(--fs-s) / var(--lh-s) var(--mono); }")).toEqual(
      [],
    );
    expect(offences("a.css", ".a { line-height: 16px; }")).toHaveLength(1);
    expect(offences("a.css", ".a { line-height: 1.45; }")).toHaveLength(1);
    expect(offences("a.css", ".a { line-height: var(--lh); }")).toEqual([]);
    expect(offences("a.css", ".a { font: var(--fs-s) var(--mono); }")).toHaveLength(1);
    expect(offences("a.css", ".a { font: inherit; }")).toEqual([]);
    expect(offences("a.css", ".a { font: var(--fs-s) / 1.4 var(--mono); }")).toHaveLength(1);
    expect(offences("a.css", ":root {\n  --a: #fff;\n  --fs: 13px;\n}")).toEqual([]);
    expect(offences("a.css", "/* font-size: 10px; #fff */ .a { font-size: var(--fs-s); }")).toEqual(
      [],
    );
    expect(
      offences("a.tsx", "<i style={{ fontSize: 10, marginTop: 4, color: '#fff' }} />"),
    ).toHaveLength(3);
    expect(offences("a.ts", "// see #1082\nconst a = '#1082';")).toEqual([]);
  });

  it("sets no raw font size, spacing or colour", () => {
    const raw = FILES.flatMap((file) => offences(file, readFileSync(join(SRC, file), "utf8")));
    expect(raw).toEqual([]);
  });
});

/** Text a person reads (not a label) is never below the secondary size: 11px is for mono labels. */
describe("readable content is at least 12px", () => {
  const CONTENT = [
    ["hud/shared.css", "pre.diff"],
    ["agent/agent.css", ".ev.tool .txt"],
    ["agent/agent.css", ".ev details pre"],
    ["flight/flight.css", ".wif-branch"],
    ["flight/flight.css", ".wif-checkpoint"],
    ["lenses/lenses.css", ".map-lens"],
    ["lenses/lenses.css", ".map-conflict-detail"],
    ["map/map.css", ".map-results"],
    ["map/map.css", ".map-results button"],
    ["components/config/Glossary.css", ".gloss code"],
  ] as const;

  it.each(CONTENT)("%s %s", (file, selector) => {
    const css = readStyle(file);
    const at = css.indexOf(`\n${selector} {`);
    expect(at, `${selector} in ${file}`).toBeGreaterThanOrEqual(0);
    const body = css.slice(at, css.indexOf("}", at));
    expect(body).not.toContain("--fs-micro");
    expect(body).not.toContain("--lh-micro");
    expect(body).toMatch(/var\(--fs-s\)/);
  });
});
