import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HBar } from "../src/hud/charts/HBar.tsx";
import { ChartCursorProvider } from "../src/hud/charts/Hover.tsx";
import { LineChart } from "../src/hud/charts/LineChart.tsx";
import { StackedArea } from "../src/hud/charts/StackedArea.tsx";
import { VBars } from "../src/hud/charts/VBars.tsx";

const k = (v: number): string => `${Math.round(v)}`;

describe("StackedArea", () => {
  const series = [
    { id: "a", name: "shop-app-ta", color: "var(--s1)", values: [1, 2, 3, 4] },
    { id: "b", name: "studio", color: "var(--s2)", values: [4, 3, 2, 10] },
  ];

  it("draws one area and one line per series, labelled for screen readers", () => {
    const { container } = render(
      <StackedArea
        series={series}
        label="Tokens per minute"
        xLabels={["-6h", "now"]}
        at={(i) => `${i} ago`}
        format={k}
      />,
    );
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toBe(
      "Tokens per minute: shop-app-ta latest 4, peak 4; studio latest 10, peak 10",
    );
    expect(container.querySelectorAll("path.area")).toHaveLength(2);
    expect(container.querySelectorAll("path.line")).toHaveLength(2);
    expect(container.querySelectorAll("line.gl")).toHaveLength(3);
    const texts = [...container.querySelectorAll("text")].map((t) => t.textContent);
    expect(texts).toContain("-6h");
    expect(texts).toContain("now");
    // the top of the stack is the total: 14 at the last point is the y max (× 1.08 headroom)
    expect(texts).toContain("14");
    // no end-point dots; "now" is a cursor line, and the fills fade by gradient
    expect(container.querySelectorAll("circle")).toHaveLength(0);
    expect(container.querySelectorAll("line.nowc")).toHaveLength(1);
    expect(container.querySelectorAll("linearGradient")).toHaveLength(2);
  });

  it("hover snaps a crosshair to the nearest point and lists every series there", () => {
    const { container } = render(
      <StackedArea
        series={series}
        label="Tokens"
        xLabels={["-6h", "now"]}
        at={(i) => `${3 - i} min ago`}
        format={k}
      />,
    );
    const hit = container.querySelector("rect.hit") as SVGRectElement;
    // jsdom has no layout: pointer x is read as a viewBox x; the plot spans 38..(width - 4)
    fireEvent.pointerMove(hit, { clientX: 2000 });
    const tip = container.querySelector(".tip") as HTMLElement;
    expect(tip.textContent).toBe("0 min agostudio10shop-app-ta4");
    expect(container.querySelector("line.xhair")).not.toBeNull();
    fireEvent.pointerLeave(hit);
    expect(container.querySelector(".tip")).toBeNull();
    expect(container.querySelector("line.xhair")).toBeNull();
  });

  it("renders nothing for no series", () => {
    const { container } = render(
      <StackedArea series={[]} label="x" xLabels={["a", "b"]} at={() => ""} format={k} />,
    );
    expect(container.querySelector("svg")).toBeNull();
  });
});

