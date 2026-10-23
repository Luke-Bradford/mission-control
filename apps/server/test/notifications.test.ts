import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectNotifications,
  makeRest,
  NOTIFICATIONS_KEEP_MS,
  NOTIFICATIONS_MODIFIED_SETTING,
  NOTIFICATIONS_URL,
  notificationsView,
  personKey,
  type Rest,
  SNIPPET_MAX,
  snippetOf,
} from "../src/collectors/notifications.ts";
import type { CcConfig } from "../src/config.ts";
import { operatorItems } from "../src/flight/state.ts";
import { attentionItems, NO_LOCK } from "../src/hud.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const UPDATED = Date.parse("2026-10-17T11:00:00Z");
const MIN = 60_000;
const COMMENT_URL = "https://api.github.com/repos/o/shop-app/issues/comments/555";
const HTML_URL = `${"https://github.com"}/o/shop-app/issues/12#issuecomment-555`;
const LAST_MODIFIED = "Sat, 17 Oct 2026 11:00:00 GMT";

let dir: string;
let store: Store;
let config: CcConfig;
const repos = () => config.repos;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-notif-"));
  store = new Store(join(dir, "mc.sqlite"));
  config = {
    operator: { id: "operator", timezone: "Europe/London" },
    accounts: [{ id: "claude-main", vendor: "claude", alertAt: 85, stopAt: 95 }],
    repos: [{ id: "shop-app", github: "o/shop-app", project: 2, statusMap: {}, autonomy: "draft" }],
    loops: [],
    poll: { usageMinutes: 30, githubSeconds: 60 },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const thread = (over: Record<string, unknown> = {}) => ({
  id: "101",
  unread: true,
  reason: "mention",
  updated_at: "2026-10-17T11:00:00Z",
  last_read_at: null,
  repository: { full_name: "o/shop-app" },
  subject: {
    type: "Issue",
    title: "Fix the stop race",
    url: "https://api.github.com/repos/o/shop-app/issues/12",
    latest_comment_url: COMMENT_URL,
  },
  ...over,
});

/** A fake REST client: the list answers with `list()`; each URL it is asked is recorded. */
function fakeRest(list: () => unknown[]): {
  rest: Rest;
  urls: string[];
  seen: Record<string, string>[];
} {
  const urls: string[] = [];
  const seen: Record<string, string>[] = [];
  const rest: Rest = async (url, headers) => {
    urls.push(url);
    seen.push(headers ?? {});
    if (url === NOTIFICATIONS_URL) {
      return {
        status: 200,
        headers: new Headers({ "last-modified": LAST_MODIFIED }),
        body: list(),
      };
    }
    if (url === COMMENT_URL) {
      return {
        status: 200,
        headers: new Headers(),
        body: { user: { login: "alice" }, body: "can you look?", html_url: HTML_URL },
      };
    }
    throw new Error(`unexpected ${url}`);
  };
  return { rest, urls, seen };
}

const persons = (at = NOW) =>
  attentionItems(config, store, at, NO_LOCK, []).filter((i) => i.kind === "person");

describe("notifications", () => {
  it("a notifications payload makes person items for configured repos only", async () => {
    const { rest, urls } = fakeRest(() => [
      thread(),
      thread({ id: "202", repository: { full_name: "other/elsewhere" } }),
      thread({ id: "303", reason: "subscribed" }),
    ]);
    await collectNotifications(repos(), store, rest, NOW);
    expect(store.notifications().map((n) => n.id)).toEqual(["101"]);
    expect(urls.filter((u) => u.includes("elsewhere"))).toEqual([]);
    expect(urls.filter((u) => u === COMMENT_URL)).toHaveLength(1);
    const items = persons();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: `person:101:${UPDATED}`,
      text: "alice mentioned you: shop-app#12 Fix the stop race",
      owner: "operator",
      url: HTML_URL,
    });
    expect(operatorItems(config, store, NOW, null).map((i) => i.key)).toContain(
      `person:101:${UPDATED}`,
    );
  });

  it("a thread read on GitHub leaves the unread list and its item clears", async () => {
    await collectNotifications(repos(), store, fakeRest(() => [thread()]).rest, NOW);
    expect(persons()).toHaveLength(1);
    await collectNotifications(repos(), store, fakeRest(() => []).rest, NOW + MIN);
    expect(persons(NOW + MIN)).toEqual([]);
    expect(store.notification("101")).toMatchObject({ unread: false, handledHow: "read" });
  });

  it("a new comment reopens a handled thread under a new key, as a follow-up", async () => {
    await collectNotifications(repos(), store, fakeRest(() => [thread()]).rest, NOW);
    expect(store.markNotificationHandled("101", UPDATED, "marked", NOW)).toBe(true);
    expect(persons()).toEqual([]);
    // handled at NOW; a comment after that reopens it
    const later = Date.parse("2026-10-17T12:30:00Z");
    const poll = later + MIN;
    await collectNotifications(
      repos(),
      store,
      fakeRest(() => [thread({ updated_at: "2026-10-17T12:30:00Z" })]).rest,
      poll,
    );
    const items = persons(poll);
    expect(items.map((i) => i.key)).toEqual([`person:101:${later}`]);
    const view = notificationsView(config, store, poll);
    expect(view.open[0]).toMatchObject({ id: "101", catchUp: "follow-up" });
  });

  it("a 304 changes nothing and sends If-Modified-Since", async () => {
    // an empty list leaves no unread row, so the conditional header is safe
    await collectNotifications(repos(), store, fakeRest(() => []).rest, NOW);
    expect(store.getSetting(NOTIFICATIONS_MODIFIED_SETTING)).toBe(LAST_MODIFIED);
    const urls: string[] = [];
    const seen: Record<string, string>[] = [];
    const rest: Rest = async (url, headers) => {
      urls.push(url);
      seen.push(headers ?? {});
      return { status: 304, headers: new Headers(), body: null };
    };
    const r = await collectNotifications(repos(), store, rest, NOW + MIN);
    expect(r).toEqual({ changed: false });
    expect(urls).toEqual([NOTIFICATIONS_URL]);
    expect(seen[0]).toMatchObject({ "If-Modified-Since": LAST_MODIFIED });
    expect(store.status().find((s) => s.collector === "github:.notifications")?.ok).toBe(true);
  });

  it("an unread row means the next poll sends no If-Modified-Since", async () => {
    const first = fakeRest(() => [thread()]);
    await collectNotifications(repos(), store, first.rest, NOW);
    expect(store.getSetting(NOTIFICATIONS_MODIFIED_SETTING)).toBe(LAST_MODIFIED);
    const second = fakeRest(() => [thread()]);
    await collectNotifications(repos(), store, second.rest, NOW + MIN);
    expect(second.seen[0]?.["If-Modified-Since"]).toBeUndefined();
  });

  it("a comment that lands before the handled click still reopens the thread", async () => {
    await collectNotifications(repos(), store, fakeRest(() => [thread()]).rest, NOW);
    // handled an hour after the 11:00 comment; a comment at 11:59:30 arrived before the click
    const click = UPDATED + 60 * MIN;
    expect(store.markNotificationHandled("101", UPDATED, "marked", click)).toBe(true);
    const skewed = UPDATED + 59.5 * MIN;
    await collectNotifications(
      repos(),
      store,
      fakeRest(() => [thread({ updated_at: new Date(skewed).toISOString() })]).rest,
      click + MIN,
    );
    expect(persons(click + MIN).map((i) => i.key)).toEqual([`person:101:${skewed}`]);
  });

  it("a failed read keeps the rows and records the error", async () => {
    await collectNotifications(repos(), store, fakeRest(() => [thread()]).rest, NOW);
    const rest: Rest = async () => {
      throw new Error("boom");
    };
    const r = await collectNotifications(repos(), store, rest, NOW + MIN);
    expect(r).toEqual({ changed: false });
    expect(store.notifications().map((n) => n.id)).toEqual(["101"]);
    expect(persons(NOW + MIN)).toHaveLength(1);
    const status = store.status().find((s) => s.collector === "github:.notifications");
    expect(status?.ok).toBe(false);
    expect(status?.error).toBe(`boom at ${new Date(NOW + MIN).toISOString()}`);
  });

  it("closed rows are pruned after NOTIFICATIONS_KEEP_MS", async () => {
    await collectNotifications(repos(), store, fakeRest(() => [thread()]).rest, NOW);
    await collectNotifications(repos(), store, fakeRest(() => []).rest, NOW + MIN);
    await collectNotifications(
      repos(),
      store,
      fakeRest(() => []).rest,
      NOW + MIN + NOTIFICATIONS_KEEP_MS + 1,
    );
    expect(store.notifications()).toEqual([]);
  });

  it("makeRest refuses a URL outside api.github.com without fetching", async () => {
    const doFetch = vi.fn(async () => new Response("{}"));
    const rest = makeRest("tok", doFetch as unknown as typeof fetch);
    await expect(rest("https://evil.example/notifications")).rejects.toThrow(
      "github: refused a URL outside api.github.com",
    );
    await expect(rest("https://api.github.com.evil.example/x")).rejects.toThrow("outside");
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("makeRest sends bearer auth and keeps the token out of errors", async () => {
    const doFetch = vi.fn(
      async () =>
        new Response("{}", {
          status: 403,
          headers: { "x-github-sso": "required; url=https://sso" },
        }),
    );
    const rest = makeRest("secret-token", doFetch as unknown as typeof fetch);
    const err = (await rest(NOTIFICATIONS_URL).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("github: HTTP 403");
    expect(JSON.stringify(err)).not.toContain("secret-token");
    const init = (doFetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("bearer secret-token");
  });

  it("snippetOf collapses whitespace and cuts at SNIPPET_MAX", () => {
    expect(snippetOf("  a \n\n b\t c  ")).toBe("a b c");
    expect(snippetOf("   ")).toBeNull();
    expect(snippetOf(42)).toBeNull();
    const cut = snippetOf("x".repeat(SNIPPET_MAX + 50)) ?? "";
    expect([...cut]).toHaveLength(SNIPPET_MAX);
    expect(cut.endsWith("…")).toBe(true);
    expect(snippetOf("x".repeat(SNIPPET_MAX))).toBe("x".repeat(SNIPPET_MAX));
  });

  it("personKey is parsed back by parsePersonKey", async () => {
    const { parsePersonKey } = await import("../src/collectors/notifications.ts");
    expect(parsePersonKey(personKey({ id: "101", updatedAt: UPDATED }))).toEqual({
      id: "101",
      updatedAt: UPDATED,
    });
    expect(parsePersonKey("person:x:1")).toBeNull();
    expect(parsePersonKey("note:1")).toBeNull();
  });
});
