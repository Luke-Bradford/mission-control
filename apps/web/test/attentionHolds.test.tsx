import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { holdConditionText } from "../src/flight/HeldNeeds.tsx";
import { NeedsYouTab } from "../src/flight/NeedsYouTab.tsx";
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
