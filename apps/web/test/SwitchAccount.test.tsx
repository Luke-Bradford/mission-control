import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Header } from "../src/agent/Header.tsx";
import { hub } from "../src/data.ts";
import { Toast } from "../src/shell/Toast.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, NOW, seatRow } from "./fixtures.ts";

const row = seatRow({ accountId: "orbit" });
const accounts = ["orbit", "nova", "comet"].map((id) => ({
  id,
  vendor: "codex" as const,
  alertAt: 80,
  stopAt: 100,
}));
async function setup(
  result: unknown = { outcome: "resumed" },
  status: unknown = [
    { accountId: "nova", provider: "codex", binding: "profile", status: "logged-in" },
    { accountId: "comet", provider: "codex", binding: "profile", status: "not-logged-in" },
  ],
  configured = [
    ...accounts,
    { ...accounts[0], id: "other", vendor: "claude" as "claude" | "codex" },
  ],
) {
  const fetch = stubFetch({
    "/api/config": {
      ...CONFIG,
      accounts: configured,
    },
    "/api/accounts/status": status,
    "POST /api/seats/guido-1/transfer": result,
  });
  render(
    <>
      <Header row={row} limits={[]} now={NOW} />
      <Toast />
    </>,
  );
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Switch account" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
  return fetch;
}
afterEach(() => vi.unstubAllGlobals());

