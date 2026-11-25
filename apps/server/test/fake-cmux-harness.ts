/** The fake `cmux` (fixtures/fake-cmux.mjs) with its state file, for the Sessions tests. */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Cmux, createCmux } from "../src/runtime/cmux.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-cmux.mjs", import.meta.url));

/** What fake-cmux.mjs keeps (see its header). */
export interface FakeState {
  workspaces?: { id: string; name: string; cwd?: string }[];
  sessions?: {
    session_id: string;
    lifecycle: string;
    pid: number | null;
    workspace_id: string;
    transcript_path: string | null;
    cwd?: string;
  }[];
  sent?: { ws: string; text: string; paste: boolean }[];
  keys?: { ws: string; key: string; force: boolean }[];
  closed?: string[];
  screens?: Record<string, string>;
  statuses?: Record<string, Record<string, string>>;
  selected?: string[];
  inbox?: { workspace_id: string; text: string; state: string }[];
  messages?: { to: string; from: string; text: string }[];
  panes?: { ws: string; type: string; url: string }[];
  [k: string]: unknown;
}

export interface FakeCmux {
  cmux: Cmux;
  state(): FakeState;
  patch(fn: (s: FakeState) => void): void;
  /** Every call's argv, read-only ones included, global options left in. */
  log(): string[][];
}

export function fakeCmux(
  dir: string,
  initial: FakeState,
  /** What brings cmux to the front; `true` by default, `false` for a failed activation. */
  activate: readonly string[] = ["/usr/bin/true"],
): FakeCmux {
  const file = join(dir, "cmux-state.json");
  writeFileSync(file, JSON.stringify(initial));
  const state = (): FakeState => JSON.parse(readFileSync(file, "utf8"));
  return {
    cmux: createCmux([process.execPath, FAKE, "--state", file], () => {}, { activate }),
    state,
    patch(fn) {
      const s = state();
      fn(s);
      writeFileSync(`${file}.t`, JSON.stringify(s));
      renameSync(`${file}.t`, file);
    },
    log: () =>
      existsSync(`${file}.log`)
        ? readFileSync(`${file}.log`, "utf8")
            .split("\n")
            .filter((l) => l !== "")
            .map((l) => JSON.parse(l) as string[])
        : [],
  };
}

/** The cmux command of a logged argv: its global options skipped (`agent inbox` for a sub-command). */
export function commandOf(argv: readonly string[]): string {
  let i = 0;
  while (argv[i]?.startsWith("--")) i += argv[i] === "--json" ? 1 : 2;
  return argv[i] === "agent" ? `agent ${argv[i + 1]}` : (argv[i] ?? "");
}