describe("LineChart", () => {
  const from = 0;
  const to = 100;
  it("one path per series, broken where a value is missing; y labels at 0/50/100 % of max", () => {
    const { container } = render(
      <LineChart
        series={[
          {
            id: "cpu",
            name: "CPU",
            color: "var(--s1)",
            points: [
              { at: 0, v: 10 },
              { at: 50, v: null },
              { at: 60, v: 30 },
              { at: 100, v: 40 },
            ],
          },
          {
            id: "mem",
            name: "Memory",
            color: "var(--s2)",
            points: [
              { at: 0, v: 20 },
              { at: 100, v: 25 },
            ],
          },
        ]}
        from={from}
        to={to}
        max={110}
        limit
        label="Machine load"
        xLabels={["-6h", "now"]}
        at={(ms) => `${100 - ms} ago`}
      />,
    );
    const paths = [...container.querySelectorAll("path.line")];
    expect(paths).toHaveLength(2);
    expect((paths[0]?.getAttribute("d") ?? "").match(/M/g)).toHaveLength(2);
    expect(container.querySelector("line.limit")?.getAttribute("stroke-dasharray")).toBe("4 3");
    const texts = [...container.querySelectorAll("text")].map((t) => t.textContent);
    expect(texts).toEqual(expect.arrayContaining(["0%", "55%", "110%", "-6h", "now"]));
    expect(container.querySelector("svg")?.getAttribute("aria-label")).toBe(
      "Machine load: CPU latest 40%, peak 40%; Memory latest 25%, peak 25%",
    );
    expect(container.querySelectorAll("circle")).toHaveLength(0);
    // one fill per unbroken run: CPU's lone first reading has none
    expect(container.querySelectorAll("path.area")).toHaveLength(2);
  });

  it("hover lists each series at the nearest sample", () => {
    const { container } = render(
      <LineChart
        series={[
          {
            id: "q",
            name: "claude-main 5h",
            color: "var(--s1)",
            points: [
              { at: 0, v: 10.4 },
              { at: 100, v: 62.6 },
            ],
          },
        ]}
        from={from}
        to={to}
        label="Quota"
        xLabels={["-6h", "now"]}
        at={(ms) => (ms === 100 ? "now" : "earlier")}
      />,
    );
    fireEvent.pointerMove(container.querySelector("rect.hit") as Element, { clientX: 0 });
    expect(container.querySelector(".tip")?.textContent).toBe("earlierclaude-main 5h10%");
  });

  it("no line limit unless asked", () => {
    const { container } = render(
      <LineChart
        series={[
          {
            id: "x",
            name: "x",
            color: "var(--s1)",
            points: [
              { at: 0, v: 1 },
              { at: 1, v: 2 },
            ],
          },
        ]}
        from={0}
        to={1}
        label="x"
        xLabels={["a", "b"]}
        at={() => ""}
      />,
    );
    expect(container.querySelector("line.limit")).toBeNull();
  });

  it("keeps a missing reading as a gap and exposes reset annotations to keyboard users", () => {
    const { container } = render(
      <LineChart
        series={[
          {
            id: "q",
            name: "quota",
            color: "var(--s1)",
            points: [
              { at: 0, v: 80 },
              { at: 50, v: null },
              { at: 100, v: 12 },
            ],
          },
        ]}
        from={0}
        to={100}
        label="Quota"
        xLabels={["start", "now"]}
        at={(ms) => `${ms}`}
        annotations={[{ at: 100, label: "quota reset" }]}
      />,
    );
    const line = container.querySelector("path.line")?.getAttribute("d") ?? "";
    expect(line.match(/M/g)).toHaveLength(2);
    expect(container.querySelector(".annotation")?.textContent).toBe("quota reset");
    const svg = container.querySelector("svg") as SVGSVGElement;
    fireEvent.focus(svg);
    expect(container.querySelector(".tip")?.textContent).toContain("quota12%");
  });

  it("shares a keyboard crosshair with the other time charts in its workspace", () => {
    const props = {
      series: [
        {
          id: "q",
          name: "quota",
          color: "var(--s1)",
          points: [
            { at: 0, v: 10 },
            { at: 100, v: 20 },
          ],
        },
      ],
      from: 0,
      to: 100,
      xLabels: ["start", "now"] as [string, string],
      at: (ms: number) => `${ms}`,
    };
    const { container } = render(
      <ChartCursorProvider>
        <LineChart {...props} label="first" />
        <LineChart {...props} label="second" />
      </ChartCursorProvider>,
    );
    const [first, second] = container.querySelectorAll("svg");
    fireEvent.focus(first as SVGSVGElement);
    expect(second?.parentElement?.querySelector(".tip")?.textContent).toContain("quota20%");
  });
});

