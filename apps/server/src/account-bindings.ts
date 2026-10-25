import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Store } from "./store.ts";

export interface CliBinding {
  vendor: "claude" | "codex";
  cliProfile?: string;
}

export const codexProfile = (account: CliBinding): string =>
  account.cliProfile ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");

/** No credentials or provider identities leave this validation boundary. */
export function accountBindingProblem(accounts: readonly CliBinding[]): string | null {
  const paths = new Set<string>();
  const logins = new Set<string>();
  const codexCount = accounts.filter((a) => a.vendor === "codex").length;
  const profiles: { account: CliBinding; path: string }[] = [];
  for (const account of accounts) {
    if (account.cliProfile !== undefined && account.vendor !== "codex")
      return "Claude cannot isolate an independently logged-in CLI profile; use its machine login";
    if (account.cliProfile !== undefined && !isAbsolute(account.cliProfile))
      return "CLI profile must be an absolute directory";
    let path = account.vendor === "codex" ? codexProfile(account) : "machine";
    try {
      path = realpathSync(path);
    } catch {
      path = resolve(path);
    }
    const key = `${account.vendor}:${path}`;
    if (paths.has(key)) return "two account labels cannot use the same CLI profile";
    paths.add(key);
    profiles.push({ account, path });
  }
  for (const { account, path } of profiles) {
    if (account.vendor !== "codex" || (account.cliProfile === undefined && codexCount === 1))
      continue;
    let login: unknown;
    try {
      login = JSON.parse(readFileSync(join(path, "auth.json"), "utf8"))?.tokens?.account_id;
    } catch {
      // Fixed error text: JSON errors may contain credential bytes.
    }
    if (typeof login !== "string" || login.length === 0)
      return "Codex profile must be already logged in with the provider CLI outside Mission Control";
    if (logins.has(login)) return "two account labels cannot use the same Codex login";
    logins.add(login);
  }
  return null;
}

/** Only a completed seat transfer changes the HUD's account label. */
export function runAccountId(store: Store, runId: string | null, configured: string): string {
  if (runId === null) return configured;
  const text = store.getSetting(`account-transfer:${runId}`);
  if (text === null) return configured;
  const binding = JSON.parse(text) as { source: string; target: string; pending: boolean };
  return binding.pending ? binding.source : binding.target;
}
