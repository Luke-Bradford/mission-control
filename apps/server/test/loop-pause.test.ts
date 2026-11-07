import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoardItem } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdoptedLoop } from "../src/config.ts";
import { loopPause } from "../src/loop-pause.ts";
import { Store } from "../src/store.ts";

let dir: string;
let store: Store;
const loop = (pausedBy: AdoptedLoop["pausedBy"]): AdoptedLoop => ({
  id: "studio",
  repoId: "site",
  kind: "studio-loop",
  accountId: "a",
  stateDir: dir,
  worktree: dir,
  launchdLabel: "com.x.studio",
  pausedBy,
});
const row = (closed: boolean): BoardItem =>
  ({
    repoId: "autonomy-engine",
    issueNumber: 1818,
    title: "pause",
    status: "Todo",
    state: "planned",
    labels: [],
    priority: null,
    updatedAt: 1,
    url: "u",
    stage: null,
    owner: null,
    parent: null,
    subIssues: null,
    blockedBy: [],
    milestone: null,
    size: null,
    closed,
    prioritySource: null,
    createdAt: 1,
    itemId: null,
    projectId: null,
  }) as BoardItem;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-loop-pause-"));
  store = new Store(join(dir, "db.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("loopPause", () => {
  const issue = { issue: { repoId: "autonomy-engine", number: 1818 } };
  const slug = (id: string) => (id === "autonomy-engine" ? "o/autonomy-engine" : undefined);

  it("a loop with no paused_by is not paused", () => {
    expect(loopPause(loop(undefined), store)).toEqual({ paused: false, by: null, url: null });
  });

  it("a stop file pauses the loop only while it exists", () => {
    const stop = join(dir, "STOP");
    expect(loopPause(loop({ stopFile: stop }), store).paused).toBe(false);
    writeFileSync(stop, "");
    expect(loopPause(loop({ stopFile: stop }), store).paused).toBe(true);
  });

  it("an open pause issue pauses the loop and gives its page; a closed one does not", () => {
    store.replaceBoard("autonomy-engine", [row(false)]);
    expect(loopPause(loop(issue), store, slug)).toEqual({
      paused: true,
      by: "autonomy-engine#1818",
      url: "https://github.com/o/autonomy-engine/issues/1818",
    });
    store.replaceBoard("autonomy-engine", [row(true)]);
    expect(loopPause(loop(issue), store, slug)).toEqual({ paused: false, by: null, url: null });
  });
});
