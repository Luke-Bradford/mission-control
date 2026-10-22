/**
 * Colour themes. THEME_TOKENS is the single source of the palette; hud.css mirrors it (a test
 * checks every value is there). The values are the HUD mockup's (catalogue §1.5), except where one
 * failed the contrast tests, which moved it the least that passes:
 * dark --crit #f06b68 → #f1706d (pill on surface-2); light --muted #667083 → #646e81 (on
 * surface-2), --ok #17804e → #157246 (pill), --warn #935f00 → #8d5b00 (pill on surface-2),
 * --crit #c4302d → #bb2e2b (pill on surface-2), --warn-mark #e0a21c → #c18b18 (lamp on white).
 */
import { readKey, THEME_KEY, writeKey } from "./storage.ts";

export { THEME_KEY };

/**
 * Repo chip colours, assigned to repos in config order (repoColor.ts). Kept apart from the agent
 * colours --s1…--s7 so a repo chip is never mistaken for an agent marker; a test pins both.
 */
export const REPO_TOKEN_NAMES = [
  "--r1",
  "--r2",
  "--r3",
  "--r4",
  "--r5",
  "--r6",
  "--r7",
  "--r8",
] as const;

export const TOKEN_NAMES = [
  "--bg",
  "--surface",
  "--surface-2",
  "--line",
  "--line-2",
  "--fg",
  "--fg-2",
  "--muted",
  "--accent",
  "--accent-ink",
  "--ok",
  "--warn",
  "--warn-mark",
  "--crit",
  "--think",
  "--scrim",
  "--ok-soft",
  "--warn-soft",
  "--crit-soft",
  "--accent-soft",
  "--shadow",
  "--glow",
  "--s1",
  "--s2",
  "--s3",
  "--s4",
  "--s5",
  "--s6",
  "--s7",
  ...REPO_TOKEN_NAMES,
] as const;
export type TokenName = (typeof TOKEN_NAMES)[number];

export const THEME_TOKENS: Record<"dark" | "light", Record<TokenName, string>> = {
  dark: {
    "--bg": "#0e1116",
    "--surface": "#151a21",
    "--surface-2": "#1c222b",
    "--line": "#252c37",
    "--line-2": "#354050",
    "--fg": "#e7eaef",
    "--fg-2": "#aab2bf",
    "--muted": "#808999",
    "--accent": "#8db0ff",
    "--accent-ink": "#0b1020",
    "--ok": "#45c486",
    "--warn": "#f2b53a",
    "--warn-mark": "#f2b53a",
    "--crit": "#f1706d",
    "--think": "#b8a8f7",
    "--scrim": "rgba(5, 8, 12, 0.6)",
    "--ok-soft": "rgba(69, 196, 134, 0.16)",
    "--warn-soft": "rgba(242, 181, 58, 0.15)",
    "--crit-soft": "rgba(240, 107, 104, 0.15)",
    "--accent-soft": "rgba(141, 176, 255, 0.14)",
    "--shadow": "0 10px 30px rgba(0, 0, 0, 0.45)",
    "--glow":
      "radial-gradient(1200px 300px at 20% -120px, rgba(141, 176, 255, 0.08), transparent 70%)",
    "--s1": "#3987e5",
    "--s2": "#d95926",
    "--s3": "#199e70",
    "--s4": "#c98500",
    "--s5": "#d55181",
    "--s6": "#008300",
    "--s7": "#9085e9",
    "--r1": "#3fd0e8",
    "--r2": "#e6dc6e",
    "--r3": "#f5b5d0",
    "--r4": "#d55eed",
    "--r5": "#b5e04a",
    "--r6": "#f5c6a0",
    "--r7": "#a8f0d0",
    "--r8": "#9cc8f5",
  },
  light: {
    "--bg": "#f3f5f8",
    "--surface": "#ffffff",
    "--surface-2": "#eef1f5",
    "--line": "#dfe3ea",
    "--line-2": "#c6cdd8",
    "--fg": "#121720",
    "--fg-2": "#4a5465",
    "--muted": "#646e81",
    "--accent": "#2456d3",
    "--accent-ink": "#ffffff",
    "--ok": "#157246",
    "--warn": "#8d5b00",
    "--warn-mark": "#c18b18",
    "--crit": "#bb2e2b",
    "--think": "#5b47c4",
    "--scrim": "rgba(20, 28, 40, 0.35)",
    "--ok-soft": "rgba(23, 128, 78, 0.12)",
    "--warn-soft": "rgba(224, 162, 28, 0.18)",
    "--crit-soft": "rgba(196, 48, 45, 0.1)",
    "--accent-soft": "rgba(36, 86, 211, 0.1)",
    "--shadow": "0 10px 28px rgba(20, 30, 50, 0.16)",
    "--glow":
      "radial-gradient(1200px 300px at 20% -120px, rgba(36, 86, 211, 0.06), transparent 70%)",
    "--s1": "#2a78d6",
    "--s2": "#eb6834",
    "--s3": "#1baf7a",
    "--s4": "#eda100",
    "--s5": "#e87ba4",
    "--s6": "#008300",
    "--s7": "#6250d6",
    "--r1": "#0e6a8a",
    "--r2": "#586018",
    "--r3": "#a2308f",
    "--r4": "#6b5b4b",
    "--r5": "#753857",
    "--r6": "#7c2d12",
    "--r7": "#115e59",
    "--r8": "#9f1239",
  },
};

