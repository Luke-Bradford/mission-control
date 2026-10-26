export const MACHINE_CHART_HEIGHT = 24;
const MACHINE_CHART_WIDTH = 100;
const MACHINE_CHART_INSET = 2;

export function machineAreaGeometry(values: (number | null)[], max: number) {
  const height = MACHINE_CHART_HEIGHT;
  const baseline = height - MACHINE_CHART_INSET;
  if (values.length < 2) return { height, baseline, line: null, areas: [] };
  const safeMax = Math.max(1, max);
  const point = (value: number, index: number) => {
    const x = (index / (values.length - 1)) * MACHINE_CHART_WIDTH;
    const y = baseline - (Math.max(0, Math.min(safeMax, value)) / safeMax) * (height - 5);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  };
  const segments = values.reduce<string[][]>(
    (all, value, index) => {
      if (value === null) all.push([]);
      else all.at(-1)?.push(point(value, index));
      return all;
    },
    [[]],
  );
  const nonEmpty = segments.filter((segment) => segment.length > 0);
  const line = nonEmpty
    .map(
      (segment) =>
        `M${segment[0]}${segment
          .slice(1)
          .map((point) => `L${point}`)
          .join("")}`,
    )
    .join("");
  return {
    height,
    baseline,
    line: line || null,
    areas: nonEmpty
      .filter((segment) => segment.length > 1)
      .map((segment) => {
        const first = segment[0] ?? "0,0";
        const last = segment.at(-1) ?? first;
        return `M${first}${segment
          .slice(1)
          .map((point) => `L${point}`)
          .join("")}L${last.split(",")[0]},${baseline}L${first.split(",")[0]},${baseline}Z`;
      }),
  };
}

export function timelineGeometry({ from, to }: { from: number; to: number }) {
  const duration = Math.max(1, to - from);
  const position = (at: number) => Math.round(((100 * (at - from)) / duration) * 1000) / 1000;
  const segment = (start: number, end: number) => {
    if (end <= start) return null;
    const width = (100 * (end - start)) / duration;
    return { left: position(start), width, borderRadius: 0 };
  };
  return {
    baseline: 0,
    position,
    segment,
    tick: (at: number) => ({ left: position(at), width: 1, borderRadius: 0 }),
  };
}
