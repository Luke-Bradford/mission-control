import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CliAccountStatus } from "@mc/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { hub, RESOURCES } from "../src/data.ts";
import { Accounts } from "../src/setup/Accounts.tsx";
import { Toast } from "../src/shell/Toast.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG } from "./fixtures.ts";

const reading: CliAccountStatus = {
  accountId: "claude-main",
  provider: "claude",
  binding: "machine",
  identity: "Fictional operator",
  plan: "team",
  status: "logged-in",
  checkedAt: 1792756800000,
  detail: null,
};
function load(statuses: CliAccountStatus[] = [reading], extra: Record<string, unknown> = {}) {
  return stubFetch({ "/api/accounts/status": statuses, "/api/limits": [], ...extra });
}
it("shows machine CLI identity and plan for successful, logged-out and unknown readings", async () => {
  load([
    reading,
    {
      ...reading,
      accountId: "codex-main",
      provider: "codex",
      status: "not-logged-in",
      identity: null,
      plan: null,
    },
  ]);
  render(<Accounts config={CONFIG} />);
  expect(await screen.findByText("Fictional operator")).toBeTruthy();
  expect(screen.getByText("team")).toBeTruthy();
  expect(screen.getByText("Signed in")).toBeTruthy();
  expect(screen.getByText("Not signed in")).toBeTruthy();
  expect(screen.getByText(/Sign in with the CLI on this machine/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
});
it("checks with {}, disables while checking, refreshes then preserves a stale last reading on failure", async () => {
  let fail = false;
  const fetch = load([reading], {
    "POST /api/accounts/claude-main/check": () =>
      fail
        ? { status: 502, body: { error: "Status unavailable" } }
        : { status: 200, body: { ...reading, plan: "max", checkedAt: reading.checkedAt + 60000 } },
  });
  render(<Accounts config={CONFIG} />);
  await screen.findByText("team");
  const button = screen.getAllByRole("button", { name: "Check" })[0] as HTMLButtonElement;
  button.focus();
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  expect(button.disabled).toBe(true);
  expect(await screen.findByText("max")).toBeTruthy();
  expect(fetch).toHaveBeenCalledWith(
    "/api/accounts/claude-main/check",
    expect.objectContaining({ body: "{}", method: "POST" }),
  );
  fail = true;
  fireEvent.click(button);
  expect(await screen.findByText(/Stale · last checked/)).toBeTruthy();
  expect(screen.getByText("max")).toBeTruthy();
  expect(screen.getByText(/Status unavailable/)).toBeTruthy();
  expect(button.disabled).toBe(false);
});
it("labels an unknown CLI result and preserves earlier identity when a re-check cannot read status", async () => {
  load([reading], {
    "POST /api/accounts/claude-main/check": {
      ...reading,
      status: "unknown",
      identity: null,
      plan: null,
      detail: "CLI status unavailable",
    },
  });
  render(<Accounts config={CONFIG} />);
  await screen.findByText("team");
  fireEvent.click(screen.getAllByRole("button", { name: "Check" })[0] as HTMLButtonElement);
  expect(await screen.findByText(/Stale · last checked/)).toBeTruthy();
  expect(screen.getByText("Fictional operator")).toBeTruthy();
  expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0);
});
it("shows loading, empty readings, failed responses and an empty configured list", async () => {
  load([], { "/api/accounts/status": () => ({ status: 503, body: { error: "Unavailable" } }) });
  const view = render(<Accounts config={CONFIG} />);
  expect(screen.getByText("Loading account status…")).toBeTruthy();
  expect(await screen.findByText(/Could not load account status: Unavailable/)).toBeTruthy();
  expect(screen.getAllByText("Unknown")).toHaveLength(CONFIG.accounts.length);
  view.rerender(<Accounts config={{ ...CONFIG, accounts: [] }} />);
  expect(screen.getByText("No accounts configured.")).toBeTruthy();
});
it("adds only provider and short config name through a keyboard-submittable form; displays duplicate refusal", async () => {
  const fetch = load([], {
    "POST /api/accounts": () => ({
      status: 409,
      body: {
        error:
          "only one account per provider is supported until independent bindings are available",
      },
    }),
  });
  render(<Accounts config={CONFIG} />);
  fireEvent.click(screen.getByRole("button", { name: "Add account" }));
  const form = screen.getByRole("form", { name: "Add account" });
  fireEvent.change(within(form).getByLabelText("Provider"), { target: { value: "codex" } });
  fireEvent.change(within(form).getByLabelText("Short config name"), {
    target: { value: "codex-second" },
  });
  fireEvent.submit(form);
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/api/accounts",
      expect.objectContaining({
        body: JSON.stringify({ provider: "codex", name: "codex-second" }),
      }),
    ),
  );
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "only one account per provider is supported until independent bindings are available",
  );
  expect(form.querySelectorAll("input")).toHaveLength(1);
});
it("keeps the wide table inside a keyboard-focusable scroll region for narrow screens", async () => {
  load([]);
  render(<Accounts config={CONFIG} />);
  const css = readFileSync(join(import.meta.dirname, "../src/hud.css"), "utf8");
  expect(css.match(/\.tw \{([^}]+)\}/)?.[1]).toContain("overflow-x: auto");
  expect(css.match(/\.panel \{([^}]+)\}/)?.[1]).toContain("min-width: 0");
  const region = screen.getByRole("region", { name: "Account details" });
  expect(region.className).toContain("tw");
  expect(region.tabIndex).toBe(0);
  expect(within(region).getByRole("table")).toBeTruthy();
});

