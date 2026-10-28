/** A label's box on the stage, centred on (x, y), in CSS pixels. */
export interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Lower ranks are placed first and win a collision. */
  rank: number;
  /** May move up, row by row, with a leader line back to its anchor. */
  nudge: boolean;
}

export interface LabelPlacement {
  y: number;
  hidden: boolean;
  /** How far the label moved up from its anchor, for the leader line. */
  lift: number;
}

/** What each overlay label class is: its rank, and whether it may move off its anchor. */
const KINDS: [className: string, rank: number, nudge: boolean][] = [
  ["map-orb-label", 0, true],
  ["map-marker", 1, false],
  ["map-arc", 1, false],
  // area names hold their place; pins and change labels lift around them
  ["map-area", 2, false],
  // findings and conflicts: small marks that stay on their file, hidden if something better is there
  ["map-mark", 3, false],
  ["map-change", 4, true],
];

/** null: a mark drawn on its node (rings), never moved or hidden for a label. */
export function labelKind(className: string): { rank: number; nudge: boolean } | null {
  const classes = className.split(/\s+/);
  const kind = KINDS.find(([name]) => classes.includes(name));
  return kind ? { rank: kind[1], nudge: kind[2] } : null;
}

/**
 * Labels never overlap: each, best rank first and then top to bottom, takes its anchor, or the
 * first free row above it (up to `rows`, drawn with a leader line), or hides. A label off the stage
 * hides too.
 */
export function declutter(
  boxes: LabelBox[],
  width: number,
  height: number,
  gap = 2,
  rows = 3,
): LabelPlacement[] {
  const order = boxes.map((_, i) => i);
  order.sort((a, b) => {
    const p = boxes[a] as LabelBox;
    const q = boxes[b] as LabelBox;
    return p.rank - q.rank || p.y - q.y || p.x - q.x;
  });
  const placed: { l: number; t: number; r: number; b: number }[] = [];
  const out: LabelPlacement[] = boxes.map((b) => ({ y: b.y, hidden: true, lift: 0 }));
  for (const i of order) {
    const box = boxes[i] as LabelBox;
    for (let k = 0; k <= (box.nudge ? rows : 0); k++) {
      const lift = k * (box.h + gap);
      const y = box.y - lift;
      const rect = {
        l: box.x - box.w / 2,
        t: y - box.h / 2,
        r: box.x + box.w / 2,
        b: y + box.h / 2,
      };
      if (rect.r < 0 || rect.l > width || rect.b < 0 || rect.t > height) break;
      if (
        placed.some(
          (p) =>
            rect.l < p.r + gap && rect.r + gap > p.l && rect.t < p.b + gap && rect.b + gap > p.t,
        )
      )
        continue;
      placed.push(rect);
      out[i] = { y, hidden: false, lift };
      break;
    }
  }
  return out;
}
