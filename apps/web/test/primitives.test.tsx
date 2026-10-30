import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentTag, agentColor } from "../src/hud/AgentTag.tsx";
import { Lamp } from "../src/hud/Lamp.tsx";
import { Meter } from "../src/hud/Meter.tsx";
import { Panel } from "../src/hud/Panel.tsx";
import { Pill } from "../src/hud/Pill.tsx";
import { Seg } from "../src/hud/Seg.tsx";

describe("Lamp", () => {
  it("is an image named by its label, titled by default with the label", () => {
    render(<Lamp kind="warn" label="Stalled" />);
    const lamp = screen.getByRole("img", { name: "Stalled" });
    expect(lamp.getAttribute("title")).toBe("Stalled");
  });

  it("takes its own title", () => {
    render(<Lamp kind="warn" label="Stalled" title="no output for 12:00" />);
    expect(screen.getByRole("img", { name: "Stalled" }).getAttribute("title")).toBe(
      "no output for 12:00",
    );
  });

  it.each([
    ["warn", "lamp warn"],
    ["crit", "lamp crit"],
    ["ok", "lamp ok"],
    ["off", "lamp off"],
  ] as const)("%s has its own shape class", (kind, cls) => {
    render(<Lamp kind={kind} label={kind} />);
    expect(screen.getByRole("img").className).toBe(cls);
  });

  it("breathes only when asked", () => {
    render(
      <>
        <Lamp kind="ok" pulse label="a" />
        <Lamp kind="ok" label="b" />
      </>,
    );
    expect(screen.getByRole("img", { name: "a" }).classList.contains("pulse")).toBe(true);
    expect(screen.getByRole("img", { name: "b" }).classList.contains("pulse")).toBe(false);
  });
});

describe("Pill", () => {
  it.each(["ok", "warn", "crit", "neutral", "plain"] as const)("tone %s", (tone) => {
    render(<Pill tone={tone}>Word</Pill>);
    const pill = screen.getByText("Word");
    expect(pill.className).toBe(`pill ${tone}`);
  });
});

describe("Meter", () => {
  const meter = (pct: number | null) => {
    const { container } = render(<Meter label="5h" pct={pct} />);
    const el = container.querySelector(".meter") as HTMLElement;
    const bar = el.querySelector(".track i") as HTMLElement | null;
    return { el, text: el.textContent, width: bar?.style.width ?? null };
  };

  it("shows the rounded value, amber from 80 and red from 100, judged after rounding", () => {
    expect(meter(42.4)).toMatchObject({ text: "5h 42%", width: "42.4%" });
    expect(meter(42.4).el.className).toBe("meter");
    expect(meter(79.4).el.className).toBe("meter");
    expect(meter(79.5).el.className).toBe("meter hi");
    expect(meter(99.4).el.className).toBe("meter hi");
    expect(meter(99.5).el.className).toBe("meter full");
  });

  it("clamps the bar at 100", () => {
    const m = meter(130);
    expect(m.text).toBe("5h 130%");
    expect(m.width).toBe("100%");
    expect(m.el.className).toBe("meter full");
  });

  it("shows a dash and no bar when there is no value", () => {
    const m = meter(null);
    expect(m.text).toBe("5h —");
    expect(m.width).toBeNull();
  });
});

describe("Seg", () => {
  it("is a labelled group of pressed/unpressed buttons", () => {
    const onChange = vi.fn();
    render(
      <Seg
        label="Range"
        options={[
          { value: "1h", label: "1h" },
          { value: "6h", label: "6h" },
        ]}
        value="6h"
        onChange={onChange}
      />,
    );
    const group = screen.getByRole("group", { name: "Range" });
    const [a, b] = [...group.querySelectorAll("button")];
    expect(a?.getAttribute("aria-pressed")).toBe("false");
    expect(b?.getAttribute("aria-pressed")).toBe("true");
    expect(b?.className).toBe("on");
    fireEvent.click(a as HTMLElement);
    expect(onChange).toHaveBeenCalledWith("1h");
  });
});

describe("AgentTag", () => {
  it("colours agents by config index, wrapping after seven, and FLIGHT grey", () => {
    expect(agentColor(0)).toBe("var(--seat-1)");
    expect(agentColor(6)).toBe("var(--seat-7)");
    expect(agentColor(7)).toBe("var(--seat-1)");
    expect(agentColor("flight")).toBe("var(--fg-2)");
  });

  it("renders the square and the id; sm is the row variant", () => {
    const { container } = render(
      <>
        <AgentTag id="shop-app-ta" index={2} />
        <AgentTag id="FLIGHT" index="flight" sm />
      </>,
    );
    const [a, f] = [...container.querySelectorAll(".ag")] as HTMLElement[];
    expect(a?.textContent).toBe("shop-app-ta");
    expect(a?.className).toBe("ag");
    expect(a?.style.getPropertyValue("--c")).toBe("var(--seat-3)");
    expect(f?.className).toBe("ag sm");
    expect(f?.style.getPropertyValue("--c")).toBe("var(--fg-2)");
  });
});

describe("Panel", () => {
  it("is a region named by its title, with the mockup's id, sub and phase badge", () => {
    render(
      <Panel
        id="sitP"
        title="Situation"
        sub="FLIGHT's read"
        phase="P2"
        actions={<button type="button">x</button>}
      >
        <p>body</p>
      </Panel>,
    );
    const panel = screen.getByRole("region", { name: "Situation" });
    expect(panel.id).toBe("sitP");
    expect(panel.className).toBe("panel");
    expect(panel.querySelector(".ph .sub")?.textContent).toBe("FLIGHT's read");
    expect(panel.querySelector(".ph .act .phase")?.textContent).toBe("P2");
    expect(panel.querySelector(".ph .act button")).not.toBeNull();
    expect(panel.textContent).toContain("body");
  });

  it("omits the id, sub and actions when not given", () => {
    render(<Panel title="Plain">x</Panel>);
    const panel = screen.getByRole("region", { name: "Plain" });
    expect(panel.hasAttribute("id")).toBe(false);
    expect(panel.querySelector(".sub, .act")).toBeNull();
  });
});