it("shows unknown initial CLI status and absent readings without inferring login", async () => {
  load([
    { ...reading, status: "unknown", identity: null, plan: null, detail: "CLI status unavailable" },
  ]);
  render(<Accounts config={CONFIG} />);
  await screen.findByText("CLI status unavailable");
  expect(screen.getAllByText("Unknown")).toHaveLength(CONFIG.accounts.length);
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(screen.getByText("Not checked")).toBeTruthy();
});
it("closes a successful config-only addition and refreshes config and statuses", async () => {
  const fetch = load([], {
    "/api/config": CONFIG,
    "POST /api/accounts": { account: { id: "codex-second", vendor: "codex" } },
  });
  render(<Accounts config={CONFIG} />);
  fireEvent.click(screen.getByRole("button", { name: "Add account" }));
  const form = screen.getByRole("form", { name: "Add account" });
  fireEvent.change(within(form).getByLabelText("Short config name"), {
    target: { value: "codex-second" },
  });
  fireEvent.submit(form);
  expect(within(form).getByRole("button", { name: "Adding…" })).toHaveProperty("disabled", true);
  await waitFor(() => expect(screen.queryByRole("form", { name: "Add account" })).toBeNull());
  expect(fetch.mock.calls.filter(([path]) => path === "/api/accounts/status")).toHaveLength(2);
});

it("announces a successful Check with the catalogue wording", async () => {
  load([reading], { "POST /api/accounts/claude-main/check": reading });
  render(
    <>
      <Toast />
      <Accounts config={CONFIG} />
    </>,
  );
  await screen.findByText("team");
  fireEvent.click(screen.getAllByRole("button", { name: "Check" })[0] as HTMLButtonElement);
  expect(
    await screen.findByText(
      "claude-main: signed in (checked with the provider's own status command).",
    ),
  ).toBeTruthy();
});

it("uses the newest checkedAt across Check and refreshed status lists", async () => {
  let listed = reading;
  load([], {
    "/api/accounts/status": () => ({ status: 200, body: [listed] }),
    "POST /api/accounts/claude-main/check": {
      ...reading,
      plan: "max",
      checkedAt: reading.checkedAt + 60000,
    },
  });
  render(<Accounts config={CONFIG} />);
  await screen.findByText("team");
  fireEvent.click(screen.getAllByRole("button", { name: "Check" })[0] as HTMLButtonElement);
  await screen.findByText("max");
  await act(async () => hub.refetchTopic("config"));
  expect(screen.getByText("max")).toBeTruthy();
  listed = {
    ...reading,
    checkedAt: reading.checkedAt + 120000,
    plan: "pro",
    identity: "New operator",
    status: "not-logged-in",
  };
  await act(async () => hub.refetchAll());
  expect(await screen.findByText("pro")).toBeTruthy();
  expect(screen.getByText("New operator")).toBeTruthy();
  expect(screen.getByText("Not signed in")).toBeTruthy();
});

it("makes a successful Check current despite a list error, preserving other accounts' stale readings", async () => {
  let fail = false;
  load([], {
    "/api/accounts/status": () =>
      fail
        ? { status: 503, body: { error: "List unavailable" } }
        : {
            status: 200,
            body: [reading, { ...reading, accountId: "codex-main", provider: "codex" }],
          },
    "POST /api/accounts/claude-main/check": {
      ...reading,
      plan: "max",
      checkedAt: reading.checkedAt + 60000,
    },
  });
  render(<Accounts config={CONFIG} />);
  await screen.findAllByText("team");
  fail = true;
  await act(async () => hub.refetch(RESOURCES.accountStatus.path));
  await screen.findByText(/Could not load account status: List unavailable/);
  fireEvent.click(screen.getAllByRole("button", { name: "Check" })[0] as HTMLButtonElement);
  await screen.findByText("max");
  const claude = screen.getByText("claude-main").closest("tr") as HTMLTableRowElement;
  const codex = screen.getByText("codex-main").closest("tr") as HTMLTableRowElement;
  expect(within(claude).queryByText(/Stale/)).toBeNull();
  expect(
    within(claude).getByText(`Checked ${new Date(reading.checkedAt + 60000).toISOString()}`),
  ).toBeTruthy();
  expect(within(codex).getByText(/Stale · last checked/)).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("List unavailable");
});
