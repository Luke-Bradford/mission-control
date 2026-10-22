import type { RepoProfile } from "@mc/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Setup } from "../src/pages/Setup.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, REPOS } from "./fixtures.ts";

const PROFILE: RepoProfile = {
  id: "shop-app",
  github: "octo-org/shop-app",
  project: 2,
  statuses: [],
  missingColumns: [],
  priority: { field: 1, label: 0, none: 0 },
  budget: { boardPerHour: 900, sweepPerHour: 12, flowPerHour: 8, totalPerHour: 920 },
  loops: [],
};

const SETUP = "/api/boards/shop-app/setup";
const READY = { missing: [], missingLabels: [], mismatched: [] };
const BUG_DOCS = ["type:bug", "type:docs"];

afterEach(cleanup);

function load(routes: Record<string, unknown>) {
  const fn = stubFetch({
    "/api/config": CONFIG,
    "/api/repos": REPOS,
    "/api/repos/profiles": [PROFILE],
    ...routes,
  });
  window.history.replaceState(null, "", "/setup/repos");
  render(<Setup tab="repos" />);
  return fn;
}

const card = () => screen.findByRole("region", { name: "Board setup for shop-app" });
const setupCalls = (fn: ReturnType<typeof stubFetch>, method: string) =>
  fn.mock.calls.filter(([p, i]) => p === SETUP && (i?.method ?? "GET") === method);

async function check(fn: ReturnType<typeof stubFetch>) {
  const g = await card();
  fireEvent.click(within(g).getByRole("button", { name: "Check board" }));
  await waitFor(() => expect(setupCalls(fn, "GET")).toHaveLength(1));
  return g;
}

