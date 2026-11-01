import type { RunPr } from "@mc/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
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
  it("shows acceptance only while an open PR has its UAT gate", () => {
    const view = render(<PrChip pr={{ ...pr, uat: { sha: "a".repeat(40) } }} />);
    expect(screen.getByText("Waiting for your acceptance")).toBeTruthy();
    view.rerender(<PrChip pr={pr} />);
    expect(screen.queryByText("Waiting for your acceptance")).toBeNull();
  });
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
    expect(screen.queryByRole("link", { name: "Open preview for PR #7" })).toBeNull();
  });

  it("does not offer a preview when none is running", async () => {
    stubFetch({ "/api/config": CONFIG });
    render(<PrChip pr={pr} preview={null} />);

    expect(screen.queryByRole("button", { name: "Start preview for PR #7" })).toBeNull();
  });

  it("starts a supported preview once, without opening the surrounding card, then links to it", async () => {
    const live = {
      pr: 7,
      branch: "feature/preview",
      port: 7431,
      url: "http://127.0.0.1:7431",
      startedAt: 1,
    };
    let finish!: (response: Response) => void;
    const fetch = stubFetch({ "/api/config": CONFIG });
    const originalFetch = fetch.getMockImplementation();
    if (!originalFetch) throw new Error("fetch stub missing");
    fetch.mockImplementation((path, init) =>
      path === "/api/previews"
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : originalFetch(path, init),
    );
    const navigate = vi.fn();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: simulates the Board card's mouse shortcut around its links and button
      // biome-ignore lint/a11y/useKeyWithClickEvents: the real control inside is keyboard-accessible
      <div onClick={navigate}>
        <PrChip pr={pr} previewable preview={null} />
      </div>,
    );
    const button = screen.getByRole("button", { name: "Start preview for PR #7" });
    button.focus();
    fireEvent.click(button);
    expect(navigate).not.toHaveBeenCalled();
    expect(button.textContent).toBe("Starting preview…");
    expect(button.hasAttribute("disabled")).toBe(true);
    const calls = fetch.mock.calls.filter(
      ([path, init]) => path === "/api/previews" && init?.method === "POST",
    );
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0][1]?.body as string)).toEqual({ pr: 7 });
    await act(async () => {
      finish(new Response(JSON.stringify(live)));
    });
    const link = await screen.findByRole("link", { name: "Open preview for PR #7" });
    expect(link.getAttribute("href")).toBe(live.url);
    expect(document.activeElement).toBe(link);
    expect(screen.queryByRole("button", { name: "Start preview for PR #7" })).toBeNull();
  });

  it("shows a server refusal and allows retrying", async () => {
    let attempts = 0;
    stubFetch({
      "/api/config": CONFIG,
      "POST /api/previews": () =>
        ++attempts === 1
          ? {
              status: 409,
              body: { error: "At most two previews can run. Close one and try again." },
            }
          : {
              status: 200,
              body: {
                pr: 7,
                branch: "feature/preview",
                port: 7431,
                url: "http://127.0.0.1:7431",
                startedAt: 1,
              },
            },
    });
    render(<PrChip pr={pr} previewable preview={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Start preview for PR #7" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Close one and try again.");
    const retry = screen.getByRole("button", { name: "Start preview for PR #7" });
    expect(retry.hasAttribute("disabled")).toBe(false);
    fireEvent.click(retry);
    await screen.findByRole("link", { name: "Open preview for PR #7" });
    expect(attempts).toBe(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers Start again after the payload reports that its preview ended", async () => {
    stubFetch({ "/api/config": CONFIG });
    const live = {
      pr: 7,
      branch: "feature/preview",
      port: 7431,
      url: "http://127.0.0.1:7431",
      startedAt: 1,
    };
    const view = render(<PrChip pr={pr} previewable preview={live} />);
    expect(screen.queryByRole("button", { name: "Start preview for PR #7" })).toBeNull();
    view.rerender(<PrChip pr={pr} previewable preview={null} />);
    expect(screen.getByRole("button", { name: "Start preview for PR #7" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open preview for PR #7" })).toBeNull();
  });

  it.each(["closed", "merged"] as const)(
    "does not start a %s PR even with stale capability",
    (state) => {
      stubFetch({ "/api/config": CONFIG });
      render(<PrChip pr={{ ...pr, state }} previewable preview={null} />);
      expect(screen.queryByRole("button", { name: "Start preview for PR #7" })).toBeNull();
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

  it("opens the PR's ticket page when it names a ticket, with GitHub as the second link", async () => {
    stubFetch({ "/api/config": CONFIG });
    render(<PrChip pr={{ ...pr, ticket: "site-builder#12" }} />);
    const link = await screen.findByRole("link", { name: "site-builder PR #7" });
    expect(link.getAttribute("href")).toBe("/tickets/site-builder/12");
    expect(
      screen.getByRole("link", { name: "site-builder PR #7 on GitHub" }).getAttribute("href"),
    ).toBe("https://github.com/octo-org/site-builder/pull/7");
  });

  it("links a PR with no ticket to GitHub alone", async () => {
    stubFetch({ "/api/config": CONFIG });
    render(<PrChip pr={pr} />);
    const link = await screen.findByRole("link", { name: "site-builder PR #7" });
    expect(link.getAttribute("href")).toBe("https://github.com/octo-org/site-builder/pull/7");
  });
});
