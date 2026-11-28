import type { Cmux } from "./cmux.ts";

export const MISSION_CONTROL_GROUP_ID = "mission-control";
export const MISSION_CONTROL_GROUP_NAME = "Mission Control";
const MISSION_CONTROL_GROUP_COLOR = "#3b82f6";
const MISSION_CONTROL_GROUP_ICON = "satellite";
export const cmuxSeatWorkspaceKey = (seatId: string) => `cmux.seat-workspace:${seatId}`;
const seatWorkspaceRegistryKey = "cmux.seat-workspaces";
const anchorWorkspaceKey = "cmux.mission-control-anchor";

type Settings = Pick<import("../store.ts").Store, "getSetting" | "setSetting" | "deleteSetting">;

export type CmuxSeatWorkspace = { id: string; repo: string; cwd: string };

/** One reconciliation at a time per hub store: startup and a first run can overlap. */
const reconciliationTails = new WeakMap<object, Promise<void>>();

/** Reconciles only workspace ids previously written by the hub; operator workspaces are not touched. */
export async function reconcileCmuxSeatWorkspaces(input: {
  cmux: Cmux;
  store: Settings;
  seats: readonly { id: string; repo: string; cwd: string }[];
  hubUrl: string;
}): Promise<Record<string, string>> {
  const key = input.store as object;
  const previous = reconciliationTails.get(key) ?? Promise.resolve();
  const work = previous.catch(() => {}).then(() => reconcile(input));
  const tail = work.then(
    () => undefined,
    () => undefined,
  );
  reconciliationTails.set(key, tail);
  try {
    return await work;
  } finally {
    if (reconciliationTails.get(key) === tail) reconciliationTails.delete(key);
  }
}

async function reconcile(input: {
  cmux: Cmux;
  store: Settings;
  seats: readonly { id: string; repo: string; cwd: string }[];
  hubUrl: string;
}): Promise<Record<string, string>> {
  const group = await input.cmux.ensureWorkspaceGroup({
    name: MISSION_CONTROL_GROUP_NAME,
    externalId: MISSION_CONTROL_GROUP_ID,
    color: MISSION_CONTROL_GROUP_COLOR,
    icon: MISSION_CONTROL_GROUP_ICON,
  });
  const known = JSON.parse(input.store.getSetting(seatWorkspaceRegistryKey) ?? "{}") as Record<
    string,
    string
  >;
  const present = new Map(
    (await input.cmux.workspaces()).map((workspace) => [workspace.id, workspace]),
  );
  const wanted = new Set(input.seats.map((seat) => seat.id));
  for (const [seatId, workspace] of Object.entries(known)) {
    if (!wanted.has(seatId) && present.has(workspace)) await input.cmux.close(workspace);
    if (!wanted.has(seatId)) delete known[seatId];
  }
  const savedAnchor = input.store.getSetting(anchorWorkspaceKey);
  let anchor = savedAnchor;
  if (group.anchorWorkspaceId !== null && present.has(group.anchorWorkspaceId)) {
    anchor = group.anchorWorkspaceId;
  }
  if (anchor === null || !present.has(anchor)) {
    anchor = await input.cmux.newWorkspace({
      name: MISSION_CONTROL_GROUP_NAME,
      cwd: process.cwd(),
      command: "zsh",
    });
    present.set(anchor, { id: anchor, name: MISSION_CONTROL_GROUP_NAME, cwd: process.cwd() });
  }
  // A hub which ran before we learned cmux creates its own anchor left a second, stored workspace.
  // It is hub-owned by that setting, so only that superseded workspace is safe to close.
  if (savedAnchor !== null && savedAnchor !== anchor && present.has(savedAnchor)) {
    await input.cmux.close(savedAnchor);
    present.delete(savedAnchor);
  }
  if (savedAnchor !== anchor) {
    input.store.setSetting(anchorWorkspaceKey, anchor);
    await input.cmux.openBrowser(anchor, input.hubUrl);
  }
  if (!group.workspaceIds.includes(anchor)) await input.cmux.addToWorkspaceGroup(group.id, anchor);
  for (const seat of input.seats) {
    let workspace = known[seat.id];
    if (workspace === undefined || !present.has(workspace)) {
      workspace = await input.cmux.newWorkspace({
        name: `${seat.id} · ${seat.repo}`,
        cwd: seat.cwd,
        command: "zsh",
      });
      known[seat.id] = workspace;
      present.set(workspace, { id: workspace, name: `${seat.id} · ${seat.repo}`, cwd: seat.cwd });
    }
    if (!group.workspaceIds.includes(workspace))
      await input.cmux.addToWorkspaceGroup(group.id, workspace);
    if (input.store.getSetting(`cmux.seat-ticket:${seat.id}`) === null)
      await input.cmux.setStatus(workspace, "mc-seat", "Idle");
    input.store.setSetting(cmuxSeatWorkspaceKey(seat.id), workspace);
  }
  input.store.setSetting(seatWorkspaceRegistryKey, JSON.stringify(known));
  return known;
}
