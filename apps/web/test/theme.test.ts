import { readFileSync } from "node:fs";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PHONE_QUERY } from "../src/board/phone.ts";
import {
  applyThemeColor,
  currentTheme,
  getTheme,
  REPO_TOKEN_NAMES,
  setTheme,
  subscribeTheme,
  THEME_KEY,
  THEME_TOKENS,
  TOKEN_NAMES,
  type TokenName,
} from "../src/theme.ts";
import { readStyle, readStyles } from "./styles.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

/** WCAG 2.x relative luminance of a `#rrggbb` colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.039_28 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `rgba(r, g, b, a)` painted over the opaque `#rrggbb` beneath it. */
function over(rgba: string, hex: string): string {
  const m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(rgba);
  if (!m) throw new Error(`not an rgba(): ${rgba}`);
  const a = Number(m[4]);
  const top = [m[1], m[2], m[3]].map(Number);
  return `#${[1, 3, 5]
    .map((i, k) => {
      const v = (top[k] as number) * a + Number.parseInt(hex.slice(i, i + 2), 16) * (1 - a);
      return Math.round(v).toString(16).padStart(2, "0");
    })
    .join("")}`;
}

const THEMES = ["dark", "light"] as const;
const TEXT: readonly TokenName[] = ["--fg", "--fg-2", "--muted"];
const SURFACES: readonly TokenName[] = ["--bg", "--surface", "--surface-2"];
const PILLS: readonly [TokenName, TokenName][] = [
  ["--ok", "--ok-soft"],
  ["--warn", "--warn-soft"],
  ["--crit", "--crit-soft"],
  ["--accent", "--accent-soft"],
];
const LAMPS: readonly TokenName[] = ["--warn-mark", "--ok", "--crit"];

/** Seat tokens are defined in hud.css so additions to the visual-system palette cannot evade checks. */
function seatTokens(): TokenName[] {
  return [
    ...new Set(
      [...read("../src/hud.css").matchAll(/^\s*(--seat-\d+):/gm)].map((match) => match[1] ?? ""),
    ),
  ] as TokenName[];
}

/** The text from the line `header` opens to the `}` that closes it (no nested braces inside). */
function blockBody(css: string, header: string): string {
  const start = `\n${css}`.indexOf(`\n${header}`);
  if (start < 0) throw new Error(`no block: ${header}`);
  return css.slice(start, css.indexOf("}", start));
}

/** Every token of the `name` palette, with its value, is declared in `body`. */
function expectPalette(body: string, name: "dark" | "light"): void {
  for (const token of TOKEN_NAMES) {
    expect(body, `${name} ${token}`).toContain(`${token}: ${THEME_TOKENS[name][token]};`);
  }
}

/**
 * The value of `prop` in the `selector { … }` rules of hud.css (Biome-formatted): the last
 * top-level declaration of exactly that property. `background-color` is not `color`, and a later
 * rule for the same selector wins over an earlier one.
 */
function ruleValue(css: string, selector: string, prop: string): string | undefined {
  const sel = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let value: string | undefined;
  for (const rule of `\n${css}`.matchAll(new RegExp(`\\n${sel} \\{([^}]*)\\}`, "g"))) {
    for (const decl of (rule[1] ?? "").split(";")) {
      const at = decl.indexOf(":");
      if (at >= 0 && decl.slice(0, at).trim() === prop) value = decl.slice(at + 1).trim();
    }
  }
  return value;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
});

