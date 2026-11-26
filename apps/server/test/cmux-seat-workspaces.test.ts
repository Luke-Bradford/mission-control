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
    expect(state.groups?.[0]?.workspace_ids).toEqual(
      expect.arrayContaining([
        store.getSetting(cmuxSeatWorkspaceKey("flight-1")),
        store.getSetting(cmuxSeatWorkspaceKey("guido-1")),
      ]),
    );
    await reconcileCmuxSeatWorkspaces({
      cmux: fake.cmux,
      store,
      seats: [seats[0] as (typeof seats)[number]],
      hubUrl: "http://hub.test",
    });
    expect(fake.state().closed).toContain(store.getSetting(cmuxSeatWorkspaceKey("guido-1")));
    store.close();
  });
});
