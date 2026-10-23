import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { roleTitle, seatRoleTitle } from "../src/crew.ts";
import { AgentTag } from "../src/hud/AgentTag.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, seatRow } from "./fixtures.ts";

/** `matchMedia` for a phone (`narrow`) or a wide window. */
function stubWidth(narrow: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: narrow,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

function stub() {
  stubFetch({
    "/api/crew": { rows: [seatRow()], firstRunToday: null },
    "/api/config": CONFIG,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("roleTitle", () => {
  it.each([
    ["backend developer, test-first in its area", "Backend developer"],
    ["frontend developer", "Frontend developer"],
    ["planner: writes each ticket's plan for the developers", "Planner"],
    ["", ""],
  ])("%s is %s", (here, title) => {
    expect(roleTitle(here)).toBe(title);
  });
});

describe("seatRoleTitle", () => {
  it("takes the title from the config's role first, else the built-in one", () => {
    const rows = [seatRow()];
    expect(seatRoleTitle("guido-1", rows, [{ name: "GUIDO", here: "plumber: pipes" }])).toBe(
      "Plumber",
    );
    expect(seatRoleTitle("GUIDO-1", rows, undefined)).toBe("Backend developer");
    expect(seatRoleTitle("FLIGHT", rows, undefined)).toBe("Head agent");
  });

  it("is null for an observed loop and an unknown id", () => {
    const loop = seatRow({ id: "ta", kind: "loop", role: null });
    expect(seatRoleTitle("ta", [loop], undefined)).toBeNull();
    expect(seatRoleTitle("nobody", [], undefined)).toBeNull();
  });
});

describe("AgentTag role title", () => {
  it("shows the title beside the call sign on a wide screen", async () => {
    stubWidth(false);
    stub();
    const { container } = render(<AgentTag id="guido-1" index={0} />);
    await screen.findByText(/Backend developer/);
    const tag = container.querySelector(".ag") as HTMLElement;
    expect(tag.textContent).toBe("guido-1 · Backend developer");
    expect(tag.getAttribute("title")).toBeNull();
  });

  it("moves the title into a tooltip on a narrow screen", async () => {
    stubWidth(true);
    stub();
    const { container } = render(<AgentTag id="guido-1" index={0} />);
    const tag = container.querySelector(".ag") as HTMLElement;
    await vi.waitFor(() => expect(tag.getAttribute("title")).toBe("Backend developer"));
    expect(tag.textContent).toBe("guido-1");
  });
});
