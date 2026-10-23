import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { whereOf } from "../src/notifications.ts";
import { Sources } from "../src/setup/Sources.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, MIN, NOW } from "./fixtures.ts";

const chat = {
  kind: "chat",
  id: "fictional-chat",
  name: "Work chat",
  repoId: CONFIG.repos[0]?.id,
  lane: "work",
};
const status = { enabled: true, selected: [chat], note: "Polls on a timer.", retryAt: null };

it("selects work feeds with native keyboard controls and saves only selection", async () => {
  const fn = stubFetch({
    "/api/sources/teams": status,
    "/api/health": [],
    "POST /api/sources/teams/selection": status,
  });
  render(<Sources config={CONFIG} error={null} />);
  await screen.findByText("Work chat");
  const kind = screen.getByRole("combobox", { name: "Feed kind" });
  kind.focus();
  expect(document.activeElement).toBe(kind);
  fireEvent.change(kind, { target: { value: "channel" } });
  for (const [name, value] of [
    ["Feed name", "Work channel"],
    ["Feed ID", "fictional-channel"],
    ["Team ID", "fictional-team"],
  ]) {
    fireEvent.change(screen.getByRole("textbox", { name }), { target: { value } });
  }
  fireEvent.click(screen.getByRole("button", { name: "Add feed" }));
  fireEvent.click(screen.getByRole("button", { name: "Save Teams selection" }));
  await waitFor(() =>
    expect(
      fn.mock.calls.some(
        ([p, init]) =>
          p.endsWith("/selection") && init?.body?.toString().includes("fictional-channel"),
      ),
    ).toBe(true),
  );
  expect(fn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: /sign in|Post to Teams/i })).toBeNull();
});

it.each([
  [false, "Set sources.teams.token_command in local config to enable Microsoft Teams."],
  [true, "not permitted with this login; needs Chat.Read, ChannelMessage.Read.All"],
])("shows actionable source status (%s)", async (enabled, note) => {
  stubFetch({
    "/api/sources/teams": { ...status, enabled, note, selected: [] },
    "/api/health": [],
  });
  render(<Sources config={CONFIG} error={null} />);
  await screen.findByText(note);
  expect(screen.getByText("No selected work feeds.")).toBeTruthy();
  expect(screen.getByText(/last successful poll never/)).toBeTruthy();
  if (enabled)
    expect(
      screen.getByText(/Configure login and app consent outside Mission Control/),
    ).toBeTruthy();
});

it("shows failed status reads", async () => {
  stubFetch({
    "/api/sources/teams": () => ({ status: 502, body: { error: "Source unavailable" } }),
  });
  render(<Sources config={CONFIG} error={null} />);
  await screen.findByText("Could not load Teams: Source unavailable");
});

it("uses Teams feed metadata for person locations", () => {
  expect(
    whereOf({
      repoId: "work",
      number: null,
      message: {
        teams: {
          name: "Work chat",
          kind: "chat",
          id: "fictional-chat",
          messageId: "fictional-message",
        },
        source: { kind: "teams", messageId: "fictional-message", revision: "v1" },
        author: "Finch",
        at: NOW,
        text: "Review requested",
        url: "https://teams.microsoft.com/l/message/fictional",
      },
    }),
  ).toBe("Teams · Work chat");
});

it("does not render personal feeds as configured Teams sources", async () => {
  stubFetch({
    "/api/sources/teams": {
      ...status,
      selected: [{ ...chat, lane: "personal", name: "Home chat" }],
    },
    "/api/health": [],
  });
  render(<Sources config={CONFIG} error={null} />);
  await screen.findByText("No selected work feeds.");
  expect(screen.queryByText("Home chat")).toBeNull();
});

it("shows loading without enabling selection", () => {
  stubFetch({});
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) =>
    String(input) === "/api/sources/teams" ? new Promise(() => {}) : original(input, init);
  render(<Sources config={CONFIG} error={null} />);
  expect(screen.getByText("Loading Teams…")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save Teams selection" })).toBeNull();
});

it("retains selection after a refused save", async () => {
  stubFetch({
    "/api/sources/teams": status,
    "/api/health": [],
    "POST /api/sources/teams/selection": () => ({
      status: 409,
      body: { error: "Config writes unavailable" },
    }),
  });
  render(<Sources config={CONFIG} error={null} />);
  fireEvent.click(await screen.findByRole("button", { name: "Remove Work chat" }));
  fireEvent.click(screen.getByRole("button", { name: "Save Teams selection" }));
  await screen.findByRole("alert");
  expect(screen.getByText("Config writes unavailable")).toBeTruthy();
  expect(screen.getByText("No selected work feeds.")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Save Teams selection" }) as HTMLButtonElement).disabled,
  ).toBe(false);
});

it("keeps feed fields usable at narrow widths", () => {
  const css = readFileSync(join(import.meta.dirname, "../src/hud.css"), "utf8");
  expect(css).toMatch(/\.teams-selection\s*\{[^}]*flex-wrap: wrap;/);
  expect(css).toMatch(/\.teams-sources\s*\{[^}]*overflow-wrap: anywhere;/);
  expect(css).toMatch(/\.teams-selection label\s*\{[^}]*min-width: 0;/);
});

it("shows last successful poll while a later poll is backing off", async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  stubFetch({
    "/api/config": CONFIG,
    "/api/sources/teams": { ...status, note: "Teams HTTP 429; will retry", retryAt: NOW + MIN },
    "/api/health": [
      {
        collector: "teams",
        ok: false,
        error: "Teams HTTP 429; will retry",
        lastOkAt: NOW - 5 * MIN,
      },
    ],
  });
  render(<Sources config={CONFIG} error={null} />);
  await screen.findByText("last successful poll 5 min ago");
  expect(screen.getByText(/^Retry /)).toBeTruthy();
});
