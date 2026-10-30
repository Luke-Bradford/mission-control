import { describe, expect, it } from "vitest";
import { buildEntries, filterEntries, fuzzyScore } from "../src/palette/entries.ts";
import { boardItem, crewRow, item } from "./fixtures.ts";

describe("fuzzyScore", () => {
  it("matches a subsequence, case-insensitively, and rejects the rest", () => {
    expect(fuzzyScore("tlm", "Telemetry")).not.toBeNull();
    expect(fuzzyScore("TELE", "telemetry")).not.toBeNull();
    expect(fuzzyScore("xyz", "Telemetry")).toBeNull();
  });

  it("ranks a prefix above a word start above a scattered match", () => {
    const prefix = fuzzyScore("tele", "Telemetry") ?? 0;
    const word = fuzzyScore("tele", "Show telemetry") ?? 0;
    const scattered = fuzzyScore("tele", "Tab elements list") ?? 0;
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(scattered);
  });

  it("needs every word of the query to match", () => {
    expect(fuzzyScore("shop 3349", "shop-app#3349 Quote cache")).not.toBeNull();
    expect(fuzzyScore("shop 9999", "shop-app#3349 Quote cache")).toBeNull();
  });

  it("an empty query matches everything", () => {
    expect(fuzzyScore("  ", "anything")).toBe(0);
  });
});

const sources = {
  rows: [
    crewRow({ id: "shop-app-ta", paused: false }),
    crewRow({ id: "api-ta", repoId: "api", paused: true }),
    crewRow({ id: "studio-1", loopKind: "studio-loop", paused: false }),
  ],
  tickets: [
    boardItem({ issueNumber: 3349, title: "Quote cache" }),
    boardItem({ issueNumber: 12, title: "Closed one", closed: true }),
  ],
  prs: [
    {
      repoId: "shop-app",
      number: 77,
      title: "Cache the quote",
      url: "https://github.com/octo-org/shop-app/pull/77",
      ticket: "shop-app#3349",
      state: "open",
    },
    {
      repoId: "shop-app",
      number: 70,
      title: "Merged already",
      url: "https://github.com/octo-org/shop-app/pull/70",
      ticket: null,
      state: "merged",
    },
  ],
  comms: [
    {
      agentId: "shop-app-dev",
      data: {
        messages: [
          {
            id: "m1",
            at: 1,
            from: "shop-app-dev",
            to: "shop-app-rev",
            text: "Pushed the quote cache fix",
            ticket: "shop-app#3349",
            label: null,
            ref: "#3349",
            replyTo: null,
            mentions: [],
            reactions: [],
            operator: false,
          },
        ],
        inbox: [],
        contacts: [{ id: "shop-app-rev", lastMessage: null, count: 1, unread: 0 }],
      },
    },
  ],
  threads: [item({ key: "esc:shop-app#4001", text: "Choose a cache eviction policy" })],
  freeSeatFor: (repoId: string) => (repoId === "shop-app" ? "shop-app-dev" : null),
} as const;

describe("buildEntries", () => {
  const entries = buildEntries(sources as never);
  const find = (id: string) => entries.find((e) => e.id === id);

  it("lists the nine pages, open tickets, open PRs and threads, and seats", () => {
    expect(entries.filter((e) => e.group === "Page")).toHaveLength(9);
    expect(find("ticket:shop-app#3349")).toBeTruthy();
    expect(find("ticket:shop-app#12")).toBeUndefined();
    expect(find("pr:shop-app#77")).toBeTruthy();
    expect(find("pr:shop-app#70")).toBeUndefined();
    expect(find("need:esc:shop-app#4001")).toBeTruthy();
    expect(find("seat:api-ta")).toBeTruthy();
  });

  it("lists Comms conversations that have no attention item: the channels, a seat, a contact pair, a ticket thread", () => {
    expect(find("comms:flight")).toBeTruthy();
    expect(find("comms:crew")).toBeTruthy();
    expect(find("comms:agent:shop-app-dev")).toBeTruthy();
    expect(find("comms:contact:shop-app-dev:shop-app-rev")?.title).toContain("↔");
    expect(find("comms:ticket:#3349|shop-app#3349")).toBeTruthy();
  });

  it("an unlinked open PR is found by its number and its title", () => {
    const unlinked = buildEntries({
      prs: [
        {
          repoId: "shop-app",
          number: 88,
          title: "Tidy the footer",
          url: "https://github.com/octo-org/shop-app/pull/88",
          ticket: null,
          state: "open",
        },
      ],
    } as never);
    expect(filterEntries(unlinked, "88", [])[0]?.id).toBe("pr:shop-app#88");
    expect(filterEntries(unlinked, "footer", [])[0]?.id).toBe("pr:shop-app#88");
  });

  it("offers pause for a running loop, resume for a paused one, and nothing for a studio loop", () => {
    expect(find("action:pause:shop-app-ta")?.title).toMatch(/^Pause /);
    expect(find("action:resume:api-ta")?.title).toMatch(/^Resume /);
    expect(find("action:pause:api-ta")).toBeUndefined();
    expect(find("action:pause:studio-1")).toBeUndefined();
  });

  it("offers Start a seat only for an open ticket whose repo has a free seat", () => {
    expect(find("action:start:shop-app#3349")).toBeTruthy();
    expect(find("action:start:shop-app#12")).toBeUndefined();
  });
});

describe("filterEntries", () => {
  const entries = buildEntries(sources as never);

  it("finds a ticket by its number and a page by its name", () => {
    expect(filterEntries(entries, "3349", []).some((e) => e.id === "ticket:shop-app#3349")).toBe(
      true,
    );
    expect(filterEntries(entries, "audit", [])[0]?.id).toBe("page:audit");
  });

  it("an empty query lists the recent ids first (five at most), then the pages", () => {
    const recent = ["pr:shop-app#77", "page:setup", "gone:entry"];
    const out = filterEntries(entries, "", recent);
    expect(out.slice(0, 2).map((e) => e.id)).toEqual(["pr:shop-app#77", "page:setup"]);
    expect(out.filter((e) => e.group !== "Page").length).toBe(1);
  });
});
