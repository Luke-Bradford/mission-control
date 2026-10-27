import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Accounts } from "../src/setup/Accounts.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG } from "./fixtures.ts";

const status = {
  accountId: "claude-main",
  provider: "claude" as const,
  binding: "machine" as const,
  identity: "Fictional operator",
  plan: "team",
  status: "logged-in" as const,
  checkedAt: 1792756800000,
  detail: null,
};
const models = {
  accountId: "claude-main",
  models: [{ id: "sonnet", efforts: ["medium"] }],
  checkedAt: Date.now(),
  error: null,
};
function load(extra: Record<string, unknown> = {}) {
  return stubFetch({
    "/api/accounts/status": [status],
    "/api/limits": [],
    "/api/accounts/claude-main/models": models,
    "/api/accounts/codex-main/models": { ...models, accountId: "codex-main" },
    ...extra,
  });
}

it("shows the nine-column account table, concise login, relative model check and actions", async () => {
  load();
  render(
    <Accounts
      config={{
        ...CONFIG,
        accounts: [CONFIG.accounts[0], { ...CONFIG.accounts[1], cliProfile: "/profiles/codex" }],
      }}
    />,
  );
  await screen.findByText("signed in");
  expect(screen.getByText("machine login (one per machine)")).toBeTruthy();
  expect(screen.getByText("/profiles/codex")).toBeTruthy();
  expect(screen.getByTitle("Fictional operator")).toBeTruthy();
  expect(screen.getByText("signed in")).toBeTruthy();
  expect(screen.getAllByText(/1 model/)).toHaveLength(2);
  expect(screen.queryByText(/T\d{2}:\d{2}:\d{2}/)).toBeNull();
  expect(screen.getAllByText(/checked (just now|\d+ min ago|\d+ h ago)/)).toHaveLength(2);
  expect(
    within(screen.getByRole("table"))
      .getAllByRole("columnheader")
      .map((header) => header.textContent),
  ).toEqual(["Name", "Vendor", "Login", "Models", "5h", "7d", "Resets", "Alert / stop", "Actions"]);
  expect(screen.getAllByRole("button", { name: "Refresh" })).toHaveLength(2);
  expect(screen.getAllByRole("button", { name: "Sign in again" })).toHaveLength(2);
});

it("refreshes models and saves a profile-aware Codex account", async () => {
  const fetch = load({
    "/api/config": CONFIG,
    "POST /api/accounts": { account: {} },
    "POST /api/accounts/claude-main/models/refresh": models,
  });
  render(<Accounts config={CONFIG} />);
  fireEvent.click(
    (await screen.findAllByRole("button", { name: "Refresh" }))[0] as HTMLButtonElement,
  );
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/api/accounts/claude-main/models/refresh",
      expect.anything(),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: /Add account/ }));
  const dialog = screen.getByRole("dialog", { name: "Add account" });
  fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "codex-work" } });
  fireEvent.change(within(dialog).getByLabelText(/Login profile folder/), {
    target: { value: "/profiles/codex-work" },
  });
  fireEvent.submit(
    within(dialog).getByRole("button", { name: "Save account" }).closest("form") as HTMLFormElement,
  );
  await waitFor(() =>
    expect(
      fetch.mock.calls.some(
        ([path, init]) =>
          path === "/api/accounts" &&
          JSON.parse((init as RequestInit).body as string).cliProfile === "/profiles/codex-work",
      ),
    ).toBe(true),
  );
});

it("edits thresholds and makes the removal request", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  const fetch = load({
    "/api/config": CONFIG,
    "PUT /api/accounts/claude-main": { account: {} },
    "DELETE /api/accounts/claude-main": {
      status: 409,
      body: { error: "account is in use by loop shop-app-ta" },
    },
  });
  render(<Accounts config={CONFIG} />);
  fireEvent.click((await screen.findAllByRole("button", { name: "Edit" }))[0] as HTMLButtonElement);
  const dialog = screen.getByRole("dialog", { name: "Edit account" });
  fireEvent.change(within(dialog).getByLabelText("Alert at"), { target: { value: "70" } });
  fireEvent.submit(
    within(dialog).getByRole("button", { name: "Save account" }).closest("form") as HTMLFormElement,
  );
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/api/accounts/claude-main",
      expect.objectContaining({ method: "PUT" }),
    ),
  );
  fireEvent.click(
    (await screen.findAllByRole("button", { name: "Remove" }))[0] as HTMLButtonElement,
  );
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/api/accounts/claude-main",
      expect.objectContaining({ method: "DELETE" }),
    ),
  );
  confirm.mockRestore();
});
