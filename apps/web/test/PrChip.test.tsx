import type { RunPr } from "@mc/core";
import { fireEvent, render, screen } from "@testing-library/react";
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
  it("links to the running preview supplied by the PR payload", async () => {
    stubFetch({ "/api/config": CONFIG });
    render(
      <PrChip
        pr={pr}
        preview={{
          pr: 7,
          branch: "feature/preview",
          port: 5175,
          url: "http://127.0.0.1:5175",
          startedAt: 1,
        }}
      />,
    );

    const link = await screen.findByRole("link", { name: "Open preview for PR #7" });
    expect(link.textContent).toBe("Preview");
    expect(link.getAttribute("href")).toBe("http://127.0.0.1:5175");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("follows preview payload changes after it first mounts", async () => {
    stubFetch({ "/api/config": CONFIG });
    const live = {
      pr: 7,
      branch: "feature/preview",
      port: 5175,
      url: "http://127.0.0.1:5175",
      startedAt: 1,
    };
    const view = render(<PrChip pr={pr} />);

    expect(await screen.findByRole("link", { name: "site-builder PR #7" })).toBeTruthy();
    view.rerender(<PrChip pr={pr} preview={live} />);
    expect(await screen.findByRole("link", { name: "Open preview for PR #7" })).toBeTruthy();

    view.rerender(<PrChip pr={pr} preview={null} />);
    expect(await screen.findByRole("button", { name: "Start preview for PR #7" })).toBeTruthy();
  });

  it("starts a preview when the PR payload has none", async () => {
    const fetch = stubFetch({
      "/api/config": CONFIG,
      "POST /api/previews": {
        pr: 7,
        branch: "feature/preview",
        port: 5175,
        url: "http://127.0.0.1:5175",
        startedAt: 1,
      },
    });
    render(<PrChip pr={pr} preview={null} />);

    fireEvent.click(await screen.findByRole("button", { name: "Start preview for PR #7" }));

    const link = await screen.findByRole("link", { name: "Open preview for PR #7" });
    expect(link.getAttribute("href")).toBe("http://127.0.0.1:5175");
    expect(fetch).toHaveBeenCalledWith(
      "/api/previews",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ pr: 7 }) }),
    );
  });

  it("does not offer a preview for a closed PR", async () => {
    stubFetch({ "/api/config": CONFIG });
    render(<PrChip pr={{ ...pr, state: "closed" }} preview={null} />);

    expect(screen.queryByRole("button", { name: "Start preview for PR #7" })).toBeNull();
  });

  it.each(["at most 2 previews can run at once", "the machine guard is holding previews"])(
    "shows a preview refusal as text: %s",
    async (error) => {
      stubFetch({
        "/api/config": CONFIG,
        "POST /api/previews": () => ({ status: 409, body: { error } }),
      });
      render(<PrChip pr={pr} preview={null} />);

      fireEvent.click(await screen.findByRole("button", { name: "Start preview for PR #7" }));

      expect((await screen.findByRole("alert")).textContent).toContain(error);
    },
  );

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
