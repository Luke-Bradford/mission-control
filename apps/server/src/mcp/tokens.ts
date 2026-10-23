import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface RunIdentity {
  seatId: string;
  runId: string;
  /** The SHA-256 (hex) of the token that named this identity. */
  tokenHash: string;
}

interface Entry {
  seatId: string;
  runId: string;
  hash: Buffer;
}

const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest();

/**
 * Per-run bearer tokens (32 random bytes, hex). Memory holds only each token's SHA-256, never the
 * token. `resolve` looks the hash up, then compares it in constant time.
 */
export class RunTokens {
  private readonly byHash = new Map<string, Entry>();

  issue(seatId: string, runId: string): string {
    const token = randomBytes(32).toString("hex");
    const hash = sha256(token);
    this.byHash.set(hash.toString("hex"), { seatId, runId, hash });
    return token;
  }

  /** Registers a token an earlier hub issued for this run; true when adopted. */
  adopt(seatId: string, runId: string, token: string): boolean {
    if (!/^[0-9a-f]{64}$/.test(token)) return false;
    const hash = sha256(token);
    this.byHash.set(hash.toString("hex"), { seatId, runId, hash });
    return true;
  }

  resolve(token: unknown): RunIdentity | null {
    if (typeof token !== "string" || token === "") return null;
    const hash = sha256(token);
    const entry = this.byHash.get(hash.toString("hex"));
    if (entry === undefined || !timingSafeEqual(entry.hash, hash)) return null;
    return { seatId: entry.seatId, runId: entry.runId, tokenHash: hash.toString("hex") };
  }

  /** Whether this very token (by hash, from `resolve`) is still issued: a resume's new token is not it. */
  live(tokenHash: string): boolean {
    return this.byHash.has(tokenHash);
  }

  /** Drops every token the run holds (its process ended, or it was resumed with a new one). */
  revoke(runId: string): void {
    for (const [key, e] of this.byHash) if (e.runId === runId) this.byHash.delete(key);
  }
}
