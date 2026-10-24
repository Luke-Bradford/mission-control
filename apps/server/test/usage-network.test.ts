import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { USAGE_RETRY_AFTER_MAX_MS } from "../src/collectors/usage-claude.ts";
import {
  appServer,
  fetchUsage,
  KEYCHAIN_SERVICE,
  OAUTH_USAGE_URL,
  UsageRateLimited,
} from "../src/collectors/usage-sources.ts";

const SECOND_MS = 1000;
const RETRY_SECONDS = 600;
const TOKEN = "tok_SECRET_123";
const keychain = async () => ({
  stdout: `${JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } })}\n`,
});
const okFetch = (status = 200, body: unknown = { five_hour: { utilization: 1 } }) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected rejection");
}

describe("fetchUsage", () => {
  beforeEach(() => vi.useFakeTimers({ now: Date.parse("2026-10-24T12:00:00Z") }));
  afterEach(() => vi.useRealTimers());
  it.each([
    [String(RETRY_SECONDS), RETRY_SECONDS * SECOND_MS, null],
    ["Sat, 24 Oct 2026 12:00:00 GMT", null, Date.parse("2026-10-24T12:00:00Z")],
    [null, null, null],
    ["invalid", null, null],
    ["1e20", null, null],
    ["-1", null, null],
    ["1.5", null, null],
    ["2026-10-24", null, null],
    ["Sat, 01 Jan 10000 00:00:00 GMT", null, null],
    ["Sat, 31 Feb 2026 12:00:00 GMT", null, null],
    [String(1e20), USAGE_RETRY_AFTER_MAX_MS, null],
    ["9".repeat(400), USAGE_RETRY_AFTER_MAX_MS, null],
  ])(
    "carries parsed Retry-After %s on a typed 429 without response secrets",
    async (header, ms, at) => {
      const f = vi.fn(
        async () =>
          new Response(TOKEN, {
            status: 429,
            headers: header === null ? {} : { "Retry-After": header },
          }),
      );
      const e = await failure(fetchUsage({ exec: keychain, fetch: f }));
      expect(e).toBeInstanceOf(UsageRateLimited);
      expect(e).toMatchObject({ retryAfterMs: ms, retryAt: at });
      expect(e.message).toBe("oauth usage request failed: HTTP 429");
      expect(JSON.stringify(e)).not.toContain(TOKEN);
      expect(e.stack).not.toContain(TOKEN);
    },
  );

  it("clamps distant HTTP dates in the constructor", () => {
    const now = Date.parse("2026-10-24T12:00:00Z");
    const e = new UsageRateLimited("Fri, 31 Dec 9999 23:59:59 GMT", now);
    expect(e.retryAt).toBe(now + USAGE_RETRY_AFTER_MAX_MS);
    expect(e.notBefore(now)).toBe(now + USAGE_RETRY_AFTER_MAX_MS);
  });

  it.each([
    "Sat, 24 Oct 2026 12:00:00 GMT",
    "Saturday, 24-Oct-26 12:00:00 GMT",
    "Sat Oct 24 12:00:00 2026",
  ])("accepts the HTTP date format %s", (value) => {
    const now = Date.parse("2026-10-24T12:00:00Z");
    expect(new UsageRateLimited(value, now).retryAt).toBe(now);
  });

  it("sends the keychain token to the exact URL with the beta header, no redirects", async () => {
    const exec = vi.fn(keychain);
    const f = okFetch();
    const r = await fetchUsage({ exec, fetch: f as unknown as typeof fetch });
    expect(r).toEqual({ five_hour: { utilization: 1 } });
    expect(exec).toHaveBeenCalledWith("security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
    ]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(OAUTH_USAGE_URL);
    expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(init.redirect).toBe("manual");
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(h["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(init.signal).toBeDefined();
  });

  it.each([
    ["429", () => okFetch(429), "HTTP 429"],
    ["3xx", () => okFetch(302), "HTTP 302"],
  ])("throws a fixed message on %s", async (_n, mk, msg) => {
    const e = await failure(fetchUsage({ exec: keychain, fetch: mk() as unknown as typeof fetch }));
    expect(e.message).toContain(msg);
    expect(e.message).not.toContain(TOKEN);
    expect(e.stack).not.toContain(TOKEN);
  });

  it("throws a fixed message when the keychain fails (even if its error quotes the token)", async () => {
    const exec = async () => {
      throw new Error(`failed ${TOKEN}`);
    };
    const e = await failure(fetchUsage({ exec, fetch: okFetch() as unknown as typeof fetch }));
    expect(e.message).toBe("keychain: could not read Claude credentials");
    expect(e.message).not.toContain(TOKEN);
    expect(e.stack).not.toContain(TOKEN);
  });

  it("throws a fixed message on malformed keychain JSON and on a missing token", async () => {
    for (const stdout of [`{"claudeAiOauth": ${TOKEN}`, "{}", `"${TOKEN}"`]) {
      const e = await failure(
        fetchUsage({ exec: async () => ({ stdout }), fetch: okFetch() as unknown as typeof fetch }),
      );
      expect(e.message).toMatch(/^keychain: /);
      expect(e.message).not.toContain(TOKEN);
      expect(e.stack).not.toContain(TOKEN);
    }
  });

  it("reduces a fetch rejection to the error name", async () => {
    const f = vi.fn(async () => {
      const err = new Error(`connect failed with ${TOKEN}`);
      err.name = "TimeoutError";
      throw err;
    });
    const e = await failure(fetchUsage({ exec: keychain, fetch: f as unknown as typeof fetch }));
    expect(e.message).toBe("oauth usage request failed: TimeoutError");
    expect(e.message).not.toContain(TOKEN);
    expect(e.stack).not.toContain(TOKEN);
  });
});

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  kill = vi.fn();
  sent: Record<string, unknown>[] = [];
  constructor() {
    super();
    this.stdin.on("data", (d: Buffer) => {
      for (const l of d.toString().split("\n").filter(Boolean)) this.sent.push(JSON.parse(l));
    });
  }
  reply(m: unknown) {
    this.stdout.write(`${JSON.stringify(m)}\n`);
  }
}
const run = (child: FakeChild, extra = {}) =>
  appServer({
    spawn: (() => child) as unknown as typeof import("node:child_process").spawn,
    ...extra,
  });
const tick = () => new Promise((r) => setImmediate(r));

const win = (used: number, mins: number) => ({
  usedPercent: used,
  windowDurationMins: mins,
  resetsAt: 1792649881,
  extraId: "reset-credit-1",
});

describe("appServer", () => {
  afterEach(() => vi.useRealTimers());

  it("handshakes in order, returns whitelisted window data and kills the child", async () => {
    const c = new FakeChild();
    const p = run(c);
    await tick();
    expect(c.sent[0]?.method).toBe("initialize");
    c.reply({ id: 1, result: {} });
    await tick();
    expect(c.sent.slice(1).map((m) => m.method)).toEqual([
      "initialized",
      "account/rateLimits/read",
    ]);
    c.reply({
      id: 2,
      result: {
        accountId: "acct-secret",
        rateLimitResetCredits: { availableCount: 3, items: [{ id: "x" }] },
        rateLimits: {
          primary: win(14, 10080),
          secondary: null,
          credits: { balance: "0" },
          planType: "prolite",
        },
      },
    });
    const r = await p;
    expect(r).toEqual({
      rateLimits: {
        primary: { usedPercent: 14, windowDurationMins: 10080, resetsAt: 1792649881 },
        secondary: null,
      },
    });
    expect(JSON.stringify(r)).not.toMatch(/acct-secret|reset-credit|"id"/);
    expect(c.kill).toHaveBeenCalled();
  });

  it("fails fast on an initialize error, without waiting for the timeout", async () => {
    vi.useFakeTimers();
    const c = new FakeChild();
    const p = run(c);
    const assertion = expect(p).rejects.toThrow("initialize failed");
    await vi.advanceTimersByTimeAsync(0);
    c.reply({ id: 1, error: { code: -1, message: "nope" } });
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(c.kill).toHaveBeenCalled();
    expect(c.sent.map((m) => m.method)).toEqual(["initialize"]);
  });

  it("times out after 20 s and kills the child", async () => {
    vi.useFakeTimers();
    const c = new FakeChild();
    const p = run(c);
    const assertion = expect(p).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(19_999);
    expect(c.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(c.kill).toHaveBeenCalled();
  });

  it("rejects and kills when the child exits early", async () => {
    const c = new FakeChild();
    const p = run(c);
    const assertion = expect(p).rejects.toThrow("exited early");
    c.emit("exit", 1);
    await assertion;
    expect(c.kill).toHaveBeenCalled();
  });

  it("parses a JSON line split across stdout chunks", async () => {
    const c = new FakeChild();
    const p = run(c);
    await tick();
    const line = `${JSON.stringify({ id: 1, result: {} })}\n`;
    c.stdout.write(line.slice(0, 5));
    await tick();
    expect(c.sent).toHaveLength(1);
    c.stdout.write(line.slice(5));
    await tick();
    expect(c.sent).toHaveLength(3);
    c.reply({ id: 2, result: { rateLimits: { primary: win(1, 300), secondary: null } } });
    await expect(p).resolves.toBeDefined();
  });

  it("fails and kills the child when stdout exceeds the buffer cap", async () => {
    const c = new FakeChild();
    const p = run(c, { maxBufferBytes: 100 });
    const assertion = expect(p).rejects.toThrow("too large");
    c.stdout.write("x".repeat(200));
    await assertion;
    expect(c.kill).toHaveBeenCalled();
  });
});
