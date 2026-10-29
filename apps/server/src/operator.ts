import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
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

/** The sign-in code (this boot) and the browser session secret (kept across boots), both 0600. */
export const OPERATOR_LOGIN_FILE = "operator-login";
export const OPERATOR_SESSION_FILE = "operator-session";
/** The query parameter of the sign-in URL the hub logs. */
export const OPERATOR_LOGIN_PARAM = "operator-login";
const SESSION_MAX_AGE_S = 365 * 86_400;

/**
 * Who may read the operator token. A request header (sec-fetch-site) is not proof of a browser,
 * since any local process can send it. The proof is a cookie the hub sets only for the one-time
 * code it writes where seats cannot read: the data dir and the hub's own log.
 */
export class OperatorLogin {
  readonly cookieName: string;
  #code: string | null;
  readonly #session: string;

  constructor(port: number, session: string, code: string) {
    this.cookieName = `mc_operator_${port}`; // cookies ignore ports: keep a preview's apart
    this.#session = session;
    this.#code = code;
  }

  /** The code still waiting to be redeemed, or null once the operator has signed in. */
  get code(): string | null {
    return this.#code;
  }

  /** A correct code works once: the Set-Cookie value that signs the browser in, else null. */
  redeem(given: unknown): string | null {
    if (this.#code === null || !operatorTokenMatches(this.#code, given)) return null;
    this.#code = null;
    return `${this.cookieName}=${this.#session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_S}`;
  }

  /** Whether the request's Cookie header carries this hub's session. */
  signedIn(cookieHeader: unknown): boolean {
    if (typeof cookieHeader !== "string") return false;
    return cookieHeader.split(";").some((part) => {
      const at = part.indexOf("=");
      return (
        at > 0 &&
        part.slice(0, at).trim() === this.cookieName &&
        operatorTokenMatches(this.#session, part.slice(at + 1).trim())
      );
    });
  }
}

/** Reads (or creates) the session secret, makes a fresh code, and writes both files (0600). */
export function openOperatorLogin(dataDir: string, port: number): OperatorLogin {
  const sessionPath = join(dataDir, OPERATOR_SESSION_FILE);
  let session = "";
  try {
    session = readFileSync(sessionPath, "utf8").trim();
  } catch {
    // first boot
  }
  if (session.length < 43) {
    session = newOperatorToken();
    writeFileSync(sessionPath, `${session}\n`, { mode: 0o600 });
  }
  chmodSync(sessionPath, 0o600);
  const code = newOperatorToken();
  const loginPath = join(dataDir, OPERATOR_LOGIN_FILE);
  writeFileSync(loginPath, `${code}\n`, { mode: 0o600 });
  chmodSync(loginPath, 0o600);
  return new OperatorLogin(port, session, code);
}

export function operatorLoginUrl(port: number, code: string): string {
  return `http://127.0.0.1:${port}/?${OPERATOR_LOGIN_PARAM}=${code}`;
}

export function operatorTokenMatches(expected: string, given: unknown): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
