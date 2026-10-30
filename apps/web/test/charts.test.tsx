import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HBar } from "../src/hud/charts/HBar.tsx";
import { ChartCursorProvider } from "../src/hud/charts/Hover.tsx";
import { LineChart } from "../src/hud/charts/LineChart.tsx";
import { StackedArea } from "../src/hud/charts/StackedArea.tsx";
import { VBars } from "../src/hud/charts/VBars.tsx";
import { chartAnnotations } from "../src/telemetry/annotations.ts";
import { InstrumentCharts, nearestRank } from "../src/telemetry/InstrumentCharts.tsx";

const k = (v: number): string => `${Math.round(v)}`;

describe("StackedArea", () => {
  const series = [
    { id: "a", name: "shop-app-ta", color: "var(--seat-1)", values: [1, 2, 3, 4] },
    { id: "b", name: "studio", color: "var(--seat-2)", values: [4, 3, 2, 10] },
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

describe("VBars time workspace", () => {
  it("publishes its keyboard cursor and annotations to the shared chart workspace", () => {
    const { container } = render(
      <ChartCursorProvider>
        <VBars
          label="Throughput"
          bars={[
            { key: "a", label: "Mon", tip: "Monday", segments: [{ name: "merged", value: 1 }] },
            { key: "b", label: "Tue", tip: "Tuesday", segments: [{ name: "merged", value: 3 }] },
          ]}
          times={[100, 200]}
          annotations={[{ at: 200, label: "hub Update" }]}
        />
        <LineChart
          label="Other chart"
          from={0}
          to={200}
          xLabels={["start", "now"]}
          at={String}
          series={[
            {
              id: "x",
              name: "x",
              color: "red",
              points: [
                { at: 100, v: 1 },
                { at: 200, v: 2 },
              ],
            },
          ]}
        />
      </ChartCursorProvider>,
    );
    const [throughput, other] = container.querySelectorAll("svg");
    fireEvent.focus(throughput as SVGSVGElement);
    expect(other?.parentElement?.querySelector(".tip")?.textContent).toContain("x2%");
    expect(throughput?.querySelector(".annotation")?.textContent).toBe("");
    expect(throughput?.parentElement?.querySelector(".tip")?.textContent).toContain("hub Update");
  });

  it("snaps an external time cursor to the nearest dated bar", () => {
    const { container } = render(
      <ChartCursorProvider>
        <LineChart
          label="source"
          from={0}
          to={300}
          xLabels={["start", "now"]}
          at={String}
          series={[{ id: "x", name: "x", color: "red", points: [{ at: 160, v: 1 }] }]}
        />
        <VBars
          label="Throughput"
          bars={[
            { key: "a", label: "Mon", tip: "Monday", segments: [{ name: "merged", value: 1 }] },
            { key: "b", label: "Tue", tip: "Tuesday", segments: [{ name: "merged", value: 3 }] },
          ]}
          times={[100, 200]}
        />
      </ChartCursorProvider>,
    );
    const [source, throughput] = container.querySelectorAll("svg");
    fireEvent.focus(source as SVGSVGElement);
    expect(throughput?.parentElement?.querySelector(".tip")?.textContent).toContain("Tuesday");
  });
});

describe("Instrument charts", () => {
  it("keeps only operator-relevant events in the annotation layer", () => {
    expect(
      chartAnnotations([
        { at: 1, kind: "crew-paused", cause: "Crew paused" },
        { at: 2, kind: "oauth-usage", cause: "OAuth usage polled" },
        { at: 3, kind: "quota-poll", cause: "Quota polled" },
        { at: 4, kind: "hub-update", cause: "Updated Mission Control" },
      ]),
    ).toEqual([
      { at: 1, label: "Crew paused" },
      { at: 4, label: "Updated Mission Control" },
    ]);
  });

  it("uses nearest-rank cycle percentiles without dropping a single observation", () => {
    expect(nearestRank([2], 0.5)).toBe(2);
    expect(nearestRank([1, 2, 9], 0.5)).toBe(2);
    expect(nearestRank([1, 2, 9], 0.85)).toBe(9);
  });

  it("renders an observed merge even when its Ready history is unavailable", () => {
    const { container } = render(
      <InstrumentCharts
        scope={{ range: "6h", all: [], agents: [], account: "", wait: "Loading…", live: false }}
        from={0}
        to={60}
        series={{
          stateSpans: [],
          quota: [],
          annotations: [],
          tickets: [{ ticket: "repo#1", readyAt: null, startedAt: null, mergedAt: 30, doneAt: 40 }],
        }}
      />,
    );
    expect(container.querySelectorAll("#tFlow path.line")).toHaveLength(2);
  });

  it("keeps an observed Ready ticket in cumulative flow until it is done", () => {
    const { container } = render(
      <InstrumentCharts
        scope={{ range: "6h", all: [], agents: [], account: "", wait: "Loading…", live: false }}
        from={0}
        to={60}
        series={{
          stateSpans: [],
          quota: [],
          annotations: [],
          tickets: [
            { ticket: "repo#open", readyAt: 20, startedAt: 20, mergedAt: null, doneAt: null },
          ],
        }}
      />,
    );
    expect(container.querySelector("#tFlow svg")?.getAttribute("aria-label")).toContain(
      "in progress latest 1",
    );
    expect(container.querySelector("#tFlow path.line")?.getAttribute("d")).toContain("556.0");
  });

  it("carries work that entered before the range through the flow chart to now", () => {
    const { container } = render(
      <InstrumentCharts
        scope={{ range: "6h", all: [], agents: [], account: "", wait: "Loading…", live: false }}
        from={10}
        to={60}
        series={{
          stateSpans: [],
          quota: [],
          annotations: [],
          tickets: [
            { ticket: "repo#open", readyAt: 5, startedAt: 5, mergedAt: null, doneAt: null },
          ],
        }}
      />,
    );
    const path = container.querySelector("#tFlow path.line")?.getAttribute("d") ?? "";
    expect(path).toContain("38.0");
    expect(path).toContain("556.0");
  });

  it("plots the served open-work, daily quality, full ticket cost, and bounded forecast series", () => {
    const { container } = render(
      <ChartCursorProvider>
        <InstrumentCharts
          scope={{ range: "6h", all: [], agents: [], account: "", wait: "Loading…", live: false }}
          from={0}
          to={60}
          series={{
            stateSpans: [],
            quota: [],
            annotations: [{ at: 30, kind: "hub-update", cause: "Updated Mission Control" }],
            tickets: [
              { ticket: "repo#open", readyAt: 10, startedAt: 10, mergedAt: null, doneAt: null },
              { ticket: "repo#merged", readyAt: -5, startedAt: -5, mergedAt: 40, doneAt: 45 },
            ],
            quality: [
              {
                at: 10,
                ciGreenFirstPushPct: 80,
                reviewRoundsPerPr: 1,
                firstPassReviewPct: 100,
              },
              {
                at: 30,
                ciGreenFirstPushPct: null,
                reviewRoundsPerPr: null,
                firstPassReviewPct: null,
              },
              {
                at: 50,
                ciGreenFirstPushPct: 90,
                reviewRoundsPerPr: 2,
                firstPassReviewPct: 50,
              },
            ],
            throughput: [
              { at: 0, merged: 1 },
              { at: 30, merged: 3 },
            ],
          }}
          ticketCosts={[{ ticket: "repo#merged", tokens: 0, costUsd: 0.25, totalCostUsd: 1.5 }]}
        />
      </ChartCursorProvider>,
    );
    expect(container.querySelector("#tFlow svg")?.getAttribute("aria-label")).toContain(
      "in progress latest 1",
    );
    expect(container.querySelectorAll("#tQualityTrend path.line")).toHaveLength(3);
    expect(
      container.querySelector("#tQualityTrend path.line")?.getAttribute("d")?.match(/M/g),
    ).toHaveLength(2);
    expect(container.querySelector("#tQualityTrend .annotation")).not.toBeNull();
    expect(container.querySelector("#tCostMerged svg")?.getAttribute("aria-label")).toContain(
      "cost per merged ticket latest $1.50",
    );
    expect(container.querySelector("#tCostMerged")?.textContent).toContain("In range: $0.25");
    expect(container.querySelector("#tForecast svg")?.getAttribute("aria-label")).toContain(
      "throughput latest 3",
    );
    const quality = container.querySelector("#tQualityTrend svg") as SVGSVGElement;
    fireEvent.focus(quality);
    fireEvent.keyDown(quality, { key: "ArrowLeft" });
    expect(quality.parentElement?.querySelector(".tip")?.textContent).toContain(
      "Updated Mission Control",
    );
  });

  it("does not substitute a range cost when full ticket cost is explicitly unavailable", () => {
    const { container } = render(
      <InstrumentCharts
        scope={{ range: "6h", all: [], agents: [], account: "", wait: "Loading…", live: false }}
        from={0}
        to={60}
        series={{
          stateSpans: [],
          quota: [],
          annotations: [],
          tickets: [
            { ticket: "repo#merged", readyAt: 10, startedAt: 10, mergedAt: 40, doneAt: 45 },
          ],
        }}
        ticketCosts={[{ ticket: "repo#merged", tokens: 0, costUsd: 0.25, totalCostUsd: null }]}
      />,
    );
    expect(container.querySelector("#tCostMerged")?.textContent).toContain(
      "No API-equivalent cost was reported for merged tickets.",
    );
    expect(container.querySelector("#tCostMerged svg")).toBeNull();
    expect(container.querySelector("#tCostMerged")?.textContent).toContain("In range: $0.25");
  });

  it("renders only the supplied server observations, retaining their timestamps", () => {
    const { container, getByRole } = render(
      <ChartCursorProvider>
        <InstrumentCharts
          scope={{ range: "6h", all: [], agents: [], account: "", wait: "Loading…", live: false }}
          series={{
            stateSpans: [
              { agentId: "crew", state: "running", startedAt: 10, endedAt: 20 },
              { agentId: "crew", state: "parked", startedAt: 20, endedAt: 40 },
            ],
            quota: [],
            tickets: [
              { ticket: "repo#1", readyAt: 10, startedAt: 12, mergedAt: 30, doneAt: 40 },
              { ticket: "repo#2", readyAt: 20, startedAt: 24, mergedAt: null, doneAt: 50 },
            ],
            annotations: [
              { at: 30, kind: "hub-update", cause: "Updated Mission Control" },
              { at: 35, kind: "oauth-usage" as "hub-update", cause: "OAuth usage polled" },
            ],
          }}
          ticketCosts={[{ ticket: "repo#1", tokens: 100, costUsd: 1.25 }]}
          from={0}
          to={60}
        />
      </ChartCursorProvider>,
    );
    expect(container.querySelectorAll(".crew-state-span")).toHaveLength(2);
    expect(container.querySelector(".crew-state-span")?.getAttribute("data-ended-at")).toBe("20");
    expect(container.querySelectorAll(".annotation")).toHaveLength(4);
    expect(container.querySelectorAll("#tFlow path.line").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("#tCycleControl path.line").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("#tCostMerged path.line").length).toBeGreaterThan(0);
    expect(getByRole("heading", { name: "Full cost per merged ticket" })).toBeTruthy();
    expect(container.querySelectorAll("#tCrewState .legend span")).toHaveLength(4);
    expect(container.querySelectorAll("#tFlow .legend span")).toHaveLength(2);
    const timeline = container.querySelector("#tCrewState svg") as SVGSVGElement;
    fireEvent.focus(timeline);
    fireEvent.keyDown(timeline, { key: "ArrowLeft" });
    expect(timeline.parentElement?.querySelector(".tip")?.textContent).toContain("crewparked");
    expect(timeline.parentElement?.querySelector(".tip")?.textContent).toContain(
      "Updated Mission Control",
    );
    const before = timeline.getAttribute("data-from");
    fireEvent.click(getByRole("button", { name: "Zoom in crew state" }));
    expect(timeline.getAttribute("data-from")).not.toBe(before);
    expect(container.querySelector(".crew-state-chart .seg")).not.toBeNull();
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
            color: "var(--seat-1)",
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
            color: "var(--seat-2)",
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
    // CPU's isolated first reading is a visible point, but still has no fill.
    expect(container.querySelectorAll("circle.point")).toHaveLength(1);
    // one fill per unbroken run: CPU's lone first reading has none
    expect(container.querySelectorAll("path.area")).toHaveLength(2);
  });

  it("marks a lone observed value rather than drawing an invisible move-only path", () => {
    const { container } = render(
      <LineChart
        series={[
          {
            id: "cycle",
            name: "p50 cycle time",
            color: "var(--accent)",
            points: [{ at: 50, v: 4 }],
          },
          { id: "cost", name: "cost", color: "var(--warn)", points: [{ at: 50, v: 1.25 }] },
        ]}
        from={0}
        to={100}
        label="Single observations"
        xLabels={["start", "now"]}
        at={String}
      />,
    );
    expect(container.querySelectorAll("circle.point")).toHaveLength(2);
  });

  it("hover lists each series at the nearest sample", () => {
    const { container } = render(
      <LineChart
        series={[
          {
            id: "q",
            name: "claude-main 5h",
            color: "var(--seat-1)",
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
            color: "var(--seat-1)",
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
            color: "var(--seat-1)",
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
        guides={[
          { value: 80, label: "alert 80%" },
          { value: 95, label: "stop 95%" },
        ]}
      />,
    );
    const line = container.querySelector("path.line")?.getAttribute("d") ?? "";
    expect(line.match(/M/g)).toHaveLength(2);
    expect(container.querySelector(".annotation")?.textContent).toBe("");
    const svg = container.querySelector("svg") as SVGSVGElement;
    expect(svg.getAttribute("aria-label")).toContain("events 100 quota reset");
    expect(svg.getAttribute("aria-label")).toContain("thresholds alert 80%, stop 95%");
    fireEvent.focus(svg);
    expect(container.querySelector(".tip")?.textContent).toContain("Eventquota reset");
    expect(container.querySelector(".tip")?.textContent).toContain("Thresholdalert 80%");
  });

  it("stops the shared cursor at an annotation between observed samples", () => {
    const { container } = render(
      <LineChart
        series={[
          {
            id: "flow",
            name: "in progress",
            color: "var(--accent)",
            points: [
              { at: 0, v: 1 },
              { at: 100, v: 2 },
            ],
          },
        ]}
        from={0}
        to={100}
        label="Flow"
        xLabels={["start", "now"]}
        at={String}
        annotations={[{ at: 50, label: "Crew paused" }]}
      />,
    );
    const svg = container.querySelector("svg") as SVGSVGElement;
    fireEvent.focus(svg);
    fireEvent.keyDown(svg, { key: "Home" });
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    expect(container.querySelector(".tip")?.textContent).toContain("Crew paused");
    expect(container.querySelector(".tip")?.textContent).toContain("in progress—");
  });

  it("shares a keyboard crosshair with the other time charts in its workspace", () => {
    const props = {
      series: [
        {
          id: "q",
          name: "quota",
          color: "var(--seat-1)",
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

  it("publishes a line-chart keyboard cursor to a stacked-area time chart", () => {
    const { container } = render(
      <ChartCursorProvider>
        <LineChart
          series={[
            {
              id: "q",
              name: "quota",
              color: "var(--seat-1)",
              points: [
                { at: 0, v: 10 },
                { at: 100, v: 20 },
              ],
            },
          ]}
          from={0}
          to={100}
          label="quota"
          xLabels={["start", "now"]}
          at={String}
        />
        <StackedArea
          series={[{ id: "a", name: "tokens", color: "var(--seat-2)", values: [1, 2] }]}
          label="tokens"
          xLabels={["start", "now"]}
          at={String}
          format={k}
          times={[0, 100]}
        />
      </ChartCursorProvider>,
    );
    const [line] = container.querySelectorAll("svg");
    fireEvent.focus(line as SVGSVGElement);
    expect(container.querySelectorAll(".tip")[1]?.textContent).toContain("tokens2");
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
              { name: "input", value: 300, color: "var(--seat-1)" },
              { name: "output", value: 100, color: "var(--seat-2)" },
              { name: "cache read", value: 9000, color: "var(--seat-3)" },
            ],
          },
        ]}
      />,
    );
    const marks = [...container.querySelectorAll("path.bar")];
    expect(marks.map((m) => m.getAttribute("fill"))).toEqual([
      "var(--seat-1)",
      "var(--seat-2)",
      "var(--seat-3)",
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
        series={[{ id: "a", name: "shop-app-ta", color: "var(--seat-1)", values: [1, 2, 3] }]}
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
        series={[{ id: "a", name: "shop-app-ta", color: "var(--seat-1)", values: [1, 2, 3] }]}
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
            color: "var(--seat-1)",
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