describe("VBars", () => {
  const bars = Array.from({ length: 14 }, (_, i) => ({
    key: `d${i}`,
    label: `L${i}`,
    tip: `day ${i}: ${i % 3} merged`,
    segments: [{ name: "merged", value: i % 3 }],
  }));

  it("one bar per value, the last in the accent, every 2nd labelled ending at the last", () => {
    const { container } = render(<VBars bars={bars} every={2} label="Throughput" accentLast />);
    const marks = [...container.querySelectorAll("path.bar")];
    // zero-height bars draw nothing; 14 days with i % 3 === 0 on 5 of them
    expect(marks).toHaveLength(9);
    expect(marks.at(-1)?.getAttribute("fill")).toBe("var(--accent)");
    expect(marks[0]?.getAttribute("fill")).toBe("var(--fg-2)");
    const xl = [...container.querySelectorAll("text.xl")].map((t) => t.textContent);
    expect(xl).toEqual(["L1", "L3", "L5", "L7", "L9", "L11", "L13"]);
    expect(container.querySelector("svg")?.getAttribute("aria-label")).toBe(
      "Throughput: L0 0, L1 1, L2 2, L3 0, L4 1, L5 2, L6 0, L7 1, L8 2, L9 0, L10 1, L11 2, L12 0, L13 1",
    );
  });

  it("labels thin out to fit their slots, still ending at the last bar", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      key: `t${i}`,
      label: `turn ${i + 1}`,
      tip: `turn ${i + 1}`,
      segments: [{ name: "input", value: 1 }],
    }));
    const { container } = render(<VBars bars={many} label="Tokens per turn" />);
    const xl = [...container.querySelectorAll("text.xl")];
    // 518 px of plot for 60 bars: ~8.6 px a slot, a 7-character label needs about 7 slots
    expect(xl).toHaveLength(9);
    expect(xl.at(-1)?.textContent).toBe("turn 60");
    expect(xl.at(-1)?.getAttribute("text-anchor")).toBe("end");
  });

  it("each bar's slot is its hover target and shows its tooltip", () => {
    const { container } = render(<VBars bars={bars} every={2} label="Throughput" />);
    const slots = container.querySelectorAll("rect.hit");
    expect(slots).toHaveLength(14);
    fireEvent.pointerEnter(slots[4] as Element);
    expect(container.querySelector(".tip")?.textContent).toBe("day 4: 1 merged");
    fireEvent.pointerLeave(slots[4] as Element);
    expect(container.querySelector(".tip")).toBeNull();
  });

  it("stacks segments with their own colours and lists them in the tooltip", () => {
    const { container } = render(
      <VBars
        label="Tokens per turn"
        format={k}
        bars={[
          {
            key: "t1",
            label: "turn 1",
            tip: "turn 1",
            segments: [
              { name: "input", value: 300, color: "var(--s1)" },
              { name: "output", value: 100, color: "var(--s2)" },
              { name: "cache read", value: 9000, color: "var(--s3)" },
            ],
          },
        ]}
      />,
    );
    const marks = [...container.querySelectorAll("path.bar")];
    expect(marks.map((m) => m.getAttribute("fill"))).toEqual([
      "var(--s1)",
      "var(--s2)",
      "var(--s3)",
    ]);
    fireEvent.pointerEnter(container.querySelector("rect.hit") as Element);
    expect(container.querySelector(".tip")?.textContent).toBe(
      "turn 1cache read9000output100input300",
    );
  });
});

describe("HBar", () => {
  it("a row with a track filled to pct", () => {
    const { container } = render(<HBar label="XS" pct={40} value="0.6 d" extra="(4 tickets)" />);
    expect(container.textContent).toBe("XS0.6 d(4 tickets)");
    expect((container.querySelector(".track i") as HTMLElement).style.width).toBe("40%");
  });
});

