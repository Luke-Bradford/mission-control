import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cmuxSeatWorkspaceKey,
  reconcileCmuxSeatWorkspaces,
} from "../src/runtime/cmux-seat-workspaces.ts";
import { Store } from "../src/store.ts";
import { fakeCmux } from "./fake-cmux-harness.ts";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("durable cmux seat workspaces", () => {
  it("keeps one owned workspace per configured seat and leaves operator workspaces alone", async () => {
    dir = mkdtempSync(join(tmpdir(), "mc-cmux-seat-group-"));
    const store = new Store(join(dir, "mc.sqlite"));
    const fake = fakeCmux(dir, { workspaces: [{ id: "operator", name: "Notes" }] });
    const seats = [
      { id: "flight-1", repo: "mission-control", cwd: dir },
      { id: "guido-1", repo: "mission-control", cwd: dir },
    ];
    await reconcileCmuxSeatWorkspaces({ cmux: fake.cmux, store, seats, hubUrl: "http://hub.test" });
    await reconcileCmuxSeatWorkspaces({ cmux: fake.cmux, store, seats, hubUrl: "http://hub.test" });
    const state = fake.state();
    expect(state.workspaces?.filter((workspace) => workspace.name !== "Notes")).toHaveLength(3);
    expect(state.workspaces?.find((workspace) => workspace.id === "operator")?.name).toBe("Notes");
    expect(state.groups?.[0]).toMatchObject({ external_id: "mission-control" });
    expect(state.groups?.[0]?.workspace_ids).toEqual([
      state.groups?.[0]?.anchor_workspace_id,
      store.getSetting(cmuxSeatWorkspaceKey("flight-1")),
      store.getSetting(cmuxSeatWorkspaceKey("guido-1")),
    ]);
    expect(state.groups?.[0]?.workspace_ids).not.toContain("operator");
    expect(state.panes).toContainEqual({
      ws: state.groups?.[0]?.anchor_workspace_id,
      type: "browser",
      url: "http://hub.test",
    });
    await reconcileCmuxSeatWorkspaces({
      cmux: fake.cmux,
      store,
      seats: [seats[0] as (typeof seats)[number]],
      hubUrl: "http://hub.test",
    });
    expect(fake.state().closed).toContain(store.getSetting(cmuxSeatWorkspaceKey("guido-1")));
    store.close();
  });

  it("serializes overlapping reconciliation", async () => {
    dir = mkdtempSync(join(tmpdir(), "mc-cmux-seat-group-"));
    const store = new Store(join(dir, "mc.sqlite"));
    const fake = fakeCmux(dir, { workspaces: [{ id: "operator", name: "Notes" }] });
    const seats = [
      { id: "flight-1", repo: "mission-control", cwd: dir },
      { id: "guido-1", repo: "mission-control", cwd: dir },
    ];
    await Promise.all([
      reconcileCmuxSeatWorkspaces({ cmux: fake.cmux, store, seats, hubUrl: "http://hub.test" }),
      reconcileCmuxSeatWorkspaces({ cmux: fake.cmux, store, seats, hubUrl: "http://hub.test" }),
    ]);
    const state = fake.state();
    expect(state.groups).toHaveLength(1);
    expect(state.workspaces?.filter((workspace) => workspace.name !== "Notes")).toHaveLength(3);
    expect(state.groups?.[0]?.workspace_ids).toEqual([
      state.groups?.[0]?.anchor_workspace_id,
      store.getSetting(cmuxSeatWorkspaceKey("flight-1")),
      store.getSetting(cmuxSeatWorkspaceKey("guido-1")),
    ]);
    expect(state.groups?.[0]?.workspace_ids).not.toContain("operator");
    store.close();
  });

  it("replaces only the stored legacy anchor with cmux's group anchor", async () => {
    dir = mkdtempSync(join(tmpdir(), "mc-cmux-seat-group-"));
    const store = new Store(join(dir, "mc.sqlite"));
    store.setSetting("cmux.mission-control-anchor", "legacy-anchor");
    const fake = fakeCmux(dir, {
      workspaces: [
        { id: "operator", name: "Notes" },
        { id: "group-anchor", name: "Mission Control" },
        { id: "legacy-anchor", name: "Mission Control" },
      ],
      groups: [
        {
          id: "mission-control",
          external_id: "mission-control",
          name: "Mission Control",
          anchor_workspace_id: "group-anchor",
          workspace_ids: ["group-anchor", "legacy-anchor"],
        },
      ],
    });
    await reconcileCmuxSeatWorkspaces({
      cmux: fake.cmux,
      store,
      seats: [{ id: "flight-1", repo: "mission-control", cwd: dir }],
      hubUrl: "http://hub.test",
    });
    const state = fake.state();
    expect(state.closed).toEqual(["legacy-anchor"]);
    expect(state.workspaces?.some((workspace) => workspace.id === "operator")).toBe(true);
    expect(state.groups?.[0]?.workspace_ids).toEqual([
      "group-anchor",
      store.getSetting(cmuxSeatWorkspaceKey("flight-1")),
    ]);
    expect(state.panes).toContainEqual({
      ws: "group-anchor",
      type: "browser",
      url: "http://hub.test",
    });
    store.close();
  });
});
