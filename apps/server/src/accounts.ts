import { execFile } from "node:child_process";
import type { CliAccountStatus } from "@mc/core";
import { type CliBinding, codexProfile } from "./account-bindings.ts";
import { isObj } from "./collectors/usage-common.ts";
import { usageProviderEnv } from "./collectors/usage-sources.ts";

type Account = CliBinding & { id: string };
const MAX_BUFFER = 64 * 1024;
const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= 200 && !/\p{Cc}/u.test(value)
    ? value
    : null;

/** Read-only CLI commands inherit the usage collectors' machine environment; no token files. */
export async function readAccountStatus(
  account: Account,
  now: number,
  deps: { timeoutMs?: number } = {},
): Promise<CliAccountStatus> {
  const result: CliAccountStatus = {
    accountId: account.id,
    provider: account.vendor,
    binding: account.cliProfile === undefined ? "machine" : "profile",
    identity: null,
    plan: null,
    status: "unknown",
    checkedAt: now,
    detail: null,
  };
  try {
    const raw = await cliStatus(account, deps.timeoutMs ?? 5000);
    if (!isObj(raw)) throw new Error("malformed");
    if (account.vendor === "claude") {
      if (typeof raw.loggedIn !== "boolean") throw new Error("malformed");
      result.status = raw.loggedIn ? "logged-in" : "not-logged-in";
      if (raw.loggedIn) {
        result.identity = text(raw.email);
        result.plan = text(raw.subscriptionType);
      }
    } else {
      if (raw.account === null) result.status = "not-logged-in";
      else if (
        isObj(raw.account) &&
        (raw.account.type === "chatgpt" || raw.account.type === "apiKey")
      ) {
        result.status = "logged-in";
        result.identity = text(raw.account.email);
        result.plan = text(raw.account.planType);
      } else throw new Error("malformed");
    }
  } catch (e) {
    result.detail =
      e instanceof Error && e.message === "timeout"
        ? "CLI status timed out"
        : e instanceof Error && e.message === "malformed"
          ? "CLI status output was not recognised"
          : "CLI status unavailable; sign in with the provider CLI on this machine";
  }
  return result;
}

function cliStatus(account: Account, timeoutMs: number): Promise<unknown> {
  const provider = account.vendor;
  return new Promise((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: Error | null, value?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(value);
    };
    const child = execFile(
      provider,
      provider === "claude" ? ["auth", "status", "--json"] : ["app-server"],
      {
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        env: {
          ...usageProviderEnv(provider),
          ...(provider === "codex" && account.cliProfile !== undefined
            ? { CODEX_HOME: codexProfile(account) }
            : {}),
        },
      },
      (error, stdout) => {
        if (provider === "codex") {
          finish(new Error(error?.killed ? "timeout" : "unavailable"));
          return;
        }
        // Claude can exit nonzero when logged out; only accept its structured status.
        if (error?.killed) return finish(new Error("timeout"));
        try {
          finish(null, JSON.parse(stdout));
        } catch {
          finish(new Error(error ? "unavailable" : "malformed"));
        }
      },
    );
    child.on("error", () => finish(new Error("unavailable")));
    timer = setTimeout(() => finish(new Error("timeout")), timeoutMs);
    if (provider !== "codex") return;
    let buffer = "";
    let total = 0;
    const send = (message: unknown) => child.stdin?.write(`${JSON.stringify(message)}\n`);
    child.stdin?.on("error", () => finish(new Error("unavailable")));
    child.stdout?.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BUFFER) return finish(new Error("unavailable"));
      buffer += chunk.toString("utf8");
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return finish(new Error("malformed"));
        }
        if (!isObj(message)) return finish(new Error("malformed"));
        if (message.id === 1) {
          if (message.error !== undefined) return finish(new Error("unavailable"));
          send({ method: "initialized" });
          send({ id: 2, method: "account/read", params: { refreshToken: false } });
        } else if (message.id === 2) {
          if (message.error !== undefined) return finish(new Error("unavailable"));
          finish(null, message.result);
        }
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "mission-control", title: "Mission Control", version: "0.0.0" },
      },
    });
  });
}
