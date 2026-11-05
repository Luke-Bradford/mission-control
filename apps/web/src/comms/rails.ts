/**
 * The Comms chart's layout, free of React and the DOM so it can be tested at any crew size.
 *
 * Two rails face each other with the centre line between them: CAPCOM, FLIGHT and #crew sit on the
 * centre line, seats sit on the rails grouped by role. Which rail a role is on depends only on the
 * roles (never on the chart's size), so the panel and the full-screen view show the same order.
 */

export type Point = { x: number; y: number };
export type Side = "left" | "right";

/** One role's seats, in the order they are drawn; `header` when the role name is drawn above them. */
export type RailGroup = { key: string; ids: string[]; header: boolean };

/** The smallest row (px): a control's minimum size. Past it the chart grows and scrolls. */
export const MIN_ROW = 24;
export const MAX_ROW = 34;
const PAD = 16;
/** Width of a mono 11px character with its tracking, as the name boxes count it. */
export const CHAR_PX = 7.3;
/** The centre line's pill width (CAPCOM, FLIGHT, #crew). */
export const HUB_W = 76;
/** The least space kept between the rails for links. */
const MIN_GAP = 150;

export type RailLayout = {
  w: number;
  /** The chart's height: the window's, or taller when the rows need it (the chart then scrolls). */
  h: number;
  cx: number;
  leftX: number;
  rightX: number;
  /** Room for a name outside each rail, px. */
  nameRoom: number;
  rowH: number;
  seats: Map<string, Point & { side: Side }>;
  /** Role names, one per header, at the rail's outer edge. */
  headers: { key: string; side: Side; y: number }[];
  hubs: Map<string, Point>;
};

/** Roles go to the rail with fewer rows so far (the left on a tie): fixed by the roles alone. */
export function sideOfGroups(groups: readonly RailGroup[]): Map<string, Side> {
  const sides = new Map<string, Side>();
  const rows = { left: 0, right: 0 };
  for (const g of groups) {
    const side: Side = rows.left <= rows.right ? "left" : "right";
    sides.set(g.key, side);
    rows[side] += g.ids.length + (g.header ? 1 : 0);
  }
  return sides;
}

/**
 * Lays out `groups` in a `size` window. `hubs` are the centre line's ids top to bottom;
 * `longestName` is the longest seat name in characters (it sets how much room names get).
 */
export function railLayout(
  groups: readonly RailGroup[],
  size: { w: number; h: number },
  hubs: readonly [string, string, string],
  longestName: number,
): RailLayout {
  const w = Math.max(240, size.w);
  const sides = sideOfGroups(groups);
  const rows = { left: 0, right: 0 };
  for (const g of groups) rows[sides.get(g.key) ?? "left"] += g.ids.length + (g.header ? 1 : 0);
  const most = Math.max(1, rows.left, rows.right);
  const fit = (size.h - 2 * PAD) / most;
  const rowH = Math.min(MAX_ROW, Math.max(MIN_ROW, fit));
  const h = Math.max(size.h, most * rowH + 2 * PAD);
  const wanted = longestName * CHAR_PX + 22;
  const nameRoom = Math.max(56, Math.min(wanted, (w - MIN_GAP) / 2));
  const cx = w / 2;
  const leftX = nameRoom;
  const rightX = w - nameRoom;

  const seats = new Map<string, Point & { side: Side }>();
  const headers: RailLayout["headers"] = [];
  for (const side of ["left", "right"] as const) {
    // The rail's rows are centred in the window while they fit, else they start at the top.
    let y = (h - rows[side] * rowH) / 2;
    for (const g of groups) {
      if (sides.get(g.key) !== side) continue;
      if (g.header) {
        headers.push({ key: g.key, side, y: y + rowH / 2 });
        y += rowH;
      }
      for (const id of g.ids) {
        seats.set(id, { x: side === "left" ? leftX : rightX, y: y + rowH / 2, side });
        y += rowH;
      }
    }
  }
  const mid = h / 2;
  const hubGap = Math.min(64, Math.max(34, h / 6));
  const hubPoints = new Map<string, Point>(
    hubs.map((id, i) => [id, { x: cx, y: mid + (i - 1) * hubGap }]),
  );
  return { w, h, cx, leftX, rightX, nameRoom, rowH, seats, headers, hubs: hubPoints };
}

/** A name cut to `px` of room, with an ellipsis; a name that fits is left whole. */
export function fitName(name: string, px: number): string {
  const chars = Math.max(1, Math.floor((px - 14) / CHAR_PX));
  return name.length <= chars ? name : `${name.slice(0, chars - 1)}…`;
}

/**
 * A link's line. Between the rails it is an S curve; between two seats on one rail it bows towards
 * the centre line, further the further apart they are. `mid` is where its wait mark sits.
 */
export function linkPath(
  a: Point,
  b: Point,
  cx: number,
): { d: string; mid: Point; at: (t: number) => Point } {
  const f = (n: number) => n.toFixed(1);
  if (Math.abs(a.x - b.x) < 1) {
    const toward = cx >= a.x ? 1 : -1;
    const bow = Math.min(70, Math.abs(a.y - b.y) * 0.35 + 12) * toward;
    const c = { x: a.x + bow * 2, y: (a.y + b.y) / 2 };
    const at = (t: number): Point => ({
      x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * c.x + t ** 2 * b.x,
      y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * c.y + t ** 2 * b.y,
    });
    return { d: `M${f(a.x)} ${f(a.y)} Q${f(c.x)} ${f(c.y)} ${f(b.x)} ${f(b.y)}`, mid: at(0.5), at };
  }
  const dx = Math.abs(b.x - a.x) / 2;
  const sign = b.x > a.x ? 1 : -1;
  const c1 = { x: a.x + dx * sign, y: a.y };
  const c2 = { x: b.x - dx * sign, y: b.y };
  const at = (t: number): Point => {
    const u = 1 - t;
    return {
      x: u ** 3 * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * b.x,
      y: u ** 3 * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * b.y,
    };
  };
  return {
    d: `M${f(a.x)} ${f(a.y)} C${f(c1.x)} ${f(c1.y)} ${f(c2.x)} ${f(c2.y)} ${f(b.x)} ${f(b.y)}`,
    mid: at(0.5),
    at,
  };
}
