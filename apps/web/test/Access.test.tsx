import type { NotificationEvent, NotificationPreferences } from "@mc/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  BrowserNotifications,
  createDelivery,
  enableBrowser,
  notificationTarget,
  permissionState,
  showNotification,
} from "../src/browserNotifications.ts";
import { hub } from "../src/data.ts";
import { Access } from "../src/setup/Access.tsx";
import { Toast } from "../src/shell/Toast.tsx";
import { stubFetch } from "./fetchStub.ts";

export const PREFS: NotificationPreferences = {
  enabled: true,
  categories: {
    asks: true,
    flightDown: true,
    people: true,
    decisions: true,
    stalls: true,
    prs: true,
    capcom: true,
    awayDigest: true,
    quota: false,
    agentMessages: false,
  },
  quietHours: { start: "19:00", end: "08:00", timezone: "UTC", stallsBypass: true },
  softChime: true,
};
const event: NotificationEvent = {
  id: "example",
  category: "people",
  at: Date.UTC(2026, 9, 23, 12),
  text: "Example colleague asked you",
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps auto-approve controls in Safety", () => {
  stubFetch({ "/api/notification-preferences": PREFS });
  render(<Access />);
  const auto = screen.getByRole("region", { name: "Auto-approve" });
  const boxes = auto.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  expect(boxes).toHaveLength(5);
  expect([...boxes].every((box) => box.disabled)).toBe(true);
  expect(auto.textContent).toContain("P2");
});

it("saves and reloads categories, quiet hours and chime without asking permission", async () => {
  let saved = PREFS;
  const request = vi.fn();
  vi.stubGlobal("Notification", { permission: "default", requestPermission: request });
  stubFetch({
    "/api/notification-preferences": () => ({ status: 200, body: saved }),
    "POST /api/notification-preferences": (init?: RequestInit) => {
      saved = JSON.parse(String(init?.body));
      return { status: 200, body: saved };
    },
  });
  const view = render(<Access />);
  const quota = await screen.findByLabelText("Quota above 90%");
  const preferences = screen.getByRole("region", { name: "Notify me about" });
  const boxes = within(preferences).getAllByRole("checkbox") as HTMLInputElement[];
  expect(boxes).toHaveLength(12);
  expect(boxes.filter((box) => box.checked)).toHaveLength(10);
  expect(boxes.every((box) => !box.disabled)).toBe(true);
  fireEvent.click(quota);
  fireEvent.change(screen.getByLabelText("Quiet hours start"), { target: { value: "20:00" } });
  fireEvent.click(screen.getByLabelText("Soft chime"));
  fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
  await screen.findByText("Preferences saved.");
  view.unmount();
  render(<Access />);
  await waitFor(() =>
    expect(screen.getByLabelText("Quota above 90%")).toHaveProperty("checked", true),
  );
  expect(screen.getByLabelText("Quiet hours start")).toHaveProperty("value", "20:00");
  expect(screen.getByLabelText("Soft chime")).toHaveProperty("checked", false);
  expect(request).not.toHaveBeenCalled();
});

it.each(["granted", "denied"] as const)(
  "requests permission only explicitly and handles %s",
  async (permission) => {
    const requestPermission = vi.fn(async () => permission);
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    expect(await enableBrowser()).toBe(permission);
    expect(requestPermission).toHaveBeenCalledTimes(1);
  },
);
it("handles unsupported browsers", async () => {
  vi.stubGlobal("Notification", undefined);
  expect(permissionState()).toBe("unsupported");
  expect(await enableBrowser()).toBe("unsupported");
});
it("deduplicates, suppresses categories and quiet hours, but allows stalls", () => {
  const show = vi.fn();
  const deliver = createDelivery(show);
  deliver(event, PREFS);
  deliver(event, PREFS);
  deliver({ ...event, id: "quota", category: "quota" }, PREFS);
  deliver({ ...event, id: "quiet", at: Date.UTC(2026, 9, 23, 20) }, PREFS);
  deliver({ ...event, id: "stall", category: "stalls", at: Date.UTC(2026, 9, 23, 20) }, PREFS);
  expect(show.mock.calls.map(([e]) => e.id)).toEqual(["example", "stall"]);
});
it("test delivery and sample stop never stop a run or post replies", async () => {
  vi.stubGlobal("Notification", undefined);
  const fetch = stubFetch({
    "/api/notification-preferences": PREFS,
    "POST /api/notifications/test": { ...event, test: true },
  });
  render(
    <>
      <Access />
      <Toast />
    </>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Send a test notification" }));
  await screen.findByText(/Browser notifications unsupported/);
  fireEvent.click(screen.getByRole("button", { name: "Stop the run" }));
  expect(
    fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([path]) => path),
  ).toEqual(["/api/notifications/test"]);
});
it("shows failed loads and retry", async () => {
  stubFetch({});
  render(<Access />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "not found");
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});

