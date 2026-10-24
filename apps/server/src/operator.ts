import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The operator token's file in the hub's data dir, which every seat's sandbox denies reads of. */
export const OPERATOR_TOKEN_FILE = "operator-token";
export const BOOTSTRAP_REFUSED = "the operator token is for the HUD page only";

export function newOperatorToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Overwrites the token file (0600) and returns its path. */
export function writeOperatorToken(dataDir: string, token: string): string {
  const path = join(dataDir, OPERATOR_TOKEN_FILE);
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600); // tighten a file an earlier boot left behind, too
  return path;
}

export function operatorTokenMatches(expected: string, given: unknown): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
