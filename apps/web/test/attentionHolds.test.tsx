import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { holdConditionText } from "../src/flight/HeldNeeds.tsx";
import { NeedsYouTab } from "../src/flight/NeedsYouTab.tsx";
import { HoldItem } from "../src/needs/HoldItem.tsx";
import { Needs } from "../src/pages/Needs.tsx";
import { stubFetch } from "./fetchStub.ts";
import { item } from "./fixtures.ts";

it("lists a held item with its reason and condition, and Release returns it to Needs you", async () => {
  let released = false;
  const held = item({
    key: "held-demo",
    text: "Choose",
    hold: {
      reason: "Waiting",
      condition: { kind: "ticket", ticket: "mc#9" },
      by: "operator",
      at: 1,
    },
  });
  const fetch = stubFetch({
    "/api/attention/held": () => ({ status: 200, body: released ? [] : [held] }),
    "/api/attention": () => ({ status: 200, body: released ? [{ ...held, hold: undefined }] : [] }),
    "/api/notifications": { open: [], handledToday: [] },
    "POST /api/attention/held-demo/hold/release": () => {
      released = true;
      return { status: 200, body: { ok: true } };
    },
  });
  render(
    <>
      <NeedsYouTab />
      <Needs item={null} />
    </>,
  );
  const row = await screen.findByTestId("held-row");
  expect(row.textContent).toContain("Choose");
  expect(row.textContent).toContain("Waiting · until mc#9 merges");
  fireEvent.click(screen.getByRole("button", { name: "Release" }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith("/api/attention/held-demo/hold/release", expect.anything()),
  );
  await waitFor(() => expect(screen.queryByTestId("held-row")).toBeNull());
  expect(
    ((await screen.findAllByRole("link", { name: /Choose/ }))[0] as HTMLElement).getAttribute(
      "href",
    ),
  ).toBe("/needs-you/held-demo");
});

it("words each release condition", () => {
  expect(holdConditionText({ kind: "manual" }, null)).toBe("until you release it");
  expect(holdConditionText({ kind: "crew" }, null)).toBe("until the crew resumes");
  expect(holdConditionText({ kind: "date", at: 1 }, null)).toBe("until a set date");
});

const holdPosts = (fetch: ReturnType<typeof stubFetch>) =>
  fetch.mock.calls.filter(
    ([p, init]) => p === "/api/attention/hold-me/hold" && init?.method === "POST",
  );

it("a bad ticket does not block manual mode", async () => {
  const fetch = stubFetch({ "POST /api/attention/hold-me/hold": { ok: true } });
  render(<HoldItem item={item({ key: "hold-me" })} />);
  fireEvent.click(screen.getByRole("button", { name: "Hold" }));
  fireEvent.click(screen.getByRole("radio", { name: "Until a ticket merges" }));
  fireEvent.change(screen.getByLabelText("Ticket"), { target: { value: "bad" } });
  fireEvent.click(screen.getByRole("radio", { name: "Until you release it" }));
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: " Waiting " } });
  fireEvent.click(screen.getByRole("button", { name: "Save hold" }));
  await waitFor(() => expect(holdPosts(fetch)).toHaveLength(1));
  expect(JSON.parse(String(holdPosts(fetch)[0]?.[1]?.body))).toEqual({
    reason: "Waiting",
    condition: { kind: "manual" },
  });
});

it("a bad ticket blocks ticket mode and links to its field", async () => {
  const fetch = stubFetch({});
  render(<HoldItem item={item({ key: "hold-me" })} />);
  fireEvent.click(screen.getByRole("button", { name: "Hold" }));
  fireEvent.click(screen.getByRole("radio", { name: "Until a ticket merges" }));
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Waiting" } });
  fireEvent.change(screen.getByLabelText("Ticket"), { target: { value: "bad" } });
  fireEvent.click(screen.getByRole("button", { name: "Save hold" }));
  fireEvent.click(await screen.findByRole("link", { name: /repo#number/ }));
  expect(document.activeElement).toBe(screen.getByLabelText("Ticket"));
  expect(holdPosts(fetch)).toHaveLength(0);
});

it("a double submit posts once and a refusal shows the server's reason and keeps the entries", async () => {
  let reply: (v: { status: number; body: unknown }) => void = () => {};
  const fetch = stubFetch({
    "POST /api/attention/hold-me/hold": () => new Promise((r) => (reply = r)),
  });
  render(<HoldItem item={item({ key: "hold-me" })} />);
  fireEvent.click(screen.getByRole("button", { name: "Hold" }));
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Waiting" } });
  const save = screen.getByRole("button", { name: "Save hold" });
  fireEvent.click(save);
  fireEvent.click(save);
  expect(holdPosts(fetch)).toHaveLength(1);
  expect(await screen.findByRole("status")).toBeTruthy();
  reply({
    status: 409,
    body: { error: "That item waits on this one, so neither would ever release." },
  });
  expect(await screen.findByText(/neither would ever release/)).toBeTruthy();
  expect((screen.getByLabelText("Reason") as HTMLTextAreaElement).value).toBe("Waiting");
});
