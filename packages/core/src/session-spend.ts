/** USD per million tokens of each kind. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

/** Token counts of the same five kinds. */
export type SpendTokens = ModelPrice;

const price = (input: number, output: number, cacheRead = input * 0.1): ModelPrice => ({
  input,
  output,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
  cacheRead,
});

/**
 * API list prices as of 3 November 2026, by model id prefix (the longest match wins). A 5-minute
 * cache write costs 1.25x input, a 1-hour write 2x input, and a cache read 0.1x input unless the
 * model has its own figure. The only price table: transcripts carry token counts, not cost.
 */
export const MODEL_PRICES: readonly { prefix: string; price: ModelPrice }[] = [
  { prefix: "claude-fable-5-2", price: price(8, 40, 0.2) },
  { prefix: "claude-fable-5-1", price: price(10, 50) },
  { prefix: "claude-fable-5", price: price(10, 50) },
  { prefix: "claude-opus-5-5", price: price(4, 20, 0.2) },
  { prefix: "claude-opus-5", price: price(5, 25) },
  { prefix: "claude-opus-4-8", price: price(5, 25) },
  { prefix: "claude-sonnet-5-5", price: price(2, 10, 0.1) },
  { prefix: "claude-sonnet-5", price: price(2, 10) },
  { prefix: "claude-haiku-5-5", price: price(0.1, 0.5) },
];

/** A message sent with `usage.speed: "fast"` costs this many times the list price. */
export const FAST_PRICE_MULTIPLIER = 2;

/** The price of `model` by its longest matching prefix, or null when it has none. */
export function priceFor(model: string): ModelPrice | null {
  let best: { prefix: string; price: ModelPrice } | null = null;
  for (const p of MODEL_PRICES)
    if (model.startsWith(p.prefix) && (best === null || p.prefix.length > best.prefix.length))
      best = p;
  return best?.price ?? null;
}

/** USD for `t` tokens of `model`; null when the model has no price. */
export function tokensCostUsd(model: string, t: SpendTokens, fast = false): number | null {
  const p = priceFor(model);
  if (p === null) return null;
  const usd =
    (t.input * p.input +
      t.output * p.output +
      t.cacheWrite5m * p.cacheWrite5m +
      t.cacheWrite1h * p.cacheWrite1h +
      t.cacheRead * p.cacheRead) /
    1_000_000;
  return fast ? usd * FAST_PRICE_MULTIPLIER : usd;
}

/** Tokens are input plus output, as on the Tokens tile; cost is the ~USD API-equivalent. */
export interface SpendCell {
  tokens: number;
  costUsd: number;
}

/** One session's spend: local midnight to now, and the last 7 local days, today included. */
export interface SessionSpendCell {
  today: SpendCell;
  week: SpendCell;
  /** Some of the session's tokens came from a model without a price. */
  unpriced: boolean;
}

/** One local day and repo of the split; operator + crew + flight equals total. */
export interface SessionSpendRow {
  /** Local YYYY-MM-DD. */
  day: string;
  /** Null when the session's folder is in no repo (shown as —). */
  repo: string | null;
  operator: SpendCell;
  crew: SpendCell;
  flight: SpendCell;
  total: SpendCell;
}

/** Every Claude session on this Mac over the last 7 local days, by owner, day and repo. */
export interface SessionSpendSplit {
  /** Newest day first, then the biggest total first. */
  rows: SessionSpendRow[];
  /** The account total: the sum of the rows. */
  total: SpendCell;
  /** Tokens from models without a price, counted in tokens but not cost. */
  unpricedTokens: number;
  /** When the transcripts were last read; null before the first pass. */
  readAt: number | null;
}

/** How often the hub reads new transcript lines. */
export const SESSION_SPEND_INTERVAL_MS = 30_000;
/** Days the per-session numbers are kept. */
export const SESSION_SPEND_RETENTION_DAYS = 90;
/** Local days in the split and in a session's week, today included. */
export const SESSION_SPEND_WEEK_DAYS = 7;
