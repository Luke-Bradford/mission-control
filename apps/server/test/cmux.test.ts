import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createCmux } from "../src/runtime/cmux.ts";

const fake = fileURLToPath(new URL("./fixtures/fake-cmux.mjs", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(initial: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "cmux-wrapper-"));
  dirs.push(dir);
  const state = join(dir, "state.json");
  writeFileSync(state, JSON.stringify({ sessions: [], calls: [], ...initial }));
  return { state, cmux: createCmux([process.execPath, fake, state]) };
}
const workspace = { name: "guido-1 · mc#42", cwd: "/w", command: "/run/launch.zsh" };

describe("cmux workspace discovery", () => {
  it("takes the new workspace, not an older one with the same name, from a short reference", async () => {
    const old = "aaaaaaaa-0000-0000-0000-000000000001";
    const { state, cmux } = setup({
      short: true,
      sessions: [{ workspace_id: old, name: workspace.name, n: 1, session_calls: 0 }],
    });
    const id = await cmux.newWorkspace(workspace);
    const sessions = JSON.parse(readFileSync(state, "utf8")).sessions;
    expect(id).not.toBe(old);
    expect(id).toBe(sessions[1].workspace_id);
  });

  it("waits for a delayed listing", async () => {
    const { state, cmux } = setup({ short: true, list_hidden: 2 });
    const id = await cmux.newWorkspace(workspace);
    expect(id).toBe(JSON.parse(readFileSync(state, "utf8")).sessions[0].workspace_id);
  });
});
