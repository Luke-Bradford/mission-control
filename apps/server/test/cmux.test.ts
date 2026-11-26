import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseAgents,
  parseCmuxEvent,
  parseInbox,
  parseStatuses,
  parseWindows,
  parseWorkspaces,
} from "../src/runtime/cmux.ts";
import { fakeCmux } from "./fake-cmux-harness.ts";

describe("cmux parsers", () => {
  it("reads workspace lifecycle events and rejects unrelated lines", () => {
    expect(
      parseCmuxEvent(
        '{"type":"event","name":"workspace.created","workspace_id":"one","id":"event-one"}',
      ),
    ).toEqual({
      kind: "created",
      workspaceId: "one",
    });
    expect(
      parseCmuxEvent(
        '{"type":"event","name":"workspace.closed","workspace_id":"two","id":"event-two"}',
      ),
    ).toEqual({
      kind: "closed",
      workspaceId: "two",
    });
    expect(parseCmuxEvent('{"type":"sidebar.metadata.updated"}')).toBeNull();
    expect(parseCmuxEvent("not json")).toBeNull();
  });
  it("reads a workspace's folder under any of its names", () => {
    expect(
      parseWorkspaces(
        JSON.stringify({
          workspaces: [
            { id: "a", title: "pricing", cwd: "/w/a" },
            { id: "b", title: "shop", current_directory: "/w/b" },
            { id: "c", title: "bare" },
            { title: "no id" },
          ],
        }),
      ),
    ).toEqual([
      { id: "a", name: "pricing", cwd: "/w/a" },
      { id: "b", name: "shop", cwd: "/w/b" },
      { id: "c", name: "bare", cwd: null },
    ]);
  });

  it("reads an agent's folder", () => {
    const [agent] = parseAgents(
      JSON.stringify({
        sessions: [
          { session_id: "s", agent_lifecycle: "needsInput", workspace_id: "w", cwd: "/w" },
        ],
      }),
    );
    expect(agent).toMatchObject({ lifecycle: "needsInput", cwd: "/w", pid: null });
  });

  it("reads statuses as JSON or as lines", () => {
    expect(parseStatuses("app=http://localhost:5173\ntask: migrating\nnote\tok\n")).toEqual({
      app: "http://localhost:5173",
      task: "migrating",
      note: "ok",
    });
    expect(parseStatuses(JSON.stringify([{ key: "app", value: "http://x" }]))).toEqual({
      app: "http://x",
    });
    expect(parseStatuses(JSON.stringify({ statuses: { task: { value: "busy" } } }))).toEqual({
      task: "busy",
    });
    expect(parseStatuses("")).toEqual({});
    expect(parseStatuses("No status entries")).toEqual({});
  });

  it("reads inbox messages with their workspace and whether they are read", () => {
    expect(
      parseInbox(
        JSON.stringify({
          messages: [
            { workspace_id: "w", text: "hi", state: "delivered" },
            { to: { workspaceId: "v" }, body: "old", state: "read" },
            { text: "nowhere" },
          ],
        }),
      ),
    ).toEqual([
      { workspaceId: "w", text: "hi", read: false },
      { workspaceId: "v", text: "old", read: true },
    ]);
  });

  it("reads real cmux's inbox rows, which name the workspace as the recipient", () => {
    expect(
      parseInbox(
        JSON.stringify({
          messages: [
            {
              id: "m1",
              recipient_workspace_id: "w",
              body: "hi",
              state: "delivered",
              read_at: null,
            },
            { id: "m2", recipientWorkspaceId: "v", body: "old", read_at: "2026-11-25T10:00:00Z" },
          ],
        }),
      ),
    ).toEqual([
      { workspaceId: "w", text: "hi", read: false },
      { workspaceId: "v", text: "old", read: true },
    ]);
  });

  it("reads the windows cmux has open", () => {
    expect(
      parseWindows(
        JSON.stringify({ windows: [{ id: "w1", index: 0 }, { window_id: "w2" }, { index: 2 }] }),
      ),
    ).toEqual(["w1", "w2"]);
    expect(parseWindows(JSON.stringify([{ uuid: "w3" }]))).toEqual(["w3"]);
    expect(parseWindows("not json")).toEqual([]);
  });
});

describe("closing a workspace", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mc-cmux-close-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const open = (linger: number, closeWaitMs: number) =>
    fakeCmux(
      dir,
      { linger, workspaces: [{ id: "old", ref: "workspace:1", name: "flight-1 · FLIGHT" }] },
      undefined,
      { closeWaitMs },
    );

  it("answers only once cmux stops listing it", async () => {
    const f = open(600, 5000);
    const t0 = Date.now();
    await f.cmux.close("old");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
    expect((await f.cmux.workspaces()).map((w) => w.id)).not.toContain("old");
    // a start after it never meets the old workspace of the same name
    await f.cmux.newWorkspace({ name: "flight-1 · FLIGHT", cwd: dir, command: "true" });
    expect(f.state().sameName ?? []).toEqual([]);
  });

  it("fails while cmux still lists it after the wait", async () => {
    const f = open(60_000, 300);
    await expect(f.cmux.close("old")).rejects.toThrow(/still lists workspace old/);
  });
});