it("shows loading and an empty response without invented preferences", async () => {
  let release: (response: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    ),
  );
  render(<Access />);
  expect(await screen.findByText("Loading preferences…")).toBeTruthy();
  release(new Response("null", { status: 200 }));
  expect(await screen.findByText("No preferences loaded.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save preferences" })).toBeNull();
});

it("retains edits on a failed save and makes controls keyboard focusable", async () => {
  stubFetch({
    "/api/notification-preferences": PREFS,
    "POST /api/notification-preferences": () => ({
      status: 500,
      body: { error: "Example save failed" },
    }),
  });
  render(<Access />);
  const quota = await screen.findByLabelText("Quota above 90%");
  quota.focus();
  expect(document.activeElement).toBe(quota);
  fireEvent.click(quota);
  fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Example save failed");
  expect(quota).toHaveProperty("checked", true);
  expect(screen.getByRole("button", { name: "Save preferences" })).toHaveProperty(
    "disabled",
    false,
  );
});

it("opens the relevant page on browser click without writing", async () => {
  const close = vi.fn();
  let clicked: (() => void) | undefined;
  class BrowserNotification {
    static permission = "granted";
    set onclick(fn: () => void) {
      clicked = fn;
    }
    close = close;
  }
  vi.stubGlobal("Notification", BrowserNotification);
  vi.spyOn(window, "focus").mockImplementation(() => {});
  const fetch = stubFetch({});
  showNotification(event, PREFS);
  clicked?.();
  expect(window.location.pathname).toBe("/flight");
  expect(close).toHaveBeenCalledOnce();
  expect(notificationTarget({ ...event, category: "quota" })).toBe("/telemetry");
  expect(notificationTarget({ ...event, category: "capcom" })).toBe("/comms");
  expect(fetch).not.toHaveBeenCalled();
});

it("falls back in app when native notification construction fails", async () => {
  class BrowserNotification {
    static permission = "granted";
    constructor() {
      throw new Error("blocked");
    }
  }
  vi.stubGlobal("Notification", BrowserNotification);
  render(<Toast />);
  showNotification(event, PREFS);
  expect(await screen.findByText(event.text)).toBeTruthy();
});

it("chimes only after explicit audio permission and when enabled", async () => {
  const start = vi.fn();
  const resume = vi.fn(async () => {});
  class BrowserAudio {
    state = "running";
    currentTime = 0;
    destination = {};
    resume = resume;
    createOscillator() {
      return { frequency: { value: 0 }, connect: vi.fn(), start, stop: vi.fn() };
    }
    createGain() {
      return {
        gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        connect: vi.fn(),
      };
    }
  }
  vi.stubGlobal("AudioContext", BrowserAudio);
  vi.stubGlobal("Notification", undefined);
  showNotification(event, PREFS);
  expect(start).not.toHaveBeenCalled();
  await enableBrowser();
  expect(resume).toHaveBeenCalledOnce();
  showNotification(event, { ...PREFS, softChime: false });
  expect(start).not.toHaveBeenCalled();
  showNotification({ ...event, softChime: false }, PREFS);
  expect(start).not.toHaveBeenCalled();
  showNotification(event, PREFS);
  expect(start).toHaveBeenCalledOnce();
});

it("delivers new feed events after invalidation and does not repeat them", async () => {
  const native = vi.fn();
  class BrowserNotification {
    static permission = "granted";
    constructor(title: string, options: unknown) {
      native(title, options);
    }
  }
  vi.stubGlobal("Notification", BrowserNotification);
  let events: NotificationEvent[] = [];
  stubFetch({
    "/api/notification-preferences": PREFS,
    "/api/notifications/events": () => ({ status: 200, body: events }),
  });
  render(<BrowserNotifications />);
  await waitFor(() =>
    expect(hub.snapshot("/api/notifications/events", "attention").data).toEqual([]),
  );
  expect(native).not.toHaveBeenCalled();
  events = [{ ...event, id: "feed-example" }];
  act(() => hub.refetchTopic("attention"));
  await waitFor(() => expect(native).toHaveBeenCalledOnce());
  act(() => hub.refetchTopic("settings"));
  await waitFor(() =>
    expect(hub.snapshot("/api/notifications/events", "attention").loading).toBe(false),
  );
  expect(native).toHaveBeenCalledOnce();
});