describe("keyboard", () => {
  const key = (el: Element, k: string) => fireEvent.keyDown(el, { key: k });
  const tip = (c: HTMLElement) => c.querySelector(".tip")?.textContent ?? null;

  it("StackedArea: focus shows the newest point; arrows, Home and End step; blur hides it", () => {
    const { container } = render(
      <StackedArea
        series={[{ id: "a", name: "shop-app-ta", color: "var(--s1)", values: [1, 2, 3] }]}
        label="Tokens"
        xLabels={["-6h", "now"]}
        at={(i) => `p${i}`}
        format={k}
      />,
    );
    const svg = container.querySelector("svg") as SVGSVGElement;
    expect(svg.getAttribute("tabindex")).toBe("0");
    fireEvent.focus(svg);
    expect(tip(container)).toBe("p2shop-app-ta3");
    key(svg, "ArrowLeft");
    expect(tip(container)).toBe("p1shop-app-ta2");
    key(svg, "Home");
    expect(tip(container)).toBe("p0shop-app-ta1");
    key(svg, "ArrowLeft");
    expect(tip(container)).toBe("p0shop-app-ta1");
    key(svg, "End");
    expect(tip(container)).toBe("p2shop-app-ta3");
    key(svg, "ArrowRight");
    expect(tip(container)).toBe("p2shop-app-ta3");
    expect(container.querySelector("line.xhair")).not.toBeNull();
    fireEvent.blur(svg);
    expect(tip(container)).toBeNull();
    expect(container.querySelector("line.xhair")).toBeNull();
  });

  it("the tooltip is a polite live region, so stepping reads the new value out", () => {
    const { container } = render(
      <StackedArea
        series={[{ id: "a", name: "shop-app-ta", color: "var(--s1)", values: [1, 2, 3] }]}
        label="Tokens"
        xLabels={["-6h", "now"]}
        at={(i) => `p${i}`}
        format={k}
      />,
    );
    fireEvent.focus(container.querySelector("svg") as SVGSVGElement);
    const el = container.querySelector(".tip");
    expect(el?.getAttribute("aria-live")).toBe("polite");
    expect(el?.getAttribute("aria-atomic")).toBe("true");
    expect(el?.hasAttribute("aria-hidden")).toBe(false);
    const before = el?.textContent;
    fireEvent.keyDown(container.querySelector("svg") as SVGSVGElement, { key: "ArrowLeft" });
    expect(container.querySelector(".tip")).toBe(el); // the same live region, updated in place
    expect(el?.textContent).not.toBe(before);
  });

  it("LineChart steps through the sample times", () => {
    const { container } = render(
      <LineChart
        series={[
          {
            id: "q",
            name: "5h",
            color: "var(--s1)",
            points: [
              { at: 0, v: 10 },
              { at: 50, v: 30 },
              { at: 100, v: 60 },
            ],
          },
        ]}
        from={0}
        to={100}
        label="Quota"
        xLabels={["-6h", "now"]}
        at={(ms) => `t${ms}`}
      />,
    );
    const svg = container.querySelector("svg") as SVGSVGElement;
    expect(svg.getAttribute("tabindex")).toBe("0");
    fireEvent.focus(svg);
    expect(tip(container)).toBe("t1005h60%");
    key(svg, "ArrowLeft");
    expect(tip(container)).toBe("t505h30%");
    key(svg, "Home");
    expect(tip(container)).toBe("t05h10%");
    fireEvent.blur(svg);
    expect(tip(container)).toBeNull();
  });

  it("VBars steps bar by bar", () => {
    const bars = [0, 1, 2].map((i) => ({
      key: `d${i}`,
      label: `L${i}`,
      tip: `day ${i}`,
      segments: [{ name: "merged", value: i + 1 }],
    }));
    const { container } = render(<VBars bars={bars} label="Throughput" />);
    const svg = container.querySelector("svg") as SVGSVGElement;
    expect(svg.getAttribute("tabindex")).toBe("0");
    fireEvent.focus(svg);
    expect(tip(container)).toBe("day 2");
    key(svg, "ArrowLeft");
    expect(tip(container)).toBe("day 1");
    key(svg, "Home");
    expect(tip(container)).toBe("day 0");
    fireEvent.blur(svg);
    expect(tip(container)).toBeNull();
  });
});
