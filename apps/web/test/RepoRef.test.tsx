import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepoRef, TicketRef } from "../src/hud/RepoRef.tsx";
import { Comms } from "../src/pages/Comms.tsx";
import { Flight } from "../src/pages/Flight.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, crewRow, item, NOW, seatRow } from "./fixtures.ts";

afterEach(() => vi.unstubAllGlobals());

const chipOf = (el: HTMLElement) => el.querySelector<HTMLElement>(".rchip");

describe("RepoRef", () => {
  it("is the repo as a chip, then the number apart from it as a link to the issue", async () => {
    stubFetch({ "/api/config": CONFIG });
    const { container } = render(<RepoRef repoId="site-builder" number={1600} />);
    // the name carries the repo (the chip is not in the link), and the visible label is in it
    const link = await screen.findByRole("link", { name: "site-builder #1600" });
    expect(link.textContent).toBe("#1600");
    expect(link.getAttribute("href")).toBe("https://github.com/octo-org/site-builder/issues/1600");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    const chip = chipOf(container);
    expect(chip?.textContent).toBe("site-builder");
    expect(chip?.style.getPropertyValue("--c")).toBe("var(--r2)");
    // the chip is not inside the link: the number is the link text and nothing else
    expect(link.contains(chip)).toBe(false);
  });

  it("names its repo in full in the chip's title, for where CSS cuts the chip short", async () => {
    stubFetch({ "/api/config": CONFIG });
    const { container } = render(<RepoRef repoId="site-builder" number={1600} />);
    expect(chipOf(container)?.title).toBe("site-builder");
    await screen.findByRole("link", { name: "site-builder #1600" });
  });

  it("writes a PR as PR #n and links to the pull request", async () => {
    stubFetch({ "/api/config": CONFIG });
    const { container } = render(<RepoRef repoId="shop-app" number={3931} kind="pr" />);
    const link = await screen.findByRole("link", { name: "shop-app PR #3931" });
    expect(link.textContent).toBe("PR #3931");
    expect(link.getAttribute("href")).toBe("https://github.com/octo-org/shop-app/pull/3931");
    expect(chipOf(container)?.style.getPropertyValue("--c")).toBe("var(--r1)");
  });

  it("leaves the chip out on a page that shows one repo, and keeps the link", async () => {
    stubFetch({ "/api/config": CONFIG });
    const { container } = render(<RepoRef repoId="shop-app" number={7} bare />);
    // bare leaves the chip out, but the link still says which repo
    const link = await screen.findByRole("link", { name: "shop-app #7" });
    expect(link.getAttribute("href")).toBe("https://github.com/octo-org/shop-app/issues/7");
    expect(chipOf(container)).toBeNull();
  });

  it("is plain text, with no colour and no link, for a repo that is not configured", async () => {
    stubFetch({ "/api/config": CONFIG });
    const { container } = render(<RepoRef repoId="elsewhere" number={5} />);
    expect(await screen.findByText("#5")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(chipOf(container)?.style.getPropertyValue("--c")).toBe("");
  });

  it("does not build a link from an owner/name that is not a GitHub path", async () => {
    const config = {
      ...CONFIG,
      repos: [{ ...(CONFIG.repos[0] as (typeof CONFIG.repos)[0]), github: "../evil?x=1/y" }],
    };
    stubFetch({ "/api/config": config });
    render(<RepoRef repoId="shop-app" number={5} />);
    expect(await screen.findByText("#5")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it.each([0, -3, 1.5, Number.NaN, 2 ** 60])("does not link the number %s", async (n) => {
    stubFetch({ "/api/config": CONFIG });
    render(<RepoRef repoId="shop-app" number={n} />);
    expect(await screen.findByText(`#${n}`)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("TicketRef reads repo#n; text it cannot read stays text", async () => {
    stubFetch({ "/api/config": CONFIG });
    render(
      <>
        <TicketRef ticket="shop-app#3349" />
        <TicketRef ticket="<b>x</b>" />
      </>,
    );
    expect((await screen.findByRole("link", { name: "shop-app #3349" })).getAttribute("href")).toBe(
      "https://github.com/octo-org/shop-app/issues/3349",
    );
    expect(screen.getByText("<b>x</b>")).toBeTruthy();
  });
});

describe("one repo, one colour", () => {
  it("is the same on Comms and on Flight", async () => {
    const row = seatRow({ run: crewRow().run, ticket: "site-builder#5", hudState: "running" });
    stubFetch({
      "/api/attention": [
        item({
          key: "pr:site-builder#3756",
          kind: "pr",
          repoId: "site-builder",
          escalationId: null,
          text: "PR #3756 · You: decide on the draft",
          url: "https://github.com/octo-org/site-builder/pull/3756",
          ticket: "site-builder#5",
        }),
      ],
      "/api/crew": { rows: [row], firstRunToday: null },
      "/api/config": CONFIG,
    });
    const comms = render(<Comms item={null} />);
    await screen.findByRole("link", { name: "site-builder PR #3756" });
    const onComms = comms.container.querySelector<HTMLElement>("#cNeeds .rchip");
    expect(onComms?.textContent).toBe("site-builder");
    const colour = onComms?.style.getPropertyValue("--c");
    expect(colour).toBe("var(--r2)");
    comms.unmount();

    const flight = render(<Flight />);
    const list = await screen.findByRole("list", { name: "Crew runs" });
    await within(list).findByRole("link", { name: "site-builder #5" });
    expect(
      flight.container.querySelector<HTMLElement>("#wifP .rchip")?.style.getPropertyValue("--c"),
    ).toBe(colour);
  });
});

describe("Needs you", () => {
  it("links a PR item's 'PR #3756' to the pull request, repo from the item", async () => {
    stubFetch({
      "/api/attention": [
        item({
          key: "pr:site-builder#3756",
          kind: "pr",
          repoId: "site-builder",
          agentId: null,
          escalationId: null,
          text: "PR #3756 · You: decide on the draft",
          url: "https://github.com/octo-org/site-builder/pull/3756",
          at: NOW,
        }),
      ],
      "/api/crew": { rows: [], firstRunToday: null },
      "/api/config": CONFIG,
    });
    render(<Comms item={null} />);
    const link = await screen.findByRole("link", { name: "site-builder PR #3756" });
    expect(link.getAttribute("href")).toBe("https://github.com/octo-org/site-builder/pull/3756");
    expect(screen.getByText(/You: decide on the draft/)).toBeTruthy();
  });
});