it("follows refreshed preferences until edited and saves only edited fields", async () => {
  let server = structuredClone(PREFS);
  const posted = vi.fn();
  stubFetch({
    "/api/notification-preferences": () => ({ status: 200, body: server }),
    "POST /api/notification-preferences": (init?: RequestInit) => {
      const patch = JSON.parse(String(init?.body));
      posted(patch);
      server = {
        ...server,
        ...patch,
        categories: { ...server.categories, ...patch.categories },
        quietHours: { ...server.quietHours, ...patch.quietHours },
      };
      return { status: 200, body: server };
    },
  });
  render(<Access />);
  await screen.findByLabelText("Soft chime");
  server = { ...server, softChime: false };
  act(() => hub.refetchTopic("settings"));
  await waitFor(() => expect(screen.getByLabelText("Soft chime")).toHaveProperty("checked", false));
  fireEvent.click(screen.getByLabelText("Quota above 90%"));
  fireEvent.change(screen.getByLabelText("Quiet hours start"), { target: { value: "21:00" } });
  server = {
    ...server,
    categories: { ...server.categories, people: false },
    quietHours: { ...server.quietHours, end: "09:00", timezone: "Europe/London" },
  };
  act(() => hub.refetchTopic("settings"));
  await waitFor(() =>
    expect(screen.getByLabelText("Quiet hours end")).toHaveProperty("value", "09:00"),
  );
  expect(screen.getByLabelText("Quota above 90%")).toHaveProperty("checked", true);
  expect(screen.getByLabelText("Quiet hours start")).toHaveProperty("value", "21:00");
  server = { ...server, enabled: false };
  fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
  await screen.findByText("Preferences saved.");
  expect(posted).toHaveBeenCalledWith({
    ...server,
    categories: { ...server.categories, quota: true },
    quietHours: { ...server.quietHours, start: "21:00" },
  });
  expect(server.categories.people).toBe(false);
  expect(server.quietHours.timezone).toBe("Europe/London");
  server = { ...server, categories: { ...server.categories, quota: false } };
  act(() => hub.refetchTopic("settings"));
  await waitFor(() =>
    expect(screen.getByLabelText("Quota above 90%")).toHaveProperty("checked", false),
  );
});

it("treats the first feed including tests as history even while preferences load", async () => {
  const native = vi.fn();
  vi.stubGlobal(
    "Notification",
    class {
      static permission = "granted";
      constructor() {
        native();
      }
    },
  );
  let release!: (response: Response) => void;
  let events = [
    { ...event, id: "history-normal" },
    { ...event, id: "history-test", test: true },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string) =>
      path === "/api/notification-preferences"
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : Promise.resolve(Response.json(events)),
    ),
  );
  render(<BrowserNotifications />);
  await waitFor(() =>
    expect(hub.snapshot("/api/notifications/events", "attention").data).toEqual(events),
  );
  events = [...events, { ...event, id: "arrived-during-preferences" }];
  act(() => hub.refetchTopic("attention"));
  await waitFor(() =>
    expect(hub.snapshot("/api/notifications/events", "attention").data).toEqual(events),
  );
  await act(async () => release(Response.json(PREFS)));
  await waitFor(() => expect(native).toHaveBeenCalledTimes(1));
});

it.each(["events"])("waits for both refreshes when %s finishes first", async (first) => {
  const native = vi.fn();
  vi.stubGlobal(
    "Notification",
    class {
      static permission = "granted";
      constructor() {
        native();
      }
    },
  );
  stubFetch({
    "/api/notification-preferences": { ...PREFS, enabled: false },
    "/api/notifications/events": [],
  });
  render(<BrowserNotifications />);
  await waitFor(() =>
    expect(hub.snapshot("/api/notifications/events", "attention").data).toEqual([]),
  );
  const pending = new Map<string, (response: Response) => void>();
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string) => new Promise<Response>((resolve) => pending.set(path, resolve))),
  );
  act(() => hub.refetchTopic("settings"));
  const finish = async (which: string) => {
    const path = which === "events" ? "/api/notifications/events" : "/api/notification-preferences";
    await act(async () =>
      pending.get(path)?.(
        Response.json(which === "events" ? [{ ...event, id: `race-${first}` }] : PREFS),
      ),
    );
  };
  await finish(first);
  expect(native).not.toHaveBeenCalled();
  await finish(first === "events" ? "preferences" : "events");
  await waitFor(() => expect(native).toHaveBeenCalledOnce());
  act(() => hub.refetchTopic("attention"));
  await finish("events");
  expect(native).toHaveBeenCalledOnce();
});
