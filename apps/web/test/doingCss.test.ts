import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILD_LOOP_TEMPLATE, LOOP_PHASE_LABEL } from "../src/crew.ts";

const css = readFileSync(join(import.meta.dirname, "../src/hud.css"), "utf8");
const rule = (sel: string) => css.match(new RegExp(`\\n${sel} \\{([^}]*)\\}`))?.[1] ?? "";

interface Track {
  px: number | null;
  fr: number;
  min: number;
}

const parseTrack = (t: string): Track => {
  const px = t.match(/^([\d.]+)px$/);
  if (px) return { px: Number(px[1]), fr: 0, min: 0 };
  const mm = t.match(/^minmax\(([\d.]+)(?:px)?, ([\d.]+)fr\)$/);
  if (mm) return { px: null, fr: Number(mm[2]), min: Number(mm[1]) };
  const fr = t.match(/^([\d.]+)fr$/);
  if (fr) return { px: null, fr: Number(fr[1]), min: 0 };
  throw new Error(`unreadable track: ${t}`);
};

const templateOf = (r: string): Track[] =>
  (r.match(/grid-template-columns: ([^;]*);/)?.[1] ?? "")
    .split(/ (?![^(]*\))/)
    .filter(Boolean)
    .map(parseTrack);

/** The doing text is 11px (--fs-xs), about 6.6px a character at its widest. */
const CHAR_PX = 6.6;

/** The longest Loop step label, `build › In review`, on one line. */
const LABEL_PX =
  Math.max(...Object.values(LOOP_PHASE_LABEL).map((l) => `${BUILD_LOOP_TEMPLATE} › ${l}`.length)) *
  CHAR_PX;

const gapOf = (r: string) => Number(r.match(/\n\s*gap: (\d+)px/)?.[1]);

/** Track widths in a container `avail` wide: fixed ones first, `fr` ones share the rest. */
function solve(tracks: Track[], avail: number, gap: number): number[] {
  const room = avail - gap * (tracks.length - 1);
  const widths = tracks.map((t) => t.px);
  for (;;) {
    const open = tracks.filter((_, i) => widths[i] === null);
    const left = room - widths.reduce<number>((n, w) => n + (w ?? 0), 0);
    // the browser would overrun the container; do not let a clamp to 0 hide it
    if (left < 0) throw new Error(`tracks overrun their container by ${-left}px`);
    const share = left / open.reduce((n, t) => n + t.fr, 0);
    const short = tracks.findIndex((t, i) => widths[i] === null && t.fr * share < t.min);
    if (short < 0) return tracks.map((t, i) => widths[i] ?? t.fr * share);
    widths[short] = tracks[short]?.min ?? 0;
  }
}

/** The nth px length after `prop:` in a rule (`max(16px, …)` and `8px 14px` both read). */
const pxOf = (r: string, prop: string, nth = 1) =>
  Number(r.match(new RegExp(`${prop}: (?:max\\()?(\\d+)px(?: (\\d+)px)?`))?.[nth]);

/**
 * The Overview's ticket column at `viewport` wide, worked out from the stylesheet: the app's
 * padding, the shell (page and FLIGHT's dock), the Overview's two columns, the panel's border,
 * the row's padding and the grid of `selector`.
 */
function ticketColumn(viewport: number, selector: string) {
  const app = rule(String.raw`\.app`);
  const inner = viewport - pxOf(app, "padding-left") - pxOf(app, "padding-right");
  const shell = rule(String.raw`\.shell`);
  // under 1200 the dock is a drawer and the page takes the whole width
  const drawer = css.match(
    /@media \(max-width: 1199px\) \{\n {2}\.shell,\n {2}\.app\.dock-hidden \.shell \{([^}]*)\}/,
  )?.[1];
  const [main] = solve(templateOf(viewport < 1200 ? (drawer ?? "") : shell), inner, gapOf(shell));
  const ov = rule(String.raw`\.ov`);
  const [agents] = solve(templateOf(ov), main ?? 0, gapOf(ov));
  const panel = (agents ?? 0) - 2 * pxOf(rule(String.raw`\.panel`), "border");
  const row = rule(String.raw`\.trow`);
  const tracks = templateOf(rule(selector));
  const cols = solve(tracks, panel - 2 * pxOf(row, "padding", 2), gapOf(row));
  return {
    tracks,
    cols,
    gap: gapOf(row),
    width: cols[tracks.findIndex((t) => t.px === null)] ?? 0,
  };
}

