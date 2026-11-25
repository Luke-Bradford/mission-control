import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UpdateLogModal } from "../src/setup/UpdateLog.tsx";
import { stubFetch } from "./fetchStub.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("says once that the log could not be read, without the hub's copy of the words", async () => {
  stubFetch({
    "/api/update/log": () => ({ status: 500, body: { error: "could not read update.log" } }),
  });
  render(<UpdateLogModal open onClose={() => {}} />);
  const dialog = await screen.findByRole("dialog", { name: "Update log" });
  expect(await within(dialog).findByText("Could not read update.log.")).toBeTruthy();
});

it("reads the log again on a bump while open, and leaves focus where it is", async () => {
  let n = 0;
  const fetch = stubFetch({
    "/api/update/log": () => {
      n += 1;
      return { status: 200, body: { text: `read ${n}\n` } };
    },
  });
  const { rerender } = render(
    <>
      <button type="button">Elsewhere</button>
      <UpdateLogModal open onClose={() => {}} read={0} />
    </>,
  );
  const dialog = await screen.findByRole("dialog", { name: "Update log" });
  expect(await within(dialog).findByText(/read 1/)).toBeTruthy();
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));
  const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
  elsewhere.focus();
  rerender(
    <>
      <button type="button">Elsewhere</button>
      <UpdateLogModal open onClose={() => {}} read={1} />
    </>,
  );
  expect(await within(dialog).findByText(/read 2/)).toBeTruthy();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(document.activeElement).toBe(elsewhere);
});
