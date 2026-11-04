import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Accounts } from "../src/setup/Accounts.tsx";
import { closeTopOverlay } from "../src/shell/overlays.ts";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, limit7d } from "./fixtures.ts";

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
  expect(screen.getByText(/never displays or stores credentials/)).toBeTruthy();
});

it("keeps the full quota forecast in a tooltip when the cell truncates it", async () => {
  load({
    "/api/limits": [limit7d({ accountId: "claude-main", projected: 100, fullAt: null })],
  });
  render(<Accounts config={CONFIG} />);
  const forecast = await screen.findByTitle("at this rate: reaches 100%");
  expect(forecast.textContent).toBe("at this rate: reaches 100%");
});

it("shows an operator-run sign-in command, copies it, and checks status and models again", async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const fetch = load({
    "POST /api/accounts/claude-main/check": status,
    "POST /api/accounts/claude-main/models/refresh": models,
  });
  render(<Accounts config={CONFIG} />);
  fireEvent.click((await screen.findAllByRole("button", { name: "Sign in again" }))[0]);
  const panel = screen.getByRole("region", { name: "Sign in again for claude-main" });
  expect(within(panel).getByText("claude login")).toBeTruthy();
  fireEvent.click(within(panel).getByRole("button", { name: "Copy" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("claude login"));
  fireEvent.click(within(panel).getByRole("button", { name: "Check again" }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/api/accounts/claude-main/check",
      expect.objectContaining({ method: "POST" }),
    ),
  );
  expect(fetch).toHaveBeenCalledWith(
    "/api/accounts/claude-main/models/refresh",
    expect.objectContaining({ method: "POST" }),
  );
});

it("uses the selected Codex profile in the operator command", async () => {
  load();
  render(
    <Accounts
      config={{
        ...CONFIG,
        accounts: [{ ...CONFIG.accounts[1], cliProfile: "/profiles/codex-work" }],
      }}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Sign in again" }));
  expect(
    screen.getByRole("region", { name: "Sign in again for codex-main" }).textContent,
  ).toContain("CODEX_HOME=/profiles/codex-work codex login");
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
  const modelCalls = () =>
    fetch.mock.calls.filter(([path]) => path === "/api/accounts/claude-main/models").length;
  const beforeEdit = modelCalls();
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
  await waitFor(() => expect(modelCalls()).toBeGreaterThan(beforeEdit));
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

describe("account editor: recoverable input", () => {
  const openAdd = async () => {
    const opener = await screen.findByRole("button", { name: /Add account/ });
    opener.focus();
    fireEvent.click(opener);
    return { opener, dialog: screen.getByRole("dialog", { name: "Add account" }) };
  };
  const openEdit = async () => {
    const opener = (await screen.findAllByRole("button", { name: "Edit" }))[0] as HTMLElement;
    opener.focus();
    fireEvent.click(opener);
    return { opener, dialog: screen.getByRole("dialog", { name: "Edit account" }) };
  };
  const posts = (fetch: ReturnType<typeof load>) =>
    fetch.mock.calls.filter(([, init]) => init?.method === "POST" || init?.method === "PUT");
  const submit = (dialog: HTMLElement) =>
    fireEvent.click(within(dialog).getByRole("button", { name: "Save account" }));
  const hold = (fetch: ReturnType<typeof load>, method: string, path: string) => {
    const real = fetch.getMockImplementation();
    if (!real) throw new Error("no stub");
    let release: (r: Response) => void = () => {};
    fetch.mockImplementation((p, init) =>
      p === path && init?.method === method
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : real(p, init),
    );
    return (status: number, body: unknown) =>
      release(new Response(JSON.stringify(body), { status }));
  };

  it("explains an invalid attempt in a focused summary that links to the field", async () => {
    const fetch = load();
    render(<Accounts config={CONFIG} />);
    const { dialog } = await openAdd();
    const save = within(dialog).getByRole("button", { name: "Save account" });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    submit(dialog);
    const summary = within(dialog).getByRole("region", { name: "Fix before saving" });
    expect(document.activeElement).toBe(summary);
    const name = within(dialog).getByLabelText("Name");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toContain(`${name.id}-error`);
    expect(document.getElementById(`${name.id}-error`)?.textContent).toMatch(/Name/);
    fireEvent.click(within(summary).getByRole("link", { name: /Name/ }));
    expect(document.activeElement).toBe(name);
    expect(posts(fetch)).toHaveLength(0);
    // codex needs a profile; claude does not and must not be blocked by the hidden field
    fireEvent.change(name, { target: { value: "codex-new" } });
    fireEvent.change(within(dialog).getByLabelText(/Login profile folder/), {
      target: { value: "x".repeat(4097) },
    });
    submit(dialog);
    expect(within(dialog).getByRole("link", { name: /at most 4096/ })).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Vendor"), { target: { value: "claude" } });
    expect(within(dialog).queryByLabelText(/Login profile folder/)).toBeNull();
    submit(dialog);
    await waitFor(() => expect(posts(fetch)).toHaveLength(1));
    expect(JSON.parse(String(posts(fetch)[0]?.[1]?.body))).toEqual({
      provider: "claude",
      name: "codex-new",
    });
  });

  it("checks the thresholds the server enforces and sends exactly them", async () => {
    const fetch = load({ "PUT /api/accounts/claude-main": { account: {} } });
    render(<Accounts config={CONFIG} />);
    const { dialog } = await openEdit();
    fireEvent.change(within(dialog).getByLabelText("Alert at"), { target: { value: "95" } });
    fireEvent.change(within(dialog).getByLabelText("Stop at"), { target: { value: "90" } });
    submit(dialog);
    expect(within(dialog).getByRole("link", { name: /alert.*stop/i })).toBeTruthy();
    expect(within(dialog).getByLabelText("Alert at").getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(within(dialog).getByLabelText("Stop at"), { target: { value: "101" } });
    submit(dialog);
    expect(within(dialog).getByRole("link", { name: /0 to 100/ })).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Stop at"), { target: { value: "99" } });
    submit(dialog);
    await waitFor(() => expect(posts(fetch)).toHaveLength(1));
    expect(posts(fetch)[0]?.[0]).toBe("/api/accounts/claude-main");
    expect(JSON.parse(String(posts(fetch)[0]?.[1]?.body))).toEqual({
      provider: "claude",
      alertAt: 95,
      stopAt: 99,
    });
  });

  it("keeps a refused edit's values and target, and a config refresh does not overwrite them", async () => {
    load({
      "PUT /api/accounts/claude-main": () => ({
        status: 400,
        body: { error: "alert must not exceed stop" },
      }),
    });
    const view = render(<Accounts config={CONFIG} />);
    const { dialog } = await openEdit();
    fireEvent.change(within(dialog).getByLabelText("Alert at"), { target: { value: "70" } });
    submit(dialog);
    const summary = await within(dialog).findByRole("region", { name: "Not saved" });
    expect(within(summary).getByRole("alert").textContent).toBe("alert must not exceed stop");
    expect(document.activeElement).toBe(summary);
    view.rerender(
      <Accounts
        config={{
          ...CONFIG,
          accounts: CONFIG.accounts.map((a) => ({ ...a, alertAt: 10, stopAt: 20 })),
        }}
      />,
    );
    expect(within(dialog).getByLabelText("Alert at")).toHaveProperty("value", "70");
    expect(within(dialog).getByRole("heading", { name: "Edit claude-main" })).toBeTruthy();
    expect((within(dialog).getByLabelText("Stop at") as HTMLInputElement).disabled).toBe(false);
  });

  it.each([401, 403, 409, 500])("shows a %i refusal as the server wrote it", async (status) => {
    load({
      "POST /api/accounts": () => ({ status, body: { error: `server said ${status}` } }),
    });
    render(<Accounts config={CONFIG} />);
    const { dialog } = await openAdd();
    fireEvent.change(within(dialog).getByLabelText("Vendor"), { target: { value: "claude" } });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "extra" } });
    submit(dialog);
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      `server said ${status}`,
    );
    expect(within(dialog).getByLabelText("Name")).toHaveProperty("value", "extra");
  });

  it("does not render an upstream HTML page as markup", async () => {
    const fetch = load();
    const real = fetch.getMockImplementation();
    fetch.mockImplementation(async (p, init) =>
      p === "/api/accounts" && init?.method === "POST"
        ? new Response("<h1>Bad gateway</h1>", { status: 502 })
        : (real?.(p, init) as Promise<Response>),
    );
    render(<Accounts config={CONFIG} />);
    const { dialog } = await openAdd();
    fireEvent.change(within(dialog).getByLabelText("Vendor"), { target: { value: "claude" } });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "extra" } });
    submit(dialog);
    await within(dialog).findByRole("alert");
    expect(dialog.querySelector("h1")).toBeNull();
  });

  it("keeps the entries and rereads saved state when the connection drops", async () => {
    const fetch = load();
    const real = fetch.getMockImplementation();
    fetch.mockImplementation((p, init) =>
      p === "/api/accounts" && init?.method === "POST"
        ? Promise.reject(new TypeError("Failed to fetch"))
        : (real?.(p, init) as Promise<Response>),
    );
    render(<Accounts config={CONFIG} />);
    const { dialog } = await openAdd();
    fireEvent.change(within(dialog).getByLabelText("Vendor"), { target: { value: "claude" } });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "extra" } });
    submit(dialog);
    const summary = await within(dialog).findByRole("region", { name: "Result unknown" });
    expect(summary.textContent).toMatch(/Failed to fetch/);
    expect(summary.textContent).toMatch(/check it before saving again/);
    expect(within(dialog).getByLabelText("Name")).toHaveProperty("value", "extra");
    expect(document.activeElement).toBe(summary);
  });

  it("posts once for Enter plus a click, and refuses Cancel and Escape while saving", async () => {
    const fetch = load({ "/api/config": CONFIG });
    const release = hold(fetch, "POST", "/api/accounts");
    render(<Accounts config={CONFIG} />);
    const { opener, dialog } = await openAdd();
    fireEvent.change(within(dialog).getByLabelText("Vendor"), { target: { value: "claude" } });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "extra" } });
    const form = dialog.querySelector("form") as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.click(within(dialog).getByRole("button", { name: "Saving…" }));
    expect(posts(fetch)).toHaveLength(1);
    expect(within(dialog).getByRole("status").textContent).toBe("Saving account…");
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).disabled).toBe(true);
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect((cancel as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(within(dialog).getByLabelText("Vendor"), { key: "Escape" });
    closeTopOverlay();
    expect(screen.getByRole("dialog", { name: "Add account" })).toBe(dialog);
    release(200, { account: {} });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts(fetch)).toHaveLength(1);
    expect(document.activeElement).toBe(opener);
  });

  it("holds the modal: initial focus, Tab wraps, Escape and Cancel close with no write", async () => {
    const fetch = load();
    render(<Accounts config={CONFIG} />);
    const { opener, dialog } = await openEdit();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(within(dialog).getByLabelText("Alert at"));
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    cancel.focus();
    fireEvent.keyDown(cancel, { key: "Tab" });
    expect(document.activeElement).toBe(within(dialog).getByLabelText("Alert at"));
    fireEvent.keyDown(cancel, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    const again = await openAdd();
    fireEvent.click(within(again.dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(posts(fetch)).toHaveLength(0);
    expect(document.activeElement).toBe(again.opener);
  });

  it("saves thresholds of a Codex account that has no profile", async () => {
    const fetch = load({ "PUT /api/accounts/codex-main": { account: {} } });
    render(<Accounts config={CONFIG} />);
    const opener = (await screen.findAllByRole("button", { name: "Edit" }))[1] as HTMLElement;
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Edit account" });
    fireEvent.change(within(dialog).getByLabelText("Alert at"), { target: { value: "60" } });
    submit(dialog);
    await waitFor(() => expect(posts(fetch)).toHaveLength(1));
    expect(JSON.parse(String(posts(fetch)[0]?.[1]?.body))).toEqual({
      provider: "codex",
      alertAt: 60,
      stopAt: 80,
    });
  });

  it("keeps Tab inside the modal even when focus is on the backdrop, and a late result cannot close another editor", async () => {
    const fetch = load();
    const release = hold(fetch, "PUT", "/api/accounts/claude-main");
    render(<Accounts config={CONFIG} />);
    const { dialog } = await openEdit();
    expect(dialog.parentElement?.getAttribute("tabindex")).toBe("-1");
    submit(dialog);
    expect(document.activeElement).toBe(dialog);
    const second = (await screen.findAllByRole("button", { name: "Edit" }))[1] as HTMLElement;
    fireEvent.click(second);
    const other = screen.getByRole("dialog", { name: "Edit account" });
    expect(within(other).getByRole("heading", { name: "Edit codex-main" })).toBeTruthy();
    release(200, { account: {} });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByRole("heading", { name: "Edit codex-main" })).toBeTruthy();
  });
});