export type ThemeChoice = "system" | "light" | "dark";
export const THEME_CHOICES: readonly ThemeChoice[] = ["system", "light", "dark"];

function isChoice(v: unknown): v is ThemeChoice {
  return THEME_CHOICES.includes(v as ThemeChoice);
}

/** The remembered choice; "system" when none is stored or storage is unavailable. */
export function getTheme(): ThemeChoice {
  const v = readKey(THEME_KEY);
  return isChoice(v) ? v : "system";
}

/** The choice after `c` in the header button's cycle: system → light → dark → system. */
export const nextTheme = (c: ThemeChoice): ThemeChoice =>
  THEME_CHOICES[(THEME_CHOICES.indexOf(c) + 1) % THEME_CHOICES.length] ?? "system";

const listeners = new Set<(c: ThemeChoice) => void>();

/** The choice this page last showed; null until one is applied (then the stored choice stands). */
let current: ThemeChoice | null = null;

/** The choice shown on this page: kept in memory, so it holds when storage is blocked. */
export const currentTheme = (): ThemeChoice => current ?? getTheme();

/** Forget the shown choice (tests; the page itself never does). */
export function resetTheme(): void {
  current = null;
}

/** Hear every theme change made through setTheme. */
export function subscribeTheme(fn: (c: ThemeChoice) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * The browser's bar colour follows the page (--bg). index.html has one `theme-color` meta per
 * system theme (its media query); a pinned choice sets both to that theme, "system" restores each.
 */
export function applyThemeColor(c: ThemeChoice): void {
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const own = m.getAttribute("media")?.includes("light") ? "light" : "dark";
    m.content = THEME_TOKENS[c === "system" ? own : c]["--bg"];
  }
}

/** Show a choice on this page and tell the listeners; storage is the caller's business. */
function applyChoice(c: ThemeChoice): void {
  current = c;
  const root = document.documentElement;
  if (c === "system") delete root.dataset.theme;
  else root.dataset.theme = c;
  applyThemeColor(c);
  for (const fn of listeners) fn(c);
}

/** Apply a choice now and remember it for this browser (best effort: storage may be blocked). */
export function setTheme(c: ThemeChoice): void {
  writeKey(THEME_KEY, c);
  applyChoice(c);
}

// Another tab's choice arrives as a storage event (it never fires in the tab that wrote). A cleared
// or unknown value is the system theme, as getTheme reads it; a null key is localStorage.clear().
// Only localStorage is handled (no storageArea check): nothing writes mc-theme to sessionStorage.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === THEME_KEY || e.key === null) {
      applyChoice(isChoice(e.newValue) ? e.newValue : "system");
    }
  });
}