/** A `grid-column` value as the tracks it covers, `[first, last]` (0-based, inclusive). */
function columnsOf(r: string, count: number): [number, number] {
  const m = r.match(/grid-column: (-?\d+)(?: \/ (-?\d+))?;/);
  if (!m) throw new Error(`no grid-column in: ${r}`);
  const line = (n: number) => (n < 0 ? count + 2 + n : n);
  const start = line(Number(m[1]));
  return [start - 1, (m[2] === undefined ? start + 1 : line(Number(m[2]))) - 2];
}

/** The width of tracks `first` to `last` and the gaps between them. */
const spanWidth = (cols: number[], gap: number, [first, last]: [number, number]) =>
  cols.slice(first, last + 1).reduce((n, w) => n + w, 0) + gap * (last - first);

describe("doing lines and run rows (hud.css)", () => {
  it("a run's summary is its own two-line row under the ticket, opened by state alone", () => {
    const r = rule(String.raw`\.runrow button\.rsummary`);
    expect(r).toContain("grid-column: 2 / -1");
    // a native button, reset to look like text
    expect(r).toContain("border: 0");
    expect(r).toContain("background: none");
    expect(r).toContain("text-align: left");
    const text = rule(String.raw`\.runrow \.rsummary \.rtext`);
    expect(text).toContain("display: -webkit-box");
    expect(text).toContain("-webkit-line-clamp: 2");
    expect(text).toContain("line-clamp: 2");
    expect(text).toContain("overflow: hidden");
    const open = rule(String.raw`\.runrow \.rsummary\.open \.rtext`);
    expect(open).toContain("-webkit-line-clamp: unset");
    expect(open).toContain("display: block");
    // focus alone never opens it, or a second click could not close it
    expect(css).not.toMatch(/\.rsummary:focus[,\s{]/);
  });

  it("a focused summary shows a ring", () => {
    expect(rule(String.raw`\.runrow \.rsummary:focus-visible`)).toContain("outline: 2px solid");
  });

  it("a run summary button keeps the text's line height, not the global button's", () => {
    expect(rule(String.raw`\.runrow button\.rsummary`)).toContain("line-height: inherit");
  });

  it("the Overview row gives its ticket and doing column the room the others leave", () => {
    const r = rule(String.raw`\.trow`);
    expect(r).toContain("grid-template-columns: 108px 84px minmax(0, 1fr) 116px 112px 88px");
    expect(r).toContain("gap: 8px");
  });

  it("at 1440 the Overview doing line fits about 32 characters, with the loop column or without", () => {
    // The loop step column is wide enough for `build › In review` on one line, which costs the
    // ticket column 28px against the earlier 40-character goal.
    const MIN_CHARS = 32;
    const doing = rule(String.raw`\.trow \.doing`);
    const lines = Number(doing.match(/-webkit-line-clamp: (\d+)/)?.[1]);
    expect(doing).toContain(`line-clamp: ${lines}`);
    expect(doing).toContain("white-space: normal");
    expect(doing).toContain("overflow: hidden");
    const fits = (width: number) => Math.floor(width / CHAR_PX) * lines;

    const six = ticketColumn(1440, String.raw`\.trow`);
    expect(six.tracks).toHaveLength(6);
    expect(Math.round(six.width)).toBe(112);
    expect(six.cols[3]).toBeGreaterThanOrEqual(LABEL_PX);
    expect(fits(six.width)).toBeGreaterThanOrEqual(MIN_CHARS);

    // no row has a loop: the dashes' column and its gap go to the ticket column
    const five = ticketColumn(1440, String.raw`  \.noloop \.trow`);
    expect(five.tracks).toHaveLength(5);
    expect(Math.round(five.width)).toBe(212);
    expect(fits(five.width)).toBeGreaterThanOrEqual(MIN_CHARS);
    expect(rule(String.raw`  \.noloop \.trow > :nth-child\(4\)`)).toContain("display: none");
    expect(css).toContain("@media (min-width: 761px) {\n  /* With no loop");
  });

  it("from 1200 to 1439 with the dock open the row shows the ticket number, 30 characters and the loop step", () => {
    const lines = Number(rule(String.raw`\.trow \.doing`).match(/-webkit-line-clamp: (\d+)/)?.[1]);
    // the repo chip (8ch, its padding and border), a space and "#191"
    const chip = rule(String.raw`\.rchip`);
    const chipPad = Number(chip.match(/padding: 0 (\d+)px/)?.[1]);
    const NUMBER_PX = (8 + 1 + 4) * CHAR_PX + 2 * chipPad + 2 * pxOf(chip, "border");
    const dock = String.raw`  \.app:not\(\.dock-hidden\) \.trow`;
    const cell = (n: number) => rule(`${dock} > :nth-child\\(${n}\\)`);
    // the dock is a column from 1200 up; the one-line row holds from 1440
    const media = css.match(
      /@media \(min-width: 1200px\) and \(max-width: (\d+)px\) \{\n {2}\.app:not\(\.dock-hidden\) \.trow \{/,
    );
    expect(Number(media?.[1])).toBe(1439);

    // the loop, tokens and meters cells sit on the row's second line, each in its own columns
    const sets = [4, 5, 6].map((n) => {
      expect(cell(n)).toContain("grid-row: 2");
      return columnsOf(cell(n), templateOf(rule(dock)).length);
    });
    const [loop, tokens, meters] = sets as [[number, number], [number, number], [number, number]];
    expect(loop[1]).toBeLessThan(tokens[0]);
    expect(tokens[1]).toBeLessThan(meters[0]);

    for (const viewport of [1200, 1280, 1439]) {
      // the solver throws if the fixed tracks overrun the row's content box
      const t = ticketColumn(viewport, dock);
      const span = (c: [number, number]) => spanWidth(t.cols, t.gap, c);
      const ticket = span(columnsOf(cell(3), t.tracks.length));
      expect(ticket).toBeGreaterThanOrEqual(NUMBER_PX);
      expect(Math.floor(ticket / CHAR_PX) * lines).toBeGreaterThanOrEqual(30);
      expect(span(loop)).toBeGreaterThanOrEqual(LABEL_PX);
      expect(t.width).toBeGreaterThan(0);
    }
  });

  it("the loop step is one line and a 4px bar, with the mockup's colours", () => {
    expect(rule(String.raw`\.ellip`)).toContain("white-space: nowrap");
    const bar = rule(String.raw`\.stepbar`);
    expect(bar).toContain("display: flex");
    expect(bar).toContain("gap: 2px");
    expect(bar).toContain("margin: 4px 0 3px");
    const seg = rule(String.raw`\.stepbar i`);
    expect(seg).toContain("flex: 1");
    expect(seg).toContain("height: 4px");
    expect(seg).toContain("border-radius: 2px");
    expect(seg).toContain("background: var(--line-2)");
    expect(rule(String.raw`\.stepbar i\.d`)).toContain("background: var(--fg-2)");
    expect(rule(String.raw`\.stepbar i\.c`)).toContain("background: var(--ok)");
    expect(rule(String.raw`\.stepbar i\.w`)).toContain("background: var(--warn-mark)");
    expect(rule(String.raw`\.vstep\.warn \.tdot`)).toContain("border-color: var(--warn-mark)");
    // no global class can restyle the segments
    expect(css.match(/\n\.stepbar \{/g)).toHaveLength(1);
    expect(css).not.toMatch(/\n\.(d|c|w) \{/);
    for (const m of css.matchAll(/(.{0,9})i\.(d|c|w) \{/g)) {
      expect(m[1]).toMatch(/\.stepbar $/);
    }
  });

  it("the fixed tracks fit the narrowest two-column Overview", () => {
    expect(() => ticketColumn(1000, String.raw`\.trow`)).not.toThrow();
  });

  it("a repo chip on an Overview row gives way to the number only where the column is short", () => {
    expect(rule(String.raw`\.trow \.rchip`)).toContain("text-overflow: ellipsis");
    expect(rule(String.raw`\.trow \.rchip`)).not.toContain("max-width");
    const capped = css.match(
      /@media \(min-width: 761px\) and \(max-width: (\d+)px\) \{\n {2}\.trow \.rchip \{([^}]*)\}/,
    );
    expect(capped?.[2]).toContain("max-width: 8ch");
    // 1440 is capped; where the column is wide (1920) it is not
    expect(1440).toBeLessThanOrEqual(Number(capped?.[1]));
    expect(1920).toBeGreaterThan(Number(capped?.[1]));
  });

  it("the Agent header's grid track is not `auto`, so a nowrap chip cannot widen the page", () => {
    // `auto` takes the chip's min-content width; `minmax(0, 1fr)` lets the chip be cut instead
    expect(rule(String.raw`\.ahead`)).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(rule(String.raw`\.idrow \.chips`)).toContain("max-width: 100%");
    expect(rule(String.raw`\.idrow \.chips`)).toContain("min-width: 0");
    const chip = rule(String.raw`\.idrow \.chips span`);
    expect(chip).toContain("max-width: 100%");
    expect(chip).toContain("text-overflow: ellipsis");
  });

  it("nothing in a run row widens it at the narrowest width", () => {
    expect(rule(String.raw`\.runrow button\.rsummary`)).toContain("min-width: 0");
    expect(rule(String.raw`\.runrow \.rsummary \.rtext`)).toContain("overflow-wrap: anywhere");
    const title = rule(String.raw`\.runrow \.rticket > \.rtitle`);
    expect(title).toContain("min-width: 8ch");
    expect(title).toContain("text-overflow: ellipsis");
    expect(title).toContain("white-space: nowrap");
    expect(title).toContain("flex: 1 1 0");
  });

  it("a run's ticket line wraps its PR chips instead of overflowing", () => {
    const line = rule(String.raw`\.runrow \.rticket`);
    expect(line).toContain("flex-wrap: wrap");
    expect(line).toContain("grid-column: 2 / -1");
    expect(rule(String.raw`\.runrow \.rticket > \*`)).toContain("flex: none");
    const title = rule(String.raw`\.runrow \.rticket > \.rtitle`);
    expect(title).toContain("flex: 1 1 0");
    expect(title).toContain("min-width: 8ch");
  });

  it("a run row drops Started and Tokens where the side panel is too narrow for six columns", () => {
    const row = rule(String.raw`\.runrow`);
    const gap = pxOf(row, "gap", 2);
    const min = (tracks: Track[]) =>
      tracks.reduce((n, t) => n + (t.px ?? t.min), 0) + gap * (tracks.length - 1);
    expect(rule("#loopBody")).toContain("container: runs / inline-size");
    const narrow = css.match(
      /\n@container runs \(width < (\d+)px\) \{\n {2}\.runrow \{([^}]*)\}\n {2}\.runrow > :nth-child\(3\),\n {2}\.runrow > :nth-child\(5\) \{([^}]*)\}/,
    );
    // the query applies under the six columns' minimum
    expect(Number(narrow?.[1])).toBe(min(templateOf(row)));
    expect(narrow?.[3]).toContain("display: none");
    // and the four columns left fit the narrowest side panel, less its border and the body's padding
    const side = Number(rule(String.raw`\.agrid`).match(/minmax\((\d+)px, 1fr\)/)?.[1]);
    const room =
      side -
      2 * pxOf(rule(String.raw`\.panel`), "border") -
      2 * pxOf(rule(String.raw`\.pb`), "padding", 2);
    expect(min(templateOf(narrow?.[2] ?? ""))).toBeLessThanOrEqual(room);
  });

  it("a long doing line is cut or wraps in the thread, the Now tile and the header", () => {
    const thread = rule(String.raw`\.thread \.doing`);
    expect(thread).toContain("min-width: 0");
    expect(thread).toContain("text-overflow: ellipsis");
    const now = rule(String.raw`\.tile2 \.nowdoing`);
    expect(now).toContain("text-overflow: ellipsis");
    expect(now).toContain("white-space: nowrap");
    expect(rule(String.raw`\.tile2 \.d`)).toContain("min-width: 0");
    expect(rule(String.raw`\.ahead \.doing`)).toContain("overflow-wrap: anywhere");
    expect(rule(String.raw`\.ellip`)).toContain("text-overflow: ellipsis");
    expect(rule(String.raw`\.min0`)).toContain("min-width: 0");
  });

  it("a PR chip's link and pill do not wrap apart", () => {
    const rpr = rule(String.raw`\.rpr`);
    expect(rpr).toContain("display: inline-flex");
    expect(rpr).toContain("white-space: nowrap");
  });

  it("a panel-body list keeps the panel body's side padding", () => {
    expect(rule(String.raw`\.pb\.tlist`)).toMatch(/padding: \d+px 14px/);
  });

  it("a seat chip on Setup wraps inside its panel and does not clip its state pill", () => {
    const chip = rule(String.raw`\.crew button`);
    expect(chip).toContain("flex-wrap: wrap");
    expect(chip).toContain("max-width: 100%");
  });
});
