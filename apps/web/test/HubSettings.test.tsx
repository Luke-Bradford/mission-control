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