it("filters compatible accounts, shows CLI availability and hints without a login flow", async () => {
  const fetch = await setup();
  const select = (await screen.findByRole("combobox", { name: "Account" })) as HTMLSelectElement;
  await waitFor(() => expect(select.options.length).toBe(3));
  expect(document.activeElement).toBe(select);
  expect([...select.options].map((o) => o.value)).toEqual(["", "nova", "comet"]);
  expect(screen.getByRole("status").textContent).toContain("GUIDO-1: pick another codex account.");
  fireEvent.change(select, { target: { value: "comet" } });
  expect(screen.getByText(/Sign in with the codex CLI on this machine/)).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Transfer account" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(fetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.keyDown(select, { key: "Escape" });
  expect(screen.queryByRole("combobox", { name: "Account" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Switch account" }));
});

it.each([
  ["resumed", "resumed on nova"],
  ["fresh", "started fresh on nova with a handoff brief"],
])("reports %s and refreshes data only after the explicit transfer", async (outcome, message) => {
  let finish!: (r: Response) => void;
  const fetch = await setup();
  const original = fetch.getMockImplementation();
  if (!original) throw new Error("Missing fetch stub");
  fetch.mockImplementation((path, init) =>
    init?.method === "POST"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : original(path, init),
  );
  const refresh = vi.spyOn(hub, "refetch");
  fireEvent.change(await screen.findByRole("combobox", { name: "Account" }), {
    target: { value: "nova" },
  });
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Transfer account" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.submit(screen.getByRole("form", { name: "Switch account" }));
  expect(screen.getByText("Transferring account…")).toBeTruthy();
  expect(screen.getByTitle(/^orbit ·/)).toBeTruthy();
  await act(async () => finish(new Response(JSON.stringify({ outcome }))));
  expect(await screen.findByText(new RegExp(message))).toBeTruthy();
  expect(fetch).toHaveBeenCalledWith(
    "/api/seats/guido-1/transfer",
    expect.objectContaining({ body: JSON.stringify({ accountId: "nova" }) }),
  );
  expect(refresh.mock.calls.map(([p]) => p)).toEqual(
    expect.arrayContaining(["/api/crew?shape=summary", "/api/config", "/api/accounts/status"]),
  );
});

it.each([
  { outcome: "refused", reason: "seat is busy" },
  () => ({ status: 500, body: { error: "transfer failed" } }),
])("keeps the account unchanged on refusal or failure", async (result) => {
  await setup(result);
  fireEvent.change(await screen.findByRole("combobox", { name: "Account" }), {
    target: { value: "nova" },
  });
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Transfer account" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.submit(screen.getByRole("form", { name: "Switch account" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/seat is busy|transfer failed/);
  expect(screen.getByTitle(/^orbit ·/)).toBeTruthy();
});

it("shows loading and failed availability with retry", async () => {
  const fetch = await setup(undefined, () => ({ status: 503, body: { error: "CLI unavailable" } }));
  expect(screen.getByText("Loading accounts…")).toBeTruthy();
  expect((await screen.findByRole("alert")).textContent).toContain("CLI unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(fetch.mock.calls.filter(([p]) => p === "/api/accounts/status").length).toBe(2),
  );
});

it("shows an empty compatible list", async () => {
  await setup(undefined, [], [accounts[0]]);
  expect(await screen.findByText("No other compatible accounts configured.")).toBeTruthy();
});

it.each([
  { status: [] },
  { status: [{ accountId: "nova", provider: "codex", status: "unknown" }] },
])("does not transfer when CLI availability is unknown or missing", async ({ status }) => {
  await setup(undefined, status);
  fireEvent.change(screen.getByRole("combobox", { name: "Account" }), {
    target: { value: "nova" },
  });
  await screen.findByText(/Sign in with the codex CLI/);
  expect(
    (screen.getByRole("button", { name: "Transfer account" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

it("excludes same-provider Claude accounts because the server cannot isolate their logins", async () => {
  await setup(
    undefined,
    [],
    accounts.map((a) => ({ ...a, vendor: "claude" })),
  );
  expect(await screen.findByText("No other compatible accounts configured.")).toBeTruthy();
});

it("reports a failed config load and lets the operator retry", async () => {
  const fetch = stubFetch({
    "/api/config": () => ({ status: 503, body: { error: "Config unavailable" } }),
  });
  render(<Header row={row} limits={[]} now={NOW} />);
  expect((await screen.findByRole("alert")).textContent).toContain("Config unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry accounts" }));
  await waitFor(() => expect(fetch.mock.calls.filter(([p]) => p === "/api/config").length).toBe(2));
});

it.each([true, false])("forces fresh CLI readings on retry (success: %s)", async (success) => {
  const fetch = await setup();
  const original = fetch.getMockImplementation();
  if (!original) throw new Error("Missing fetch stub");
  let finish!: (response: Response) => void;
  let checked = false;
  fetch.mockImplementation((path, init) => {
    if (path === "/api/accounts/comet/check") {
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    if (path === "/api/accounts/nova/check") {
      return Promise.resolve(
        new Response(JSON.stringify({ accountId: "nova", status: "logged-in" })),
      );
    }
    if (path === "/api/accounts/status" && checked) {
      return Promise.resolve(
        new Response(
          JSON.stringify([{ accountId: "comet", provider: "codex", status: "logged-in" }]),
        ),
      );
    }
    return original(path, init);
  });
  fireEvent.change(await screen.findByRole("combobox", { name: "Account" }), {
    target: { value: "comet" },
  });
  await screen.findByText(/Sign in with the codex CLI/);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/api/accounts/comet/check",
      expect.objectContaining({ method: "POST" }),
    ),
  );
  expect(
    (screen.getByRole("button", { name: "Transfer account" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(screen.getByText("Checking accounts…")).toBeTruthy();
  await act(async () => {
    checked = success;
    finish(
      new Response(
        JSON.stringify(
          success ? { accountId: "comet", status: "logged-in" } : { error: "CLI check failed" },
        ),
        { status: success ? 200 : 503 },
      ),
    );
  });
  if (success) {
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Transfer account" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  } else {
    expect((await screen.findByRole("alert")).textContent).toContain("CLI check failed");
    expect(
      (screen.getByRole("button", { name: "Transfer account" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  }
  expect(screen.getByTitle(/^orbit ·/)).toBeTruthy();
  expect(fetch.mock.calls.some(([path]) => path === "/api/seats/guido-1/transfer")).toBe(false);
  expect(
    fetch.mock.calls.some(
      ([path]) => path === "/api/accounts/other/check" || path === "/api/accounts/orbit/check",
    ),
  ).toBe(false);
});
