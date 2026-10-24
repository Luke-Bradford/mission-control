import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, vi } from "vitest";
import { dir, make, recordFile } from "./supervisor-harness.ts";

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: vi.fn(original.homedir) };
});
afterEach(() => {
  vi.mocked(homedir).mockReset();
});

/** Direct supervisor deps only: configuration continues refusing Codex seats. */
export function codexSupervisor(scenario: Record<string, unknown> = {}) {
  const home = join(dir, "home");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "auth.json"), "{}", { mode: 0o600 });
  vi.mocked(homedir).mockReturnValue(home);
  const command = join(dir, "codex");
  const fixture = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
  writeFileSync(
    command,
    `#!${process.execPath}
process.env.FAKE_CODEX_RECORD = ${JSON.stringify(recordFile)};
process.env.FAKE_CODEX_SCENARIO = ${JSON.stringify(JSON.stringify({ persistThread: true, ...scenario }))};
import(${JSON.stringify(fixture)});
`,
    { mode: 0o700 },
  );
  const made = make({ codexCommand: command, repo: { fullSuite: ["pnpm -s test"] } });
  const account = made.cfg.accounts[0];
  if (account) account.vendor = "codex";
  const seat = made.cfg.crew?.sessions[0]?.seats[0];
  if (seat) seat.model = "gpt-5.4";
  return made;
}
