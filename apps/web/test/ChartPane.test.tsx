import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChartPane } from "../src/comms/ChartPane.tsx";
import type { RailEdgeView } from "../src/comms/CommsRails.tsx";
import { commsHrefFor } from "../src/comms/chartPaths.ts";
import { pairFilter } from "../src/comms/commsFilter.ts";
import { hub } from "../src/data.ts";
import { stubFetch } from "./fetchStub.ts";

afterEach(() => {
  hub.clear();
  vi.unstubAllGlobals();
});

const FLIGHT = "flight-1";
const nameOf = (id: string) => id.toUpperCase();
const edge = (a: string, b: string, extra: Partial<RailEdgeView> = {}): RailEdgeView => ({
  key: `${a}\0${b}`,
  a,
  b,
  aToB: 2,
  bToA: 1,
  weight: 1,
  last: null,
  waiting: null,
  ...extra,
});
const message = (i: number, from: string, to: string) => ({
  id: `m${i}`,
  from,
  to,
  at: 1_000_000 + i * 1000,
  text: `Message ${i}`,
});

it("shows only the filtered conversation's messages, newest first, at most 15, and drops malformed rows", async () => {
  const inside = Array.from({ length: 17 }, (_, i) =>
    message(i, "dev-1", i % 2 ? "dev-2" : "crew"),
  );
  stubFetch({
    "/api/comms/feed": {
      messages: [
        ...inside,
        message(90, "dev-2", "dev-3"),
        { id: 5, from: "dev-1" },
        { id: "bad", from: "dev-1", to: "dev-2", at: "now", text: "x" },
      ],
    },
  });
  render(
    <ChartPane
      filter={{ kind: "seat", id: "dev-1" }}
      flight={FLIGHT}
      edges={[edge("dev-1", "dev-2"), edge("dev-2", "dev-3")]}
      nameOf={nameOf}
    />,
  );
  const list = await screen.findByRole("region", { name: "Recent messages" });
  await waitFor(() => expect(list.querySelectorAll("li")).toHaveLength(15));
  const texts = [...list.querySelectorAll("li q")].map((q) => q.textContent);
  expect(texts[0]).toBe("Message 16");
  expect(texts).not.toContain("Message 90");
  expect(texts).not.toContain("x");
});

it("opens the conversation in Comms, narrowed the same way", async () => {
  stubFetch({ "/api/comms/feed": { messages: [] } });
  const filter = pairFilter("dev-1", "dev-2");
  render(<ChartPane filter={filter} flight={FLIGHT} edges={[]} nameOf={nameOf} />);
  const link = await screen.findByRole("link", { name: /open in comms/i });
  expect(link.getAttribute("href")).toBe(commsHrefFor(filter, FLIGHT));
  expect(await screen.findByText(/no messages in this conversation/i)).toBeTruthy();
});

it("says so, and ends cut previews with an ellipsis, when the hub has no message feed", async () => {
  const long = "x".repeat(200);
  stubFetch({ "/api/comms/feed": () => ({ status: 404, body: { error: "not found" } }) });
  render(
    <ChartPane
      filter={{ kind: "seat", id: "dev-1" }}
      flight={FLIGHT}
      edges={[
        edge("dev-1", "dev-2", { last: { from: "dev-1", to: "dev-2", text: long, at: 5 } }),
        edge("dev-1", "dev-3", { last: { from: "dev-3", to: "dev-1", text: "short", at: 4 } }),
      ]}
      nameOf={nameOf}
    />,
  );
  const region = await screen.findByRole("region", { name: "Newest message on each link" });
  expect(within(region).getByRole("status").textContent).toMatch(/does not send the message feed/i);
  const texts = [...region.querySelectorAll("li q")].map((q) => q.textContent);
  expect(texts).toEqual([`${long}…`, "short"]);
});

it("shows loading and no fallback list while the feed is on its way", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    }),
  );
  render(
    <ChartPane
      filter={{ kind: "seat", id: "dev-1" }}
      flight={FLIGHT}
      edges={[edge("dev-1", "dev-2", { last: { from: "dev-1", to: "dev-2", text: "hi", at: 5 } })]}
      nameOf={nameOf}
    />,
  );
  expect(screen.getByText("Loading messages…")).toBeTruthy();
  expect(screen.queryByText("hi")).toBeNull();
  release();
  await waitFor(() => expect(screen.queryByText("Loading messages…")).toBeNull());
});

it("lists what is waiting in the conversation, with the question", async () => {
  stubFetch({ "/api/comms/feed": { messages: [] } });
  render(
    <ChartPane
      filter={{ kind: "seat", id: "dev-1" }}
      flight={FLIGHT}
      edges={[
        edge("dev-1", "dev-2", {
          waiting: { n: 2, ms: 125 * 60_000, asker: "dev-1", question: "Which branch?" },
        }),
      ]}
      nameOf={nameOf}
    />,
  );
  const waiting = await screen.findByRole("region", { name: "Waiting" });
  expect(waiting.textContent).toContain("DEV-1 waiting 2h 5m · 2 open");
  expect(waiting.textContent).toContain("Which branch?");
});
