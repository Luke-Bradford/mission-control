import { type AwaySettings, DEFAULT_AWAY } from "@mc/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AWAY_WAITING, AwayModal } from "../src/shell/AwayModal.tsx";
import { installKeys } from "../src/shell/keys.ts";
import { openAway } from "../src/shell/overlays.ts";
import { Toast } from "../src/shell/Toast.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, NOW } from "./fixtures.ts";

const SAVED = "Saved. Mission Control acts on these settings from phase 4.";
const ON_TOAST =
  "Safe tickets can reach ready for review; others stay in draft, and comments wait for you.";

/** The modal open over a stubbed server holding `away`; `fail` makes every save fail. */
function setup(
  away: AwaySettings = DEFAULT_AWAY,
  fail?: { status: number; body: unknown },
  config: unknown = CONFIG,
): AwaySettings[] {
  let stored = away;
  const posts: AwaySettings[] = [];
  stubFetch({
    "/api/config": config,
    "/api/settings/away": () => ({ status: 200, body: stored }),
    "POST /api/settings/away": (init: RequestInit | undefined) => {
      if (fail) return fail;
      const body = JSON.parse(String(init?.body)) as AwaySettings;
      posts.push(body);
      stored = body;
      return { status: 200, body };
    },
  });
  render(
    <>
      <AwayModal />
      <Toast />
    </>,
  );
  act(() => openAway());
  return posts;
}

const toast = () => document.getElementById("toast")?.textContent;
const pressed = (name: string) =>
  screen.getByRole("button", { name }).getAttribute("aria-pressed") === "true";
const checkbox = (name: RegExp) => screen.getByRole("checkbox", { name }) as HTMLInputElement;

