import { describe, expect, it, vi } from "vitest";
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
  it("writes a pull request and only changed CI state", async () => {
    const current = [row()];
    const cmux = {
      statuses: vi.fn(async () => ({})),
      setStatus: vi.fn(async () => {}),
      clearStatus: vi.fn(async () => {}),
      linkPr: vi.fn(async () => {}),
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

  it("clears remembered mc keys, but not foreign keys", async () => {
    const cmux = {
      statuses: vi.fn(async () => ({ "mc-ci": "CI running", build: "running" })),
      setStatus: vi.fn(async () => {}),
      clearStatus: vi.fn(async () => {}),
      linkPr: vi.fn(async () => {}),
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
});
