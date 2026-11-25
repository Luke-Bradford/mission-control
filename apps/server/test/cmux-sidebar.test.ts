import { describe, expect, it, vi } from "vitest";
import { createSessionSidebar } from "../src/sessions/sidebar.ts";

const row = (over: Record<string, unknown> = {}) => ({
  id: "workspace",
  name: "operator",
  owner: "operator" as const,
  folder: null,
  repo: null,
  state: "working" as const,
  since: 0,
  lastLine: null,
  status: null,
  app: null,
  inbox: { unread: 0, newest: null },
  branch: "feature/2262-cmux-sidebar",
  ticket: { number: 2262, repoId: "mc" },
  pr: { number: 1, url: "https://example.test/pull/1", isDraft: false, ci: "pending" as const, review: null },
  ...over,
});

describe("cmux sidebar", () => {
  it("writes a pull request and only changed CI state", async () => {
    const current = [row()];
    const cmux = { setStatus: vi.fn(async () => {}), clearStatus: vi.fn(async () => {}), linkPr: vi.fn(async () => {}), notify: vi.fn(async () => {}) };
    const sidebar = createSessionSidebar({ sessions: { view: async () => ({ ok: true as const, at: 0, sessions: current }) }, cmux, store: { getSetting: () => null } });
    await sidebar.tick();
    expect(cmux.linkPr).toHaveBeenCalledWith("workspace", "https://example.test/pull/1");
    expect(cmux.setStatus).toHaveBeenCalledWith("workspace", "mc-ci", "CI running");
    cmux.setStatus.mockClear();
    await sidebar.tick();
    expect(cmux.setStatus).not.toHaveBeenCalled();
  });

  it("makes no writes when the operator turns them off", async () => {
    const cmux = { setStatus: vi.fn(), clearStatus: vi.fn(), linkPr: vi.fn(), notify: vi.fn() };
    const sidebar = createSessionSidebar({ sessions: { view: async () => ({ ok: true as const, at: 0, sessions: [row()] }) }, cmux, store: { getSetting: () => "off" } });
    await sidebar.tick();
    expect(cmux.setStatus).not.toHaveBeenCalled();
    expect(cmux.linkPr).not.toHaveBeenCalled();
  });
});
