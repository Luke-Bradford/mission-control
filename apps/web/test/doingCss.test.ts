import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "../src/hud.css"), "utf8");
const rule = (sel: string) => css.match(new RegExp(`\\n${sel} \\{([^}]*)\\}`))?.[1] ?? "";

interface Track {
  px: number | null;
  fr: number;
  min: number;
}

const parseTrack = (track: string): Track => {
  const t = track.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")");
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
  const [agents] = viewport <= 1600 ? [main] : solve(templateOf(ov), main ?? 0, gapOf(ov));
  const panel = (agents ?? 0) - 2 * pxOf(rule(String.raw`\.panel`), "border");
  const row = rule(String.raw`\.trow`);
  const tracks = templateOf(rule(selector));
  const cols = solve(tracks, panel - 2 * pxOf(row, "padding", 2), gapOf(row));
  return {
    tracks,
    cols,
    gap: gapOf(row),
    width: cols[2] ?? 0,
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

describe("doing lines and run rows (hud.css)", () => {
  it("Work in flight stretches the agent link across the row, below ticket and PR links", () => {
    const row = rule(String.raw`#wifP \.row`);
    expect(row).toContain("position: relative");
    expect(row).toContain("cursor: pointer");
    expect(rule(String.raw`#wifP \.row:hover`)).toContain("background: var(--surface-2)");
    const stretched = rule(String.raw`#wifP \.agent-link::after`);
    expect(stretched).toContain('content: ""');
    expect(stretched).toContain("position: absolute");
    expect(stretched).toContain("inset: 0");
    const refs = rule(String.raw`#wifP \.row \.rref a`);
    expect(refs).toContain("position: relative");
    expect(refs).toContain("z-index: 1");
    expect(rule(String.raw`\.row`)).not.toContain("cursor: pointer");
    expect(rule(String.raw`\.row:hover`)).not.toContain("background:");
  });

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

  it("keeps the ticket on line one and spans doing across the middle columns", () => {
    expect(rule("#agentsList")).toContain("container: agents / inline-size");
    expect(rule(String.raw`#agentsList \.trow > \*`)).toContain("grid-row: 1");
    const cell = rule(String.raw`#agentsList \.trow > \.need`);
    expect(cell).toContain("grid-row: 2");
    expect(columnsOf(cell, 9)).toEqual([1, 8]);
  });

  it("lets the desktop table shrink without a fixed minimum width", () => {
    expect(rule("#agentsList")).toContain("overflow: visible");
    expect(rule(String.raw`#agentsList \.trow`)).toContain("min-width: 0");
    expect(templateOf(rule(String.raw`#agentsList \.trow`))).toHaveLength(9);
    expect(templateOf(rule(String.raw`#agentsList\.no-steps \.trow`))).toHaveLength(8);
  });

  it.each([1100, 1199, 1200, 1280, 1359, 1360, 1440, 1800, 2000])(
    "fits both Agents grids with FLIGHT open at %ipx",
    (viewport) => {
      const app = rule(String.raw`\.app`);
      const inner = viewport - pxOf(app, "padding-left") - pxOf(app, "padding-right");
      const shell = rule(String.raw`\.shell`);
      const main =
        viewport < 1200 ? inner : (solve(templateOf(shell), inner, gapOf(shell))[0] ?? 0);
      // Reserve space for a classic scrollbar as well as the panel borders.
      const panel = main - 16 - 2 * pxOf(rule(String.raw`\.panel`), "border");
      const compact = css.slice(
        css.indexOf("@container agents (width < 1360px)"),
        css.indexOf(".activity-live {"),
      );
      for (const selector of [
        String.raw`#agentsList \.trow`,
        String.raw`#agentsList\.no-steps \.trow`,
      ]) {
        const grid =
          panel < 1360
            ? (compact.match(new RegExp(`${selector} \\{([^}]*)\\}`))?.[1] ?? "")
            : rule(selector);
        const tracks = templateOf(grid);
        const gap = panel < 1360 ? 6 : 8;
        const available = panel - 2 * pxOf(rule(String.raw`\.trow`), "padding", 2);
        const widths = solve(tracks, available, gap);
        expect(widths[3]).toBeGreaterThan(0);
        expect(widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1)).toBeLessThanOrEqual(
          available + 0.01,
        );
        expect(widths.slice(-2)).toEqual([60, 60]);
      }
    },
  );

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

  it("the fixed tracks fit a 1000px Overview with the dock as a drawer", () => {
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
