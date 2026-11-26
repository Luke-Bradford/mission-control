import { describe, expect, it, vi } from "vitest";
import { ChangeBus } from "../src/bus.ts";
import { applyCmuxSessionEvent, startCmuxEvents } from "../src/sessions/events.ts";
import { createSessionSidebar } from "../src/sessions/sidebar.ts";

const row = (over: Record<string, unknown> = {}) => ({
  id: "workspace",
  name: "operator",
  owner: "operator" as const,
  folder: null,
  repo: null,
  repoKey: null,
  state: "working" as const,
  since: 0,
  lastLine: null,
  status: null,
  app: null,
  inbox: { unread: 0, newest: null },
  check: null,
  branch: "feature/2262-cmux-sidebar",
  ticket: { number: 2262, repoId: "mc" },
  pr: {
    number: 1,
    url: "https://example.test/pull/1",
    isDraft: false,
    ci: "pending" as const,
    review: null,
  },
  ...over,
});

describe("cmux sidebar", () => {
  it("refreshes sessions from lifecycle events and restarts a stopped stream", async () => {
    vi.useFakeTimers();
    try {
      let resolveEnd!: () => void;
      let firstLine: ((line: string) => void) | undefined;
      const starts = vi.fn((_cursor: string, onLine: (line: string) => void) => {
        firstLine = onLine;
        return {
          stop: vi.fn(),
          ended: new Promise<void>((resolve) => {
            resolveEnd = resolve;
          }),
        };
      });
      const changed = vi.fn();
      const events = startCmuxEvents({
        cmux: { events: starts },
        cursorFile: "/tmp/cursor",
        onChange: changed,
      });
      expect(starts).toHaveBeenCalledTimes(1);
      if (firstLine === undefined) throw new Error("cmux events callback was not registered");
      firstLine('{"type":"workspace.created","workspace_id":"new"}');
      expect(changed).toHaveBeenCalledWith({ kind: "created", workspaceId: "new" });
      resolveEnd();
      await vi.advanceTimersByTimeAsync(5000);
      expect(starts).toHaveBeenCalledTimes(2);
      events.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes an opened and closed workspace reach a fresh page view within two seconds", async () => {
    let cached = true;
    let open = false;
    const invalidate = vi.fn(() => {
      cached = false;
    });
    const view = vi.fn(async () => ({
      ok: true as const,
      at: 0,
      sessions: cached ? [] : open ? [row()] : [],
      repos: [],
    }));
    const bus = new ChangeBus();
    const emitted = vi.fn();
    bus.subscribe(emitted);
    const sidebar = { tick: vi.fn(async () => {}) };
    await view();
    open = true;
    applyCmuxSessionEvent({ sessions: { invalidate }, bus, sidebar });
    await vi.waitFor(async () => expect((await view()).sessions).toHaveLength(1), {
      timeout: 2000,
    });
    expect(emitted).toHaveBeenCalledWith("sessions");
    open = false;
    applyCmuxSessionEvent({ sessions: { invalidate }, bus, sidebar });
    await vi.waitFor(async () => expect((await view()).sessions).toHaveLength(0), {
      timeout: 2000,
    });
  });

  it("writes a pull request and only changed CI state", async () => {
    const current = [row()];
    const cmux = {
      statuses: vi.fn(async () => ({})),
      setStatus: vi.fn(async () => {}),
      clearStatus: vi.fn(async () => {}),
      linkPr: vi.fn(async () => {}),
      clearPr: vi.fn(async () => {}),
      notify: vi.fn(async () => {}),
    };
    const sidebar = createSessionSidebar({
      sessions: { view: async () => ({ ok: true as const, at: 0, sessions: current, repos: [] }) },
      cmux,
      store: { getSetting: () => null },
    });
    await sidebar.tick();
    expect(cmux.linkPr).toHaveBeenCalledWith("workspace", "https://example.test/pull/1");
    expect(cmux.setStatus).toHaveBeenCalledWith("workspace", "mc-ci", "CI running");
    cmux.setStatus.mockClear();
    await sidebar.tick();
    expect(cmux.setStatus).not.toHaveBeenCalled();
  });

  it("makes no writes when the operator turns them off", async () => {
    const cmux = {
      statuses: vi.fn(),
      setStatus: vi.fn(),
      clearStatus: vi.fn(),
      linkPr: vi.fn(),
      clearPr: vi.fn(),
      notify: vi.fn(),
    };
    const sidebar = createSessionSidebar({
      sessions: { view: async () => ({ ok: true as const, at: 0, sessions: [row()], repos: [] }) },
      cmux,
      store: { getSetting: () => "off" },
    });
    await sidebar.tick();
    expect(cmux.setStatus).not.toHaveBeenCalled();
    expect(cmux.linkPr).not.toHaveBeenCalled();
  });

  it("stops a pending tick when writes turn off", async () => {
    let resolveView!: () => void;
    let on = true;
    const cmux = {
      statuses: vi.fn(async () => ({})),
      setStatus: vi.fn(async () => {}),
      clearStatus: vi.fn(async () => {}),
      linkPr: vi.fn(async () => {}),
      clearPr: vi.fn(async () => {}),
      notify: vi.fn(async () => {}),
    };
    const sidebar = createSessionSidebar({
      sessions: {
        view: () =>
          new Promise((resolve) => {
            resolveView = () => resolve({ ok: true, at: 0, sessions: [row()], repos: [] });
          }),
      },
      cmux,
      store: { getSetting: () => (on ? null : "off") },
    });
    const tick = sidebar.tick();
    await Promise.resolve();
    on = false;
    resolveView();
    await tick;
    expect(cmux.setStatus).not.toHaveBeenCalled();
    expect(cmux.linkPr).not.toHaveBeenCalled();
    expect(cmux.notify).not.toHaveBeenCalled();
  });

  it("serializes overlapping ticks", async () => {
    let release!: () => void;
    const cmux = {
      statuses: vi.fn(
        () =>
          new Promise<Record<string, string>>((resolve) => {
            release = () => resolve({});
          }),
      ),
      setStatus: vi.fn(async () => {}),
      clearStatus: vi.fn(async () => {}),
      linkPr: vi.fn(async () => {}),
      clearPr: vi.fn(async () => {}),
      notify: vi.fn(async () => {}),
    };
    const sidebar = createSessionSidebar({
      sessions: { view: async () => ({ ok: true as const, at: 0, sessions: [row()], repos: [] }) },
      cmux,
      store: { getSetting: () => null },
    });
    const one = sidebar.tick();
    const two = sidebar.tick();
    await vi.waitFor(() => expect(cmux.statuses).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([one, two]);
    expect(cmux.linkPr).toHaveBeenCalledTimes(1);
    expect(cmux.setStatus).toHaveBeenCalledTimes(1);
  });

  it("clears remembered mc keys, but not foreign keys", async () => {
    const cmux = {
      statuses: vi.fn(async () => ({ "mc-ci": "CI running", build: "running" })),
      setStatus: vi.fn(async () => {}),
      clearStatus: vi.fn(async () => {}),
      linkPr: vi.fn(async () => {}),
      clearPr: vi.fn(async () => {}),
      notify: vi.fn(async () => {}),
    };
    const sidebar = createSessionSidebar({
      sessions: {
        view: async () => ({ ok: true as const, at: 0, sessions: [row({ pr: null })], repos: [] }),
      },
      cmux,
      store: { getSetting: () => null },
    });
    await sidebar.tick();
    expect(cmux.clearStatus).toHaveBeenCalledWith("workspace", "mc-ci");
    expect(cmux.clearStatus).not.toHaveBeenCalledWith("workspace", "build");
  });

  it("does not write or notify from a preview hub", async () => {
    const cmux = {
      statuses: vi.fn(async () => ({})),
      setStatus: vi.fn(async () => {}),
      clearStatus: vi.fn(async () => {}),
      linkPr: vi.fn(async () => {}),
      clearPr: vi.fn(async () => {}),
      notify: vi.fn(async () => {}),
    };
    const sidebar = createSessionSidebar({
      sessions: {
        view: async () => ({
          ok: true as const,
          at: 0,
          sessions: [row({ state: "waiting" })],
          repos: [],
        }),
      },
      cmux,
      store: { getSetting: () => null },
      writes: false,
    });
    await sidebar.tick();
    await sidebar.notify("workspace", "waiting", "question");
    expect(cmux.setStatus).not.toHaveBeenCalled();
    expect(cmux.linkPr).not.toHaveBeenCalled();
    expect(cmux.notify).not.toHaveBeenCalled();
  });

  it("writes cost and failed checks, then notifies one operator transition", async () => {
    const current = [row({ state: "idle" })];
    const cmux = {
      statuses: vi.fn(async () => ({})),
      setStatus: vi.fn(async () => {}),
      clearStatus: vi.fn(async () => {}),
      linkPr: vi.fn(async () => {}),
      clearPr: vi.fn(async () => {}),
      notify: vi.fn(async () => {}),
    };
    const sidebar = createSessionSidebar({
      sessions: { view: async () => ({ ok: true as const, at: 0, sessions: current, repos: [] }) },
      cmux,
      store: { getSetting: () => null },
      costToday: () => 1.24,
      lastCheck: () => ({ ok: false, command: "pnpm -s lint", at: 0 }),
    });
    await sidebar.tick();
    expect(cmux.setStatus).toHaveBeenCalledWith("workspace", "mc-cost", "~$1.24 today");
    expect(cmux.setStatus).toHaveBeenCalledWith(
      "workspace",
      "mc-check",
      "Checks failed: pnpm -s lint",
    );
    current[0] = row({ state: "waiting" });
    await sidebar.tick();
    expect(cmux.notify).toHaveBeenCalledWith("workspace", "Waiting on you", expect.any(String));
    cmux.notify.mockClear();
    await sidebar.tick();
    expect(cmux.notify).not.toHaveBeenCalled();
  });

  it("notifies both a finish and an app stop in one transition", async () => {
    const current = [row({ state: "working", app: { url: "http://app.test", answers: true } })];
    const cmux = {
      statuses: vi.fn(async () => ({})),
      setStatus: vi.fn(async () => {}),
      clearStatus: vi.fn(async () => {}),
      linkPr: vi.fn(async () => {}),
      clearPr: vi.fn(async () => {}),
      notify: vi.fn(async () => {}),
    };
    const sidebar = createSessionSidebar({
      sessions: { view: async () => ({ ok: true as const, at: 0, sessions: current, repos: [] }) },
      cmux,
      store: { getSetting: () => null },
    });
    await sidebar.tick();
    current[0] = row({ state: "idle", app: { url: "http://app.test", answers: false } });
    await sidebar.tick();
    expect(cmux.notify).toHaveBeenCalledWith("workspace", "Finished", expect.any(String));
    expect(cmux.notify).toHaveBeenCalledWith("workspace", "App stopped", expect.any(String));
    cmux.notify.mockClear();
    await sidebar.tick();
    expect(cmux.notify).not.toHaveBeenCalled();
  });

  it("clears only a PR link it created when a branch has no PR", async () => {
    const current = [row()];
    let on = true;
    const cmux = {
      statuses: vi.fn(async () => ({})),
      setStatus: vi.fn(async () => {}),
      clearStatus: vi.fn(async () => {}),
      linkPr: vi.fn(async () => {}),
      clearPr: vi.fn(async () => {}),
      notify: vi.fn(async () => {}),
    };
    const sidebar = createSessionSidebar({
      sessions: { view: async () => ({ ok: true as const, at: 0, sessions: current, repos: [] }) },
      cmux,
      store: { getSetting: () => (on ? null : "off") },
    });
    await sidebar.tick();
    current[0] = row({ pr: { ...row().pr, url: "https://example.test/pull/2" } });
    await sidebar.tick();
    expect(cmux.linkPr).toHaveBeenLastCalledWith("workspace", "https://example.test/pull/2");
    current[0] = row({ pr: null });
    await sidebar.tick();
    expect(cmux.clearPr).toHaveBeenCalledWith("workspace");
    cmux.clearPr.mockClear();
    await sidebar.tick();
    expect(cmux.clearPr).not.toHaveBeenCalled();
    on = false;
    current[0] = row();
    await sidebar.tick();
    expect(cmux.linkPr).toHaveBeenCalledTimes(2);
  });
});
