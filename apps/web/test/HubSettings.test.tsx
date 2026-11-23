import { APPLIES_TEXT, HUB_SETTINGS } from "@mc/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { HubSettings } from "../src/setup/HubSettings.tsx";
import { stubFetch } from "./fetchStub.ts";

it("shows a setting and saves its value", async () => {
  const fetch = stubFetch({
    "/api/config/settings": { base: "base", values: { "poll.usage_minutes": 30 }, repos: {} },
    "POST /api/config/settings": { backup: "config.yaml.bak", changes: {} },
  });
  render(<HubSettings />);
  expect(await screen.findByText("Usage poll")).toBeTruthy();
  expect(screen.getAllByText("Applies after a restart").length).toBeGreaterThan(0);
  fireEvent.change(screen.getByLabelText("Usage poll"), { target: { value: "15" } });
  fireEvent.click(screen.getByRole("button", { name: "Save Usage poll" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const call = fetch.mock.calls.find(
    ([path, init]) => path === "/api/config/settings" && init?.method === "POST",
  );
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({
    base: "base",
    key: "poll.usage_minutes",
    value: 15,
  });
});

it("shows every hub setting with its value and when it applies", async () => {
  const values = {
    "operator.timezone": "Europe/Paris",
    "crew.max_seats": 5,
    "crew.lane": "work",
    "crew.deny_read": ["~/.ssh", "~/.aws"],
  };
  stubFetch({ "/api/config/settings": { base: "base", values, repos: {} } });
  render(<HubSettings />);
  await screen.findByText("Time zone");
  for (const [key, def] of Object.entries(HUB_SETTINGS)) {
    if (key.startsWith("repo.")) continue;
    expect(screen.getAllByText(def.label).length, key).toBeGreaterThan(0);
  }
  expect(screen.getAllByText(APPLIES_TEXT.now).length).toBeGreaterThan(0);
  expect(screen.getAllByText(APPLIES_TEXT.restart).length).toBeGreaterThan(0);
  expect(screen.getByLabelText("Time zone")).toHaveProperty("value", "Europe/Paris");
  expect(screen.getByLabelText("Maximum seats")).toHaveProperty("value", "5");
  expect(screen.getByLabelText("Read deny list")).toHaveProperty("value", "~/.ssh\n~/.aws");
  expect(screen.getByLabelText("Crew lane")).toHaveProperty("value", "work");
});

it("puts Operator and Crew first and names each choice in words, posting the typed value", async () => {
  const fetch = stubFetch({
    "/api/config/settings": { base: "base", values: {}, repos: {} },
    "POST /api/config/settings": { backup: "b", changes: {} },
  });
  render(<HubSettings />);
  await screen.findByText("Time zone");
  const legends = [...document.querySelectorAll(".setup-hub legend")].map((l) => l.textContent);
  expect(legends.slice(0, 2)).toEqual(["Operator", "Crew"]);
  expect(screen.queryByRole("option", { name: "between_runs" })).toBeNull();
  fireEvent.change(screen.getByLabelText("CLI updates"), { target: { value: "between_runs" } });
  expect(screen.getByRole("option", { name: "Between runs" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save CLI updates" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const call = fetch.mock.calls.find(
    ([path, init]) => path === "/api/config/settings" && init?.method === "POST",
  );
  expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
    key: "updates.cli",
    value: "between_runs",
  });
});