describe("Setup › Repos › board setup", () => {
  it("reads nothing from GitHub until Check board is clicked", async () => {
    const fn = load({ [SETUP]: READY });
    await card();
    expect(setupCalls(fn, "GET")).toEqual([]);
  });

  it("all present: says Board ready and offers no action", async () => {
    const fn = load({ [SETUP]: READY });
    const g = await check(fn);
    expect(await within(g).findByText("Board ready")).toBeTruthy();
    expect(g.textContent).not.toContain("Missing");
    expect(g.textContent).not.toContain("Labels missing");
    expect(within(g).queryByRole("button", { name: "Set up board" })).toBeNull();
    expect(within(g).queryByRole("button", { name: "Create missing labels" })).toBeNull();
  });

  it("only labels missing: names them, is not Board ready, offers Create missing labels", async () => {
    const fn = load({ [SETUP]: { ...READY, missingLabels: BUG_DOCS } });
    const g = await check(fn);
    expect(await within(g).findByText("Labels missing: type:bug, type:docs")).toBeTruthy();
    expect(g.textContent).not.toContain("Board ready");
    expect(g.textContent).not.toContain("Missing:");
    expect(within(g).queryByRole("button", { name: "Set up board" })).toBeNull();
    expect(within(g).getByRole("button", { name: "Create missing labels" })).toBeTruthy();
  });

  it("fields and labels missing: names both and offers Set up board, whose confirm names both", async () => {
    const fn = load({
      [SETUP]: { missing: ["Priority", "Size"], missingLabels: BUG_DOCS, mismatched: [] },
    });
    const g = await check(fn);
    expect(await within(g).findByText("Missing: Priority, Size")).toBeTruthy();
    expect(within(g).getByText("Labels missing: type:bug, type:docs")).toBeTruthy();
    expect(g.textContent).not.toContain("Board ready");
    expect(within(g).queryByRole("button", { name: "Create missing labels" })).toBeNull();
    fireEvent.click(within(g).getByRole("button", { name: "Set up board" }));
    const text = within(g).getByText(/This writes to GitHub/).textContent ?? "";
    expect(text).toContain("fields Priority, Size");
    expect(text).toContain("labels type:bug, type:docs");
  });

  it("Create missing labels confirms (naming only the missing labels) before it posts, then shows the result", async () => {
    const fn = load({
      [SETUP]: { ...READY, missingLabels: ["type:bug"] },
      [`POST ${SETUP}`]: { created: [], mismatched: [], labelsCreated: ["type:bug"] },
    });
    const g = await check(fn);
    fireEvent.click(within(g).getByRole("button", { name: "Create missing labels" }));
    expect(setupCalls(fn, "POST")).toEqual([]);
    const text = g.textContent ?? "";
    expect(text).toContain("octo-org/shop-app");
    expect(text).not.toContain("project fields");
    expect(text).toContain("the labels type:bug.");
    fireEvent.click(within(g).getByRole("button", { name: "Create on GitHub" }));
    expect(await within(g).findByText("Created labels: type:bug")).toBeTruthy();
    expect(setupCalls(fn, "POST")).toHaveLength(1);
  });

  it("status and result lines are in a polite live region", async () => {
    const fn = load({
      [SETUP]: { missing: ["Size"], missingLabels: [], mismatched: [] },
      [`POST ${SETUP}`]: { created: ["Size"], mismatched: [], labelsCreated: [] },
    });
    const g = await check(fn);
    const live = g.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(live.textContent).toContain("Missing: Size");
    fireEvent.click(within(g).getByRole("button", { name: "Set up board" }));
    fireEvent.click(within(g).getByRole("button", { name: "Create on GitHub" }));
    await within(g).findByText("Labels: all present");
    expect(live.isConnected).toBe(true);
    expect(live.textContent).toContain("Created fields: Size");
  });

  it("opening the confirm moves focus into it; Cancel returns focus to the trigger", async () => {
    const fn = load({ [SETUP]: { missing: ["Size"], missingLabels: [], mismatched: [] } });
    const g = await check(fn);
    fireEvent.click(within(g).getByRole("button", { name: "Set up board" }));
    await waitFor(() =>
      expect(g.contains(document.activeElement) && document.activeElement !== g).toBe(true),
    );
    expect(document.activeElement?.textContent).toContain("This writes to GitHub");
    fireEvent.click(within(g).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(within(g).getByRole("button", { name: "Set up board" })),
    );
  });

  it("after the action finishes, focus goes to Recheck", async () => {
    const fn = load({
      [SETUP]: { missing: ["Size"], missingLabels: [], mismatched: [] },
      [`POST ${SETUP}`]: { created: ["Size"], mismatched: [], labelsCreated: [] },
    });
    const g = await check(fn);
    fireEvent.click(within(g).getByRole("button", { name: "Set up board" }));
    fireEvent.click(within(g).getByRole("button", { name: "Create on GitHub" }));
    await within(g).findByText("Labels: all present");
    await waitFor(() =>
      expect(document.activeElement).toBe(within(g).getByRole("button", { name: "Recheck" })),
    );
  });

  it("a failed POST still re-reads the status and shows the error", async () => {
    let done = false;
    const fn = load({
      [SETUP]: () => ({
        status: 200,
        body: { missing: done ? [] : ["Priority", "Size"], missingLabels: [], mismatched: [] },
      }),
      [`POST ${SETUP}`]: () => {
        done = true;
        return { status: 502, body: { error: "GitHub setup failed: labels" } };
      },
    });
    const g = await check(fn);
    fireEvent.click(within(g).getByRole("button", { name: "Set up board" }));
    fireEvent.click(within(g).getByRole("button", { name: "Create on GitHub" }));
    expect((await within(g).findByRole("alert")).textContent).toBe("GitHub setup failed: labels");
    await waitFor(() => expect(setupCalls(fn, "GET")).toHaveLength(2));
    expect(await within(g).findByText("Board ready")).toBeTruthy();
  });

  it("a second action that fails drops the first one's result lines", async () => {
    let posts = 0;
    const fn = load({
      [SETUP]: { missing: ["Size"], missingLabels: [], mismatched: [] },
      [`POST ${SETUP}`]: () => {
        posts += 1;
        return posts === 1
          ? { status: 200, body: { created: ["Size"], mismatched: [], labelsCreated: [] } }
          : { status: 502, body: { error: "GitHub setup failed: labels" } };
      },
    });
    const g = await check(fn);
    fireEvent.click(within(g).getByRole("button", { name: "Set up board" }));
    fireEvent.click(within(g).getByRole("button", { name: "Create on GitHub" }));
    expect(await within(g).findByText("Created fields: Size")).toBeTruthy();
    await waitFor(() => expect(setupCalls(fn, "GET")).toHaveLength(2));
    await waitFor(() =>
      expect(
        (within(g).getByRole("button", { name: "Set up board" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(within(g).getByRole("button", { name: "Set up board" }));
    fireEvent.click(within(g).getByRole("button", { name: "Create on GitHub" }));
    expect((await within(g).findByRole("alert")).textContent).toBe("GitHub setup failed: labels");
    expect(within(g).queryByText("Created fields: Size")).toBeNull();
    expect(within(g).queryByText("Labels: all present")).toBeNull();
  });

  it("Recheck re-reads the status", async () => {
    const fn = load({ [SETUP]: { missing: ["Size"], missingLabels: [], mismatched: [] } });
    const g = await check(fn);
    fireEvent.click(within(g).getByRole("button", { name: "Recheck" }));
    await waitFor(() => expect(setupCalls(fn, "GET")).toHaveLength(2));
  });

  it("encodes the repo id in the path", async () => {
    const odd = "/api/boards/a%2Fb%20c/setup";
    const fn = stubFetch({
      "/api/config": CONFIG,
      "/api/repos": REPOS,
      "/api/repos/profiles": [{ ...PROFILE, id: "a/b c" }],
      [odd]: READY,
    });
    window.history.replaceState(null, "", "/setup/repos");
    render(<Setup tab="repos" />);
    const g = await screen.findByRole("region", { name: "Board setup for a/b c" });
    fireEvent.click(within(g).getByRole("button", { name: "Check board" }));
    await within(g).findByText("Board ready");
    expect(fn.mock.calls.some(([p]) => p === odd)).toBe(true);
  });

  it("missing: names the fields and offers Set up board", async () => {
    const fn = load({
      [SETUP]: { missing: ["Priority", "Size"], missingLabels: [], mismatched: [] },
    });
    const g = await check(fn);
    expect(await within(g).findByText("Missing: Priority, Size")).toBeTruthy();
    expect(within(g).getByRole("button", { name: "Set up board" })).toBeTruthy();
  });

  it("mismatch: warns about the field left alone", async () => {
    const fn = load({
      [SETUP]: {
        ...READY,
        mismatched: [{ field: "Stage", options: ["A", "B"] }],
      },
    });
    const g = await check(fn);
    expect(await within(g).findByText(/Warning: field Stage .*\(A, B\)/)).toBeTruthy();
  });

  it("error: shows the server's text", async () => {
    const fn = load({
      [SETUP]: () => ({ status: 502, body: { error: "GitHub setup failed: rate limited" } }),
    });
    const g = await card();
    fireEvent.click(within(g).getByRole("button", { name: "Check board" }));
    await waitFor(() => expect(setupCalls(fn, "GET")).toHaveLength(1));
    expect((await within(g).findByRole("alert")).textContent).toBe(
      "GitHub setup failed: rate limited",
    );
  });

  it("Set up board asks first, naming what it creates, and posts nothing yet", async () => {
    const fn = load({
      [SETUP]: { missing: ["Priority", "Size"], missingLabels: [], mismatched: [] },
    });
    const g = await check(fn);
    fireEvent.click(await within(g).findByRole("button", { name: "Set up board" }));
    const text = g.textContent ?? "";
    expect(text).toContain("octo-org/shop-app");
    expect(text).toContain("fields Priority, Size");
    expect(text).not.toContain("labels");
    expect(setupCalls(fn, "POST")).toEqual([]);
    fireEvent.click(within(g).getByRole("button", { name: "Cancel" }));
    expect(setupCalls(fn, "POST")).toEqual([]);
    expect(within(g).getByRole("button", { name: "Set up board" })).toBeTruthy();
  });

  it("confirming posts once, shows what was created and re-reads the status", async () => {
    let done = false;
    const fn = load({
      [SETUP]: () => ({
        status: 200,
        body: { missing: done ? [] : ["Priority", "Size"], missingLabels: [], mismatched: [] },
      }),
      [`POST ${SETUP}`]: () => {
        done = true;
        return {
          status: 200,
          body: { created: ["Priority", "Size"], mismatched: [], labelsCreated: ["type:docs"] },
        };
      },
    });
    const g = await check(fn);
    fireEvent.click(await within(g).findByRole("button", { name: "Set up board" }));
    fireEvent.click(within(g).getByRole("button", { name: "Create on GitHub" }));
    expect(await within(g).findByText("Created fields: Priority, Size")).toBeTruthy();
    expect(within(g).getByText("Created labels: type:docs")).toBeTruthy();
    expect(setupCalls(fn, "POST")).toHaveLength(1);
    await waitFor(() => expect(setupCalls(fn, "GET")).toHaveLength(2));
    expect(await within(g).findByText("Board ready")).toBeTruthy();
    expect(within(g).queryByRole("button", { name: "Set up board" })).toBeNull();
  });

  it("says Labels: all present when no label was created", async () => {
    const fn = load({
      [SETUP]: { missing: ["Size"], missingLabels: [], mismatched: [] },
      [`POST ${SETUP}`]: { created: ["Size"], mismatched: [], labelsCreated: [] },
    });
    const g = await check(fn);
    fireEvent.click(await within(g).findByRole("button", { name: "Set up board" }));
    fireEvent.click(within(g).getByRole("button", { name: "Create on GitHub" }));
    expect(await within(g).findByText("Labels: all present")).toBeTruthy();
  });

  it("disables Set up board while the POST runs", async () => {
    const fn = load({ [SETUP]: { missing: ["Size"], missingLabels: [], mismatched: [] } });
    const g = await check(fn);
    const answer = fn.getMockImplementation() as (...a: unknown[]) => Promise<Response>;
    let release: () => void = () => {};
    fn.mockImplementation(async (...a: unknown[]) => {
      if ((a[1] as RequestInit | undefined)?.method === "POST") {
        await new Promise<void>((r) => {
          release = r;
        });
        return new Response(JSON.stringify({ created: [], mismatched: [], labelsCreated: [] }));
      }
      return answer(...a);
    });
    fireEvent.click(await within(g).findByRole("button", { name: "Set up board" }));
    fireEvent.click(within(g).getByRole("button", { name: "Create on GitHub" }));
    const btn = await within(g).findByRole("button", { name: "Set up board" });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    release();
    await within(g).findByText("Labels: all present");
    expect(setupCalls(fn, "POST")).toHaveLength(1);
  });
});
