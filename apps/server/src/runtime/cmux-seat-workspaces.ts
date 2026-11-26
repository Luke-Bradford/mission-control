import type { Cmux } from "./cmux.ts";

export const MISSION_CONTROL_GROUP_ID = "mission-control";
export const MISSION_CONTROL_GROUP_NAME = "Mission Control";
export const cmuxSeatWorkspaceKey = (seatId: string) => `cmux.seat-workspace:${seatId}`;
const seatWorkspaceRegistryKey = "cmux.seat-workspaces";

type Settings = Pick<import("../store.ts").Store, "getSetting" | "setSetting" | "deleteSetting">;

export type CmuxSeatWorkspace = { id: string; repo: string; cwd: string };

/** Reconciles only workspace ids previously written by the hub; operator workspaces are not touched. */
export async function reconcileCmuxSeatWorkspaces(input: {
  cmux: Cmux;
  store: Settings;
  seats: readonly { id: string; repo: string; cwd: string }[];
  hubUrl: string;
}): Promise<Record<string, string>> {
  const group = await input.cmux.ensureWorkspaceGroup({
    name: MISSION_CONTROL_GROUP_NAME,
    externalId: MISSION_CONTROL_GROUP_ID,
    color: "blue",
    icon: "satellite",
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
  let anchor = input.store.getSetting("cmux.mission-control-anchor");
  if (anchor === null || !present.has(anchor)) {
    anchor = await input.cmux.newWorkspace({
      name: MISSION_CONTROL_GROUP_NAME,
      cwd: process.cwd(),
      command: "zsh",
    });
    input.store.setSetting("cmux.mission-control-anchor", anchor);
    await input.cmux.openBrowser(anchor, input.hubUrl);
    present.set(anchor, { id: anchor, name: MISSION_CONTROL_GROUP_NAME, cwd: process.cwd() });
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
    input.store.setSetting(cmuxSeatWorkspaceKey(seat.id), workspace);
  }
  input.store.setSetting(seatWorkspaceRegistryKey, JSON.stringify(known));
  return known;
}