let off: () => void;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW); // Sat 17 Oct 2026, 13:00 in London
  const noop = () => {};
  off = installKeys({
    navigate: noop,
    toggleDock: noop,
    help: noop,
    selectNext: noop,
    selectPrev: noop,
    toast: noop,
  });
});
afterEach(() => {
  off();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AwayModal", () => {
  it("shows the settings once loaded: off, a default date, every box ticked", async () => {
    setup();
    const dialog = await screen.findByRole("dialog", { name: "Away mode" });
    await waitFor(() => expect(pressed("Off")).toBe(true));
    expect(within(dialog).getByText("Off: everything waits for you as usual.")).toBeTruthy();
    expect((screen.getByLabelText("Until") as HTMLInputElement).value).toBe("2026-10-27");
    const boxes = within(dialog).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes).toHaveLength(5);
    expect(boxes.every((b) => b.checked)).toBe(true);
  });

  it("says the catalogue's text: locked rows, safe rules, limits and the digest line", async () => {
    setup();
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => screen.getByText("Limits"));
    const text = dialog.textContent ?? "";
    for (const line of [
      "Mission Control keeps going while you're away, inside these limits",
      "While I'm away, Mission Control may",
      "Never merges, never posts to Teams, never changes settings, migrations or another team's code",
      "A ticket counts as safe when",
      "Docs: only documentation changes",
      "Keep 30% of every weekly quota window in reserve",
      "Park a ticket after 2 failed verify rounds and leave it for you",
      "When you come back",
      "The digest arrives with away mode (phase 4).",
    ]) {
      expect(text).toContain(line);
    }
    expect(dialog.querySelectorAll(".sw.locked")).toHaveLength(3);
    expect(text).not.toContain("need you now");
  });

  it("turning On before the timezone has loaded says it is waiting and saves nothing", async () => {
    const posts = setup(DEFAULT_AWAY, undefined, () => ({
      status: 503,
      body: { error: "loading" },
    }));
    await waitFor(() => expect(pressed("Off")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "On" }));
    await waitFor(() => expect(toast()).toBe(AWAY_WAITING));
    expect(posts).toHaveLength(0);
    expect(pressed("Off")).toBe(true);
  });

  it("turning On with no date saves today + 10 days and toasts", async () => {
    const posts = setup();
    await waitFor(() => expect(pressed("Off")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "On" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ ...DEFAULT_AWAY, on: true, until: "2026-10-27" });
    await waitFor(() =>
      expect(toast()).toBe(`Away mode on until Tue 27 Oct. ${ON_TOAST} ${SAVED}`),
    );
    await waitFor(() => expect(pressed("On")).toBe(true));
    expect(screen.getByText("Away mode is on until Tue 27 Oct.")).toBeTruthy();
  });

  it("turning On keeps a date that is already set", async () => {
    const posts = setup({ ...DEFAULT_AWAY, until: "2026-10-28" });
    await waitFor(() => expect(pressed("Off")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "On" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.until).toBe("2026-10-28");
    await waitFor(() => expect(toast()).toContain("Away mode on until Wed 28 Oct."));
  });

  it("turning Off saves and toasts", async () => {
    const posts = setup({ ...DEFAULT_AWAY, on: true, until: "2026-10-28" });
    await waitFor(() => expect(pressed("On")).toBe(true));
    expect(screen.getByText("Away mode is on until Wed 28 Oct.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Off" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ ...DEFAULT_AWAY, on: false, until: "2026-10-28" });
    await waitFor(() =>
      expect(toast()).toBe(`Away mode off. Everything waits for you as usual. ${SAVED}`),
    );
  });

  it("an empty date means until you turn it off", async () => {
    const posts = setup({ ...DEFAULT_AWAY, on: true, until: "2026-10-28" });
    await waitFor(() => expect(pressed("On")).toBe(true));
    fireEvent.change(screen.getByLabelText("Until"), { target: { value: "" } });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.until).toBe("");
    await waitFor(() =>
      expect(screen.getByText("Away mode is on until you turn it off.")).toBeTruthy(),
    );
  });

  it("changing the date saves the whole record", async () => {
    const posts = setup({ ...DEFAULT_AWAY, on: true, until: "2026-10-28" });
    await waitFor(() => expect(pressed("On")).toBe(true));
    fireEvent.change(screen.getByLabelText("Until"), { target: { value: "2026-11-01" } });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ ...DEFAULT_AWAY, on: true, until: "2026-11-01" });
    await waitFor(() => expect(toast()).toContain("until Sun 1 Nov"));
  });

  it("a checkbox saves the whole record with that one permission changed", async () => {
    const posts = setup();
    await screen.findByRole("checkbox", { name: /Pick up safe tickets/ });
    fireEvent.click(checkbox(/Pick up safe tickets/));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ ...DEFAULT_AWAY, may: { ...DEFAULT_AWAY.may, pickUp: false } });
    await waitFor(() => expect(toast()).toBe(SAVED));
    await waitFor(() => expect(checkbox(/Pick up safe tickets/).checked).toBe(false));
  });

  it("a failed save toasts the error and goes back", async () => {
    setup(DEFAULT_AWAY, { status: 400, body: { error: "until: must be a date" } });
    await waitFor(() => expect(pressed("Off")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "On" }));
    await waitFor(() => expect(toast()).toBe("Could not save away mode: until: must be a date"));
    await waitFor(() => expect(pressed("Off")).toBe(true));
    expect(screen.getByText("Off: everything waits for you as usual.")).toBeTruthy();
  });

  it("a failed checkbox goes back to ticked", async () => {
    setup(DEFAULT_AWAY, { status: 500, body: { error: "disk full" } });
    await screen.findByRole("checkbox", { name: /Research new tickets/ });
    fireEvent.click(checkbox(/Research new tickets/));
    await waitFor(() => expect(toast()).toBe("Could not save away mode: disk full"));
    await waitFor(() => expect(checkbox(/Research new tickets/).checked).toBe(true));
  });

  it("keeps Tab inside: the last control wraps to Close, and Shift+Tab on Close to the last", async () => {
    setup();
    await waitFor(() => expect(checkbox(/Pick up safe tickets/)).toBeTruthy());
    const close = screen.getByRole("button", { name: "Close" });
    const boxes = screen.getAllByRole("checkbox");
    const last = boxes[boxes.length - 1] as HTMLElement;
    last.focus();
    expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(close);
    expect(fireEvent.keyDown(close, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(last);
  });

  it("the backdrop is focusable and carries the trap: Tab goes to the first control, Shift+Tab to the last", async () => {
    setup();
    await waitFor(() => expect(checkbox(/Pick up safe tickets/)).toBeTruthy());
    const root = screen.getByRole("dialog").closest(".modal") as HTMLElement;
    expect(root.getAttribute("tabindex")).toBe("-1");
    const boxes = screen.getAllByRole("checkbox");
    root.focus();
    expect(document.activeElement).toBe(root);
    expect(fireEvent.keyDown(root, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    root.focus();
    expect(fireEvent.keyDown(root, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(boxes[boxes.length - 1]);
  });

  it("gives focus back to what had it when it closes", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    setup();
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("Close and Esc close it", async () => {
    setup();
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => openAway());
    expect(screen.getByRole("dialog")).toBeTruthy();
    act(() => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