describe("theme tokens", () => {
  it.each(THEMES)("text meets AA on every surface: %s", (name) => {
    const t = THEME_TOKENS[name];
    for (const fg of TEXT) {
      for (const bg of SURFACES) {
        expect(contrast(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it.each(THEMES)("pill text meets AA on its soft background over each surface: %s", (name) => {
    const t = THEME_TOKENS[name];
    for (const [fg, soft] of PILLS) {
      for (const bg of ["--surface", "--surface-2"] as const) {
        const behind = over(t[soft], t[bg]);
        expect(contrast(t[fg], behind), `${fg} pill over ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it.each(THEMES)("lamps stand out from a panel (3:1): %s", (name) => {
    const t = THEME_TOKENS[name];
    for (const lamp of LAMPS) {
      expect(contrast(t[lamp], t["--surface"]), `${lamp} on --surface`).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(THEMES)("seat swatches meet non-text contrast on a panel: %s", (name) => {
    const t = THEME_TOKENS[name];
    const seats = seatTokens();
    expect(seats).toEqual(TOKEN_NAMES.filter((token) => /^--seat-\d+$/.test(token)));
    for (const seat of seats) {
      expect(contrast(t[seat], t["--surface"]), `${seat} on --surface`).toBeGreaterThanOrEqual(3);
    }
  });

  it("dark warn-mark is warn, as in the mockup", () => {
    expect(THEME_TOKENS.dark["--warn-mark"]).toBe(THEME_TOKENS.dark["--warn"]);
  });

  it("keeps the mockup's values where they pass", () => {
    expect(THEME_TOKENS.dark).toMatchObject({
      "--bg": "#070a0e",
      "--fg": "#e7eaef",
    });
    expect(THEME_TOKENS.light).toMatchObject({ "--bg": "#f3f5f8", "--surface": "#ffffff" });
  });

  it.each(THEMES)(
    "colours the YAML view and glossary code with tokens that pass AA: %s",
    (name) => {
      const css = readStyles();
      const t = THEME_TOKENS[name];
      const token = (v: string | undefined) =>
        /^var\((--[\w-]+)\)$/.exec(v ?? "")?.[1] as TokenName;
      const code = token(ruleValue(css, ".yaml", "background"));
      const gloss = token(ruleValue(css, ".gloss code", "background"));
      expect(code).toBe("--bg");
      expect(gloss).toBe("--surface-2");
      const cases: [string, TokenName, TokenName][] = [
        [".yk", "--accent", code],
        [".yv", "--fg", code],
        [".yc", "--muted", code],
        [".yaml .yln", "--muted", code],
        [".gloss code", "--fg", gloss],
      ];
      for (const [selector, fg, bg] of cases) {
        expect(ruleValue(css, selector, "color"), selector).toBe(`var(${fg})`);
        expect(contrast(t[fg], t[bg]), `${selector} on its background`).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  // Ruling R22: a disabled primary button (composer Send) must not read as the blue call to action.
  it.each(THEMES)(
    "a disabled primary button takes the disabled look, legible at 3:1 when faded: %s",
    (name) => {
      const css = read("../src/hud.css");
      const t = THEME_TOKENS[name];
      const token = (prop: string) =>
        /^var\((--[\w-]+)\)$/.exec(ruleValue(css, "button.primary:disabled", prop) ?? "")?.[1] as
          | TokenName
          | undefined;
      expect(token("background")).toBe("--surface-2");
      expect(token("border-color")).toBe("--line-2");
      expect(token("color")).toBe("--fg");
      const opacity = Number(ruleValue(css, "button:disabled", "opacity"));
      expect(opacity).toBe(0.6);
      // WCAG 1.4.3 exempts inactive controls; the faded label still reads at the UI-component 3:1.
      const rgba = (hex: string) =>
        `rgba(${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(", ")}, ${opacity})`;
      for (const under of SURFACES) {
        const fg = over(rgba(t["--fg"]), t[under]);
        const bg = over(rgba(t["--surface-2"]), t[under]);
        expect(contrast(fg, bg), `disabled primary over ${under}`).toBeGreaterThanOrEqual(3);
        expect(bg, `not accent over ${under}`).not.toBe(over(rgba(t["--accent"]), t[under]));
      }
    },
  );

  // hud.css writes each palette twice (dark: :root and the pinned block; light: the system-light
  // media block and the pinned block); every copy must carry every value.
  it.each([
    ["dark", ":root {"],
    ["dark", ':root[data-theme="dark"] {'],
    ["light", '  :root:not([data-theme="dark"]) {'],
    ["light", ':root[data-theme="light"] {'],
  ] as const)("hud.css %s block %s carries every token value", (name, header) => {
    expectPalette(blockBody(read("../src/hud.css"), header), name);
  });

  it("a block that has drifted fails the per-block check", () => {
    const real = read("../src/hud.css");
    const dark = THEME_TOKENS.dark["--bg"];
    // the pinned dark block alone drifts; the :root copy still holds the right value
    const drifted = real.replace(
      new RegExp(`(:root\\[data-theme="dark"\\] \\{[^}]*--bg: )${dark}`),
      "$1#000000",
    );
    expect(drifted).not.toBe(real);
    expect(() => expectPalette(blockBody(drifted, ':root[data-theme="dark"] {'), "dark")).toThrow();
    expect(() => expectPalette(blockBody(drifted, ":root {"), "dark")).not.toThrow();
  });

  it("the pre-paint script reads the same storage key", () => {
    expect(THEME_KEY).toBe("mc-theme");
    expect(read("../public/theme-init.js")).toContain(`"${THEME_KEY}"`);
    expect(read("../index.html")).toContain('<script src="/theme-init.js"></script>');
  });
});

describe("shell styles", () => {
  it("keeps type scale tokens at or above the 11px floor", () => {
    const hud = read("../src/hud.css");
    for (const token of ["--fs", "--fs-s", "--fs-micro"]) {
      const value = Number(hud.match(new RegExp(`${token}: (\\d+(?:\\.\\d+)?)px`))?.[1]);
      expect(value, token).toBeGreaterThanOrEqual(11);
    }
  });

  it("keeps literal UI text at or above the 11px floor", () => {
    const css = readStyles();
    const sizes = [...css.matchAll(/font(?:-size)?:\s*(?:\d+(?:\.\d+)?\s+)?(\d+(?:\.\d+)?)px\b/g)]
      .map((match) => Number(match[1]))
      .filter((size) => size < 11);

    expect(sizes).toEqual([]);
  });

  // The header's usage meter is on every page, so its rules live in hud.css, not in a page's own
  // stylesheet (#839's split once moved them into ConfigYaml.css, which only Setup loads).
  it("styles the header usage meter from hud.css", () => {
    const css = read("../src/hud.css");
    expect(ruleValue(css, ".usage", "font")).toBe("var(--fs-micro) / var(--lh-micro) var(--mono)");
    expect(ruleValue(css, ".usage", "color")).toBe("var(--fg-2)");
    expect(ruleValue(css, ".usage b", "font-weight")).toBe("500");
  });
});

describe("ruleValue", () => {
  it("reads `color`, not `background-color` or `border-color`, whatever order they come in", () => {
    const css = "\n.a {\n  background-color: red;\n  border-color: green;\n  color: blue;\n}\n";
    expect(ruleValue(css, ".a", "color")).toBe("blue");
    expect(ruleValue(css, ".a", "background-color")).toBe("red");
  });

  it("reads minified declarations, where `color` follows `;` with no space", () => {
    expect(ruleValue("\n.a {background-color:red;color:blue}\n", ".a", "color")).toBe("blue");
  });

  it("takes the last declaration over every top-level rule for the selector", () => {
    const css = "\n.a {\n  color: red;\n}\n.b {\n  color: green;\n}\n.a {\n  color: blue;\n}\n";
    expect(ruleValue(css, ".a", "color")).toBe("blue");
    expect(ruleValue("\n.a {\n  margin: 0;\n}\n.a {\n  color: blue;\n}\n", ".a", "color")).toBe(
      "blue",
    );
  });

  it("takes the last `color` when one block declares it twice", () => {
    const css = "\n.a {\n  color: red;\n  margin: 0;\n  color: var(--muted);\n}\n";
    expect(ruleValue(css, ".a", "color")).toBe("var(--muted)");
    expect(ruleValue("\n.a {color:red;color:blue}\n", ".a", "color")).toBe("blue");
  });

  it("is undefined when the selector has no such property", () => {
    expect(ruleValue("\n.a {\n  background-color: red;\n}\n", ".a", "color")).toBeUndefined();
  });
});

describe("hud.css state rules", () => {
  const css = () => readStyles();
  /** The body of the `@media (prefers-reduced-motion: reduce)` block that holds the lamps' rings. */
  const reduced = () =>
    /@media \(prefers-reduced-motion: reduce\) \{\n([\s\S]*?)\n\}/.exec(
      readStyle("hud/Lamp.css"),
    )?.[1] ?? "";

  it.each([
    ["warn", "--warn-soft"],
    ["ok", "--ok-soft"],
    ["crit", "--crit-soft"],
  ])("reduced motion turns a pulsing %s lamp into a still ring of its own colour", (kind, soft) => {
    const sel = kind === "warn" ? ".lamp.pulse" : `.lamp.${kind}.pulse`;
    const rule = new RegExp(
      `\\n  ${sel.replace(/\./g, "\\.")} \\{\\n    box-shadow: ([^;]+);`,
    ).exec(`\n${reduced()}`);
    expect(rule?.[1], sel).toBe(`0 0 0 3px var(${soft})`);
  });

  it("the board card's title link covers the card and its GitHub refs sit above the cover", () => {
    expect(ruleValue(css(), ".kcard", "position")).toBe("relative");
    expect(ruleValue(css(), ".kcard .ktitle::after", "position")).toBe("absolute");
    expect(ruleValue(css(), ".kcard .ktitle::after", "inset")).toBe("0");
    // every link in a card but the title is in a .rref (BoardPage.test pins that)
    expect(ruleValue(css(), ".kcard .rref a", "position")).toBe("relative");
    expect(ruleValue(css(), ".kcard .rref a", "z-index")).toBe("1");
  });

  /** The body of the `@media (max-width: …)` block with that width, to its closing `}` at column 0. */
  const maxWidthBlock = (px: string) =>
    new RegExp(`@media \\(max-width: ${px}\\) \\{\\n([\\s\\S]*?)\\n\\}`).exec(
      readStyle("board/board.css"),
    )?.[1] ?? "";

  it("the phone block of board.css is the width PHONE_QUERY names", () => {
    const px = /^\(max-width: (\d+px)\)$/.exec(PHONE_QUERY)?.[1];
    expect(px, "PHONE_QUERY is a single max-width").toBeDefined();
    expect(maxWidthBlock(px as string)).toContain(".kcol .kh > button");
  });

  it("at phone width a per-repo lane drops its fixed height, so an open column cannot spill", () => {
    const px = /^\(max-width: (\d+px)\)$/.exec(PHONE_QUERY)?.[1] as string;
    const phone = maxWidthBlock(px);
    expect(phone).toMatch(/\n {2}\.repokanban \.kanban \{[^}]*height: auto;/);
    // the rule it overrides, at the same specificity, which is why the phone one must repeat it
    expect(ruleValue(css(), ".repokanban .kanban", "height")).toBe("360px");
  });

  it("an acknowledged Needs-you row fades to 60 %", () => {
    expect(ruleValue(css(), ".nrow.acked", "opacity")).toBe("0.6");
  });

  it("the empty toast is hidden visually, not from screen readers", () => {
    expect(ruleValue(css(), "#toast:empty", "clip-path")).toBe("inset(50%)");
    expect(ruleValue(css(), "#toast:empty", "display")).toBeUndefined();
    expect(ruleValue(css(), "#toast:empty", "visibility")).toBeUndefined();
  });
});

describe("theme-color", () => {
  /** The two media-scoped metas index.html carries, as the page head has them. */
  function metas(): HTMLMetaElement[] {
    const html = read("../index.html");
    document.head.innerHTML = [...html.matchAll(/<meta name="theme-color"[^>]*>/g)]
      .map((m) => m[0])
      .join("");
    return [...document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
  }
  const colours = (ms: HTMLMetaElement[]) => ms.map((m) => [m.getAttribute("media"), m.content]);
  const light = "(prefers-color-scheme: light)";
  const dark = "(prefers-color-scheme: dark)";

  afterEach(() => {
    document.head.innerHTML = "";
  });

  it("index.html gives each system theme its own header colour", () => {
    expect(colours(metas())).toEqual([
      [light, THEME_TOKENS.light["--bg"]],
      [dark, THEME_TOKENS.dark["--bg"]],
    ]);
  });

  it("follows a pinned theme, and the system again after", () => {
    const ms = metas();
    applyThemeColor("light");
    expect(colours(ms)).toEqual([
      [light, THEME_TOKENS.light["--bg"]],
      [dark, THEME_TOKENS.light["--bg"]],
    ]);
    setTheme("dark");
    expect(colours(ms)).toEqual([
      [light, THEME_TOKENS.dark["--bg"]],
      [dark, THEME_TOKENS.dark["--bg"]],
    ]);
    setTheme("system");
    expect(colours(ms)).toEqual([
      [light, THEME_TOKENS.light["--bg"]],
      [dark, THEME_TOKENS.dark["--bg"]],
    ]);
  });
});

describe("setTheme / getTheme", () => {
  it("setTheme writes storage and the data attribute; system removes it; storage failure is tolerated", () => {
    const root = document.documentElement;
    expect(getTheme()).toBe("system");

    setTheme("light");
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
    expect(root.dataset.theme).toBe("light");
    expect(getTheme()).toBe("light");

    setTheme("dark");
    expect(root.dataset.theme).toBe("dark");
    expect(getTheme()).toBe("dark");

    setTheme("system");
    expect(root.dataset.theme).toBeUndefined();
    expect(getTheme()).toBe("system");

    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => setTheme("light")).not.toThrow();
    expect(root.dataset.theme).toBe("light");
    expect(getTheme()).toBe("system");
  });

  it("currentTheme is the choice shown on this page, even when storage is blocked", () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    setTheme("dark");
    expect(currentTheme()).toBe("dark");
    setTheme("system");
    expect(currentTheme()).toBe("system");
  });

  it("tells subscribers about each change until they unsubscribe", () => {
    const seen: string[] = [];
    const off = subscribeTheme((c) => seen.push(c));
    setTheme("dark");
    setTheme("system");
    off();
    setTheme("light");
    expect(seen).toEqual(["dark", "system"]);
  });

  describe("another tab changes the theme", () => {
    const fromOtherTab = (newValue: string | null, key: string | null = THEME_KEY) =>
      act(() => {
        window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
      });

    it("applies it here and tells subscribers", () => {
      const seen: string[] = [];
      const off = subscribeTheme((c) => seen.push(c));
      fromOtherTab("dark");
      expect(document.documentElement.dataset.theme).toBe("dark");
      fromOtherTab("light");
      expect(document.documentElement.dataset.theme).toBe("light");
      fromOtherTab("system");
      expect(document.documentElement.dataset.theme).toBeUndefined();
      expect(seen).toEqual(["dark", "light", "system"]);
      off();
    });

    it("treats a cleared or unknown value as the system theme", () => {
      setTheme("dark");
      fromOtherTab(null);
      expect(document.documentElement.dataset.theme).toBeUndefined();
      setTheme("dark");
      fromOtherTab("sepia");
      expect(document.documentElement.dataset.theme).toBeUndefined();
    });

    it("treats localStorage.clear() in the other tab (a null key) as the system theme", () => {
      setTheme("dark");
      fromOtherTab(null, null);
      expect(document.documentElement.dataset.theme).toBeUndefined();
    });

    it("ignores other keys", () => {
      setTheme("dark");
      fromOtherTab("light", "mc-dock");
      expect(document.documentElement.dataset.theme).toBe("dark");
    });

    it("does not write storage back (that would echo between tabs)", () => {
      const set = vi.spyOn(localStorage, "setItem");
      fromOtherTab("dark");
      expect(set).not.toHaveBeenCalled();
    });
  });

  it("ignores an unknown stored value", () => {
    localStorage.setItem(THEME_KEY, "sepia");
    expect(getTheme()).toBe("system");
  });
});

describe("repo palette", () => {
  const AGENTS = seatTokens();
  /** CIE76 ΔE between two `#rrggbb` colours (sRGB, D65): ~2 is a just-noticeable difference. */
  function deltaE(a: string, b: string): number {
    const lab = (hex: string): [number, number, number] => {
      const lin = [1, 3, 5].map((i) => {
        const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      const [r, g, bl] = lin;
      const xyz = [
        (0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.9505,
        0.2126 * r + 0.7152 * g + 0.0722 * bl,
        (0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.089,
      ].map((v) => (v > 0.008_856 ? Math.cbrt(v) : 7.787 * v + 16 / 116)) as [
        number,
        number,
        number,
      ];
      return [116 * xyz[1] - 16, 500 * (xyz[0] - xyz[1]), 200 * (xyz[1] - xyz[2])];
    };
    const [l1, a1, b1] = lab(a);
    const [l2, a2, b2] = lab(b);
    return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
  }
  /** A repo colour must read as a different colour from an agent's, and from another repo's. */
  const MIN_VS_AGENT = 35;
  const MIN_VS_REPO = 20;
  /** ...and from the two text colours, or a chip reads as body text. */
  const MIN_VS_TEXT = 25;
  /** ...and from the state colours, or a chip reads as a status. */
  const MIN_VS_STATE = 20;
  const STATES: readonly TokenName[] = ["--crit", "--warn", "--ok"];

  it("has eight colours", () => {
    expect(REPO_TOKEN_NAMES).toEqual([
      "--r1",
      "--r2",
      "--r3",
      "--r4",
      "--r5",
      "--r6",
      "--r7",
      "--r8",
    ]);
  });

  it.each(THEMES)("repo chip text meets AA on every surface: %s", (name) => {
    const t = THEME_TOKENS[name];
    for (const fg of REPO_TOKEN_NAMES) {
      for (const bg of SURFACES) {
        expect(contrast(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it.each(THEMES)(`no repo colour is within ΔE ${MIN_VS_AGENT} of an agent colour: %s`, (name) => {
    const t = THEME_TOKENS[name];
    const near: string[] = [];
    for (const repo of REPO_TOKEN_NAMES) {
      for (const agent of AGENTS) {
        const d = deltaE(t[repo], t[agent]);
        if (d < MIN_VS_AGENT) near.push(`${repo} vs ${agent}: ${d.toFixed(1)}`);
      }
    }
    expect(near).toEqual([]);
  });

  it.each(THEMES)(`repo colours are at least ΔE ${MIN_VS_REPO} apart: %s`, (name) => {
    const t = THEME_TOKENS[name];
    const near: string[] = [];
    REPO_TOKEN_NAMES.forEach((a, i) => {
      for (const b of REPO_TOKEN_NAMES.slice(i + 1)) {
        const d = deltaE(t[a], t[b]);
        if (d < MIN_VS_REPO) near.push(`${a} vs ${b}: ${d.toFixed(1)}`);
      }
    });
    expect(near).toEqual([]);
  });

  it.each(THEMES)(`no repo colour reads as body text (ΔE ${MIN_VS_TEXT} from --fg): %s`, (name) => {
    const t = THEME_TOKENS[name];
    const near: string[] = [];
    for (const repo of REPO_TOKEN_NAMES) {
      const d = deltaE(t[repo], t["--fg"]);
      if (d < MIN_VS_TEXT) near.push(`${repo} vs --fg: ${d.toFixed(1)}`);
    }
    expect(near).toEqual([]);
  });

  it.each(THEMES)(`no repo colour is within ΔE ${MIN_VS_STATE} of a state colour: %s`, (name) => {
    const t = THEME_TOKENS[name];
    const near: string[] = [];
    for (const repo of REPO_TOKEN_NAMES) {
      for (const state of STATES) {
        const d = deltaE(t[repo], t[state]);
        if (d < MIN_VS_STATE) near.push(`${repo} vs ${state}: ${d.toFixed(1)}`);
      }
    }
    expect(near).toEqual([]);
  });

  it("measures ΔE on known colours", () => {
    expect(deltaE("#ffffff", "#ffffff")).toBe(0);
    expect(deltaE("#000000", "#ffffff")).toBeCloseTo(100, 0);
  });
});
