import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Meter } from "../src/hud/Meter.tsx";
import { PillButton } from "../src/hud/Pill.tsx";

describe("text from the shared formatters", () => {
  it("shows a fractional meter value and its projection as rounded percents", () => {
    const { container } = render(<Meter label="7d" pct={86.4} projected={112.6} />);
    expect(screen.getByText("7d 86%")).toBeTruthy();
    expect(container.querySelector(".projection-tick")?.getAttribute("title")).toBe(
      "Projected at reset: 113%",
    );
  });

  it("shows a dash for a meter with no reading", () => {
    render(<Meter label="5h" pct={null} />);
    expect(screen.getByText("5h —")).toBeTruthy();
  });

  it("renders a pill control as a button with the pill classes and its own", () => {
    const onClick = vi.fn();
    render(
      <PillButton tone="warn" className="kyou" title="why" onClick={onClick}>
        Answer
      </PillButton>,
    );
    const button = screen.getByRole("button", { name: "Answer" });
    expect(button.className).toBe("pill warn kyou");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("title")).toBe("why");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
