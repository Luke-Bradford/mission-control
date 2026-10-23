import type { CommsThreadMessage } from "@mc/core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { hub, RESOURCES } from "../src/data.ts";
import { Comms } from "../src/pages/Comms.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, item, NOW, seatRow } from "./fixtures.ts";

const message = (id: string): CommsThreadMessage => ({
  id,
  at: NOW,
  from: "guido-1",
  to: "CAPCOM",
  ticket: null,
  text: `Report ${id} @CAPCOM`,
  tagged: true,
  direct: true,
  seen: false,
});

it("Read clears only the displayed snapshot, keeps other threads and concurrent replies, and reads new visible arrivals", async () => {
  let messages = [message("one")];
  const read = new Set<string>();
  const posts: string[][] = [];
  stubFetch({
    "/api/config": CONFIG,
    "/api/crew": { rows: [seatRow(), seatRow({ id: "retro-1", index: 1 })], firstRunToday: null },
    "/api/flight": { seat: null, decisions: [] },
    "/api/attention": () => ({
      status: 200,
      body: [
        ...(!read.has("one")
          ? [
              item({
                key: "tag:one",
                kind: "tag",
                agentId: "guido-1",
                escalationId: null,
                text: "Report one @CAPCOM",
              }),
            ]
          : []),
        item({
          key: "message:other",
          kind: "message",
          agentId: "retro-1",
          escalationId: null,
          text: "2 new on your direct line",
        }),
        ...(read.has("one") && !read.has("two")
          ? [
              item({
                key: "message:two",
                kind: "message",
                agentId: "guido-1",
                escalationId: null,
                text: "1 new on your direct line",
              }),
            ]
          : []),
      ],
    }),
    "/api/comms/guido-1": () => ({
      status: 200,
      body: { messages: messages.map((m) => ({ ...m, seen: read.has(m.id) })) },
    }),
    "POST /api/comms/guido-1/read": (init: RequestInit | undefined) => {
      const ids = JSON.parse(String(init?.body)).messageIds as string[];
      posts.push(ids);
      for (const id of ids) read.add(id);
      return { status: 200, body: { ok: true } };
    },
    "POST /api/attention/ack": { ok: true },
  });
  render(<Comms item={null} />);
  const need = (await screen.findByText("Report one @CAPCOM")).closest(".nrow") as HTMLElement;
  const threads = document.querySelector("#chanList") as HTMLElement;
  expect(
    within(threads).getByText("Tagged you").closest("button")?.classList.contains("tagged"),
  ).toBe(true);
  fireEvent.click(within(need).getByRole("button", { name: "Ack" }));
  await waitFor(() => expect(posts).toEqual([]));
  expect(within(threads).getByText("Tagged you")).toBeTruthy();
  const button = within(need).getByRole("button", { name: "Read" });
  button.focus();
  expect(document.activeElement).toBe(button);
  // Native buttons accept keyboard activation (a click with no pointer detail).
  fireEvent.click(button, { detail: 0 });
  await waitFor(() => expect(posts).toEqual([["one"]]));
  await waitFor(() => expect(within(threads).queryByText("Tagged you")).toBeNull());
  expect(await screen.findByText("2 new on your direct line")).toBeTruthy();
  expect(await screen.findByText("1 new on your direct line")).toBeTruthy();
  expect(document.querySelector("#convo .msg.tagged .mention")?.textContent).toBe("@CAPCOM");
  messages = [...messages, message("two")];
  hub.refetchTopic("agents");
  await waitFor(() => expect(posts).toEqual([["one"], ["two"]]));
  await waitFor(() => expect(screen.queryByText("1 new on your direct line")).toBeNull());
  expect(screen.getByText("2 new on your direct line")).toBeTruthy();
});

it.each(["empty", "failed"])(
  "handles loading and %s thread responses without a read write",
  async (state) => {
    const fetch = stubFetch({
      "/api/config": CONFIG,
      "/api/attention": [],
      "/api/crew": { rows: [seatRow()], firstRunToday: null },
      "/api/comms/guido-1":
        state === "empty"
          ? { messages: [] }
          : () => ({ status: 500, body: { error: "Unavailable" } }),
    });
    render(<Comms item={null} />);
    fireEvent.click(await screen.findByRole("button", { name: /^guido-1/ }));
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(
      await screen.findByText(state === "empty" ? "No messages yet." : "Could not load activity."),
    ).toBeTruthy();
    expect(fetch.mock.calls.some(([p]) => p.endsWith("/read"))).toBe(false);
    hub.refetch(RESOURCES.attention.path);
  },
);
