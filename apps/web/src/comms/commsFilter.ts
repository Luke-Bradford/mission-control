/**
 * The chart's filter: narrow to one seat's conversations or one pair's. It lives in the URL
 * (`?focus=seat:dev-1` or `?focus=pair:a,b`) so a filtered view survives a reload and can be kept
 * open in a second window. Anything that does not name seats on the chart is no filter.
 */
export type ChartFilter = { kind: "seat"; id: string } | { kind: "pair"; a: string; b: string };

export const FOCUS_PARAM = "focus";

/** A pair in its one fixed order. */
export const pairFilter = (x: string, y: string): ChartFilter =>
  x < y ? { kind: "pair", a: x, b: y } : { kind: "pair", a: y, b: x };

export function focusFromSearch(search: string, known: ReadonlySet<string>): ChartFilter | null {
  const raw = new URLSearchParams(search).get(FOCUS_PARAM);
  if (raw === null) return null;
  const at = raw.indexOf(":");
  const kind = raw.slice(0, at);
  const rest = raw.slice(at + 1);
  if (at < 0) return null;
  if (kind === "seat") return known.has(rest) ? { kind: "seat", id: rest } : null;
  if (kind === "pair") {
    const ids = rest.split(",");
    const [a, b] = ids;
    if (ids.length !== 2 || !a || !b || a === b || !known.has(a) || !known.has(b)) return null;
    return pairFilter(a, b);
  }
  return null;
}

export function searchWithFocus(search: string, filter: ChartFilter | null): string {
  const params = new URLSearchParams(search);
  if (filter === null) params.delete(FOCUS_PARAM);
  else
    params.set(
      FOCUS_PARAM,
      filter.kind === "seat" ? `seat:${filter.id}` : `pair:${filter.a},${filter.b}`,
    );
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

/** Whether a link between `x` and `y` is inside the filter. */
export function filterKeeps(filter: ChartFilter | null, x: string, y: string): boolean {
  if (filter === null) return true;
  if (filter.kind === "seat") return x === filter.id || y === filter.id;
  return (x === filter.a && y === filter.b) || (x === filter.b && y === filter.a);
}

export function filterLabel(filter: ChartFilter, name: (id: string) => string): string {
  return filter.kind === "seat" ? name(filter.id) : `${name(filter.a)} ↔ ${name(filter.b)}`;
}

export function sameFilter(x: ChartFilter | null, y: ChartFilter | null): boolean {
  if (x === null || y === null) return x === y;
  if (x.kind === "seat") return y.kind === "seat" && x.id === y.id;
  return y.kind === "pair" && x.a === y.a && x.b === y.b;
}
