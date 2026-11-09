import type { NotificationEvent, NotificationPreferences } from "@mc/core";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserNotifications } from "../src/browserNotifications.ts";
import { setDemo } from "../src/demo/mode.ts";
import { Toast } from "../src/shell/Toast.tsx";
import { stubFetch } from "./fetchStub.ts";
import { NOW } from "./fixtures.ts";

const prefs: NotificationPreferences = {
  enabled: true,
  softChime: false,
  categories: { quota: true, capcom: true, stalls: true, flightDown: true } as never,
  quietHours: { start: "00:00", end: "00:00", timezone: "UTC", stallsBypass: true },
};
const old: NotificationEvent = { id: "old", category: "quota", at: NOW, text: "Quota at 90%." };

beforeEach(() => {
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener() {}
      close() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 30))));

it("is silent in Demo, and a return to Live delivers nothing it already knew", async () => {
  stubFetch({
    "/api/notification-preferences": prefs,
    "/api/notifications/events": [old],
  });
  const view = render(
    <>
      <BrowserNotifications />
      <Toast />
    </>,
  );
  await settle();
  // The first feed is history, not news.
  expect(document.getElementById("toast")?.textContent).toBe("");
  await act(async () => setDemo(true));
  await settle();
  expect(document.getElementById("toast")?.textContent).toBe("");
  await act(async () => setDemo(false));
  await settle();
  expect(document.getElementById("toast")?.textContent).toBe("");
  view.unmount();
});
