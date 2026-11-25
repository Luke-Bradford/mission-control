import { describe, expect, it } from "vitest";
import { parseAgents, parseInbox, parseStatuses, parseWorkspaces } from "../src/runtime/cmux.ts";

describe("cmux parsers", () => {
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
});
