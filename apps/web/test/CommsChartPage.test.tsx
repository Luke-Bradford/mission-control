import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { CommsChartPage } from "../src/pages/CommsChartPage.tsx";
import { stubFetch } from "./fetchStub.ts";
import { seatRow } from "./fixtures.ts";

afterEach(() => {
  hub.clear();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const rows = [
  seatRow({ id: "flight-1", index: 0, role: "FLIGHT" }),
  seatRow({ id: "guido-1", index: 1 }),
  seatRow({ id: "retro-1", index: 2, role: "RETRO" }),
];

function open(search = "") {
  window.history.replaceState(null, "", `/comms/chart${search}`);
  stubFetch({
    "/api/crew?shape=summary": { rows, firstRunToday: null },
    "/api/flight": { seat: { id: "flight-1" }, decisions: [] },
    "/api/comms/links": { links: [{ from: "guido-1", to: "retro-1", count: 3 }] },
    "/api/comms/open": { items: [] },
    "/api/comms/feed": { messages: [] },
  });
  return render(<CommsChartPage />);
}

it("narrows to a seat on a click and clears on a second click of the same seat", async () => {
  open();
  fireEvent.click(await screen.findByRole("button", { name: /^guido-1,/i }));
  await waitFor(() => expect(window.location.search).toBe("?focus=seat%3Aguido-1"));
  expect(await screen.findByRole("complementary", { name: /conversation/i })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^guido-1,/i }));
  await waitFor(() => expect(window.location.search).toBe(""));
  expect(screen.queryByRole("complementary", { name: /conversation/i })).toBeNull();
});

it("narrows to a link, and a second click on it clears", async () => {
  open();
  fireEvent.click(await screen.findByRole("button", { name: /^guido-1 ↔ retro-1,/i }));
  await waitFor(() => expect(window.location.search).toBe("?focus=pair%3Aguido-1%2Cretro-1"));
  fireEvent.click(screen.getByRole("button", { name: /^guido-1 ↔ retro-1,/i }));
  await waitFor(() => expect(window.location.search).toBe(""));
});

it("starts narrowed when opened with a filter in the address, and Escape clears it", async () => {
  open("?focus=seat:retro-1");
  expect(await screen.findByRole("complementary", { name: /conversation/i })).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(window.location.search).toBe(""));
});

it("links back to Comms", async () => {
  open();
  expect((await screen.findByRole("link", { name: /← comms/i })).getAttribute("href")).toBe(
    "/comms",
  );
});
