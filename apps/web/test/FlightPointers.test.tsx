import type { FlightPointer } from "@mc/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { pointerLink } from "../src/flight/page/pointerLink.ts";
import { Flight } from "../src/pages/Flight.tsx";
import { agentPath, boardPath, PAGE_PATHS, ticketPath } from "../src/router.ts";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, MIN, NOW } from "./fixtures.ts";
import { flightPageApi } from "./flightPageFixtures.ts";
import { ledgerEntry } from "./flightSummaryFixture.ts";

const ptr = (kind: FlightPointer["kind"], target: string): FlightPointer => ({
  kind,
  target,
  changedAt: NOW - 5 * MIN,
  change: "CI passed",
  readAt: null,
});

describe("pointerLink", () => {
  it("opens a ticket's page, with GitHub beside it", () => {
    expect(pointerLink(ptr("ticket", "shop-app#12"), CONFIG)).toEqual({
      kind: "Ticket",
      label: "shop-app #12",
      to: ticketPath("shop-app", 12),
      href: "https://github.com/octo-org/shop-app/issues/12",
    });
  });

  it("opens a PR on GitHub", () => {
    expect(pointerLink(ptr("pr", "shop-app#40"), CONFIG)).toEqual({
      kind: "PR",
      label: "shop-app PR #40",
      to: null,
      href: "https://github.com/octo-org/shop-app/pull/40",
    });
  });

  it("opens a seat's Agent page, a repo's board, a person on GitHub and metrics on Telemetry", () => {
    expect(pointerLink(ptr("seat", "guido-1"), CONFIG)).toMatchObject({
      kind: "Seat",
      label: "guido-1",
      to: agentPath("guido-1"),
    });
    expect(pointerLink(ptr("repo", "site-builder"), CONFIG)).toMatchObject({
      kind: "Repo",
      label: "site-builder",
      to: boardPath("site-builder"),
    });
    expect(pointerLink(ptr("person", "octocat"), CONFIG)).toMatchObject({
      kind: "Person",
      label: "octocat",
      to: null,
      href: "https://github.com/octocat",
    });
    expect(pointerLink(ptr("metric", "ci-failures"), CONFIG)).toMatchObject({
      kind: "Metric",
      label: "ci-failures",
      to: PAGE_PATHS.telemetry,
    });
  });

  it("links nothing when the target is not one it can open", () => {
    for (const p of [
      ptr("ticket", "nowhere#3"),
      ptr("pr", "not a ref"),
      ptr("repo", "unknown-repo"),
      ptr("person", "javascript:alert(1)"),
      ptr("seat", "a/b"),
    ]) {
      const link = pointerLink(p, CONFIG);
      expect(link.to, p.target).toBeNull();
      expect(link.href, p.target).toBeNull();
      expect(link.label).toBe(p.target);
    }
    // Without the config, a ticket still opens in the app but has no GitHub link.
    expect(pointerLink(ptr("ticket", "shop-app#12"), undefined)).toMatchObject({
      to: null,
      href: null,
    });
  });
});

describe("the Watching tab's pointers", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    window.history.replaceState(null, "", "/flight#pointersP");
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    hub.clear();
    window.history.replaceState(null, "", "/");
  });

  it("names what each pointer is for and links the thing it watches", async () => {
    const entry = ledgerEntry({
      key: "work:9",
      title: "Land the summary fix",
      pointers: [ptr("ticket", "shop-app#12"), ptr("pr", "shop-app#40"), ptr("repo", "gone")],
    });
    stubFetch(
      flightPageApi("running", {
        "/api/flight/ledger?status=open": {
          session: "s1",
          entries: [entry],
          more: false,
          nextOffset: null,
        },
      }),
    );
    render(<Flight />);
    const panel = await screen.findByRole("region", { name: /Pointers/ });
    const rows = await within(panel).findAllByRole("listitem");
    expect(rows).toHaveLength(3);
    const [ticket, pr, gone] = rows as [HTMLElement, HTMLElement, HTMLElement];
    expect(ticket.textContent).toContain("Land the summary fix");
    expect(ticket.textContent).toContain("Ticket");
    const open = within(ticket).getByRole("link", { name: "shop-app #12" });
    expect(open.getAttribute("href")).toBe(ticketPath("shop-app", 12));
    open.focus();
    expect(document.activeElement).toBe(open);
    expect(
      within(ticket).getByRole("link", { name: "shop-app #12 on GitHub" }).getAttribute("href"),
    ).toBe("https://github.com/octo-org/shop-app/issues/12");
    expect(
      within(pr).getByRole("link", { name: "shop-app PR #40" }).getAttribute("href"),
    ).toBe("https://github.com/octo-org/shop-app/pull/40");
    // A target with no page says so, as text.
    expect(within(gone).queryByRole("link")).toBeNull();
    expect(gone.textContent).toContain("gone");
    expect(gone.textContent).toContain("no page to open");
    fireEvent.click(open);
    expect(window.location.pathname).toBe(ticketPath("shop-app", 12));
  });
});
