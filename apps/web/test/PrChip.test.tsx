import type { RunPr } from "@mc/core";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrChip } from "../src/hud/PrChip.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG } from "./fixtures.ts";

afterEach(() => vi.unstubAllGlobals());

const pr: RunPr = {
  repoId: "site-builder",
  number: 7,
  title: "A change",
  url: "https://github.com/octo-org/site-builder/pull/7",
  state: "open",
  ticket: null,
};

describe("PrChip", () => {
  it("shows a warn held pill naming who holds the merge and why", async () => {
    stubFetch({ "/api/config": CONFIG });
    render(<PrChip pr={{ ...pr, hold: { by: "CAPCOM", reason: "wait for the release" } }} />);
    const pill = await screen.findByText("held");
    expect(pill.classList.contains("pill")).toBe(true);
    expect(pill.classList.contains("warn")).toBe(true);
    expect(pill.getAttribute("title")).toBe("merge held by CAPCOM: wait for the release");
  });

  it("shows no pill when the merge is not held", async () => {
    stubFetch({ "/api/config": CONFIG });
    const { container } = render(<PrChip pr={pr} />);
    await screen.findByRole("link");
    expect(container.querySelector(".pill")).toBeNull();
    expect(screen.queryByText("held")).toBeNull();
  });
});
