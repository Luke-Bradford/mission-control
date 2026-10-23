import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttentionBrief } from "@mc/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import {
  collectNotifications,
  notificationsView,
  type Rest,
} from "../src/collectors/notifications.ts";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const UPDATED = NOW - 8 * 86400_000;
const KEY = `person:101:${UPDATED}`;
const ROOT = "https://api.github.com/repos/o/shop/issues";
const config: CcConfig = {
  operator: { id: "operator", timezone: "Europe/London" },
  accounts: [],
  loops: [],
  repos: [{ id: "shop", github: "o/shop", project: 1, statusMap: {}, autonomy: "draft" }],
  poll: { usageMinutes: 30, githubSeconds: 60 },
};
let dir: string;
let store: Store;
let updated: number;
let body: string;
const comment = (id: number, text: string) => ({
  id,
  body: text,
  user: { login: "catalogue-helper" },
  created_at: new Date(UPDATED - 1000).toISOString(),
  updated_at: new Date(UPDATED).toISOString(),
  html_url: `https://github.com/o/shop/issues/12#issuecomment-${id}`,
});
const rest: Rest = async (url) => {
  const thread = {
    id: "101",
    reason: "mention",
    updated_at: new Date(updated).toISOString(),
    last_read_at: new Date(UPDATED - 1000).toISOString(),
    repository: { full_name: "o/shop" },
    subject: {
      type: "Issue",
      title: "Review the plan",
      url: `${ROOT}/12`,
      latest_comment_url: `${ROOT}/comments/555`,
    },
  };
  return {
    status: 200,
    headers: new Headers(),
    body: url.includes("/comments?")
      ? Array.from({ length: 25 }, (_, i) => comment(530 + i, `Earlier ${i}`))
      : url === `${ROOT}/comments/555`
        ? comment(555, body)
        : url.endsWith("/threads/101")
          ? thread
          : [thread],
  };
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-person-"));
  store = new Store(join(dir, "mc.sqlite"));
  updated = UPDATED;
  body = "Please review this plan";
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
const hydrate = () => collectNotifications(config.repos, store, rest, NOW);
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing fixture value");
  return value;
}
const brief = (): AttentionBrief => ({
  context: "A follow-up",
  recommendation: "Check the plan",
  options: [],
  basis: "Read the thread",
  at: NOW,
  catchUp: {
    kind: "old",
    line: "An old thread needs a decision",
    story: ["A plan was proposed"],
    aware: ["No reply sent"],
  },
  checked: [{ source: "GitHub", finding: "The plan awaits review" }],
  person: {
    source: required(required(store.notification("101")).message).source,
    assessment: ["Review is needed"],
    related: [{ label: "shop#12", url: "https://github.com/o/shop/issues/12" }],
    decisionKey: "decision:plan",
    replies: [{ id: "review", label: "Review", text: "I will review the plan." }],
  },
});
const draft = async () => {
  await hydrate();
  store.addBrief({ key: KEY, ...brief() });
  return required(store.briefs().get(KEY)?.person?.replies?.[0]?.draftId);
};

it("hydrates bounded earlier comments and source identity, with no assessment before FLIGHT briefs it", async () => {
  await hydrate();
  const view = required(notificationsView(config, store, NOW).open[0]);
  expect(view.history).toHaveLength(20);
  expect(view.history?.[0]).toMatchObject({ author: "catalogue-helper", text: "Earlier 5" });
  expect(view.message).toMatchObject({ text: body, source: { kind: "github", messageId: "555" } });
  expect(view.catchUp).toBe("old");
  expect(view.brief).toBeUndefined();
});
it("round-trips legacy and structured briefs, binds drafts and never posts on generation or GET", async () => {
  const id = await draft();
  expect(id).toBeTypeOf("number");
  store.addBrief({
    key: "legacy",
    context: "Legacy",
    recommendation: "Wait",
    options: [],
    basis: "Read",
    at: NOW,
  });
  expect(store.briefs().get("legacy")).toEqual({
    context: "Legacy",
    recommendation: "Wait",
    options: [],
    basis: "Read",
    at: NOW,
  });
  const gh = vi.fn();
  const app = buildApp({ config, store, bus: new ChangeBus(), gh, notificationRest: rest });
  try {
    const view = (await app.inject("/api/notifications")).json().open[0];
    expect(view.brief).toMatchObject({
      catchUp: brief().catchUp,
      person: { assessment: ["Review is needed"] },
    });
    expect(gh).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
it.each(["edit", "arrival"])(
  "refuses a stale reply after source %s, including through the generic draft route",
  async (change) => {
    const id = await draft();
    if (change === "edit") body = "Edited request";
    else updated++;
    const gh = vi.fn();
    const app = buildApp({ config, store, bus: new ChangeBus(), gh, notificationRest: rest });
    try {
      for (const url of [`/api/attention/${KEY}/replies/review/post`, `/api/drafts/${id}/post`]) {
        expect((await app.inject({ method: "POST", url, payload: {} })).statusCode).toBe(409);
      }
      expect(gh).not.toHaveBeenCalled();
      expect(store.drafts()).toHaveLength(1);
    } finally {
      await app.close();
    }
  },
);
it("posts only on explicit approval, makes repeated Post idempotent and records handled-through", async () => {
  await draft();
  const gh = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
  const app = buildApp({
    config,
    store,
    bus: new ChangeBus(),
    gh,
    notificationRest: rest,
    knownSecrets: async () => [],
  });
  try {
    for (let i = 0; i < 2; i++)
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/attention/${KEY}/replies/review/post`,
            payload: {},
          })
        ).statusCode,
      ).toBe(200);
    expect(gh).toHaveBeenCalledTimes(1);
    expect(store.notification("101")).toMatchObject({
      handledHow: "replied",
      handledThrough: UPDATED,
    });
    updated++;
    await hydrate();
    expect(required(notificationsView(config, store, NOW).open[0]).key).not.toBe(KEY);
  } finally {
    await app.close();
  }
});
it("keeps a failed post pending and does not mark it handled", async () => {
  await draft();
  const gh = vi.fn(async () => ({ code: 1, stdout: "", stderr: "failure" }));
  const app = buildApp({
    config,
    store,
    bus: new ChangeBus(),
    gh,
    notificationRest: rest,
    knownSecrets: async () => [],
  });
  try {
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/attention/${KEY}/replies/review/post`,
          payload: {},
        })
      ).statusCode,
    ).toBe(502);
    expect(store.drafts()).toHaveLength(1);
    expect(store.notification("101")?.handledAt).toBeNull();
  } finally {
    await app.close();
  }
});

it("never posts Teams replies, records copying locally and supports Let FLIGHT handle it", async () => {
  await hydrate();
  const n = store.notification("101");
  if (!n?.message) throw new Error("Missing message");
  n.message.source.kind = "teams";
  store.upsertNotifications([n], false, NOW);
  store.addBrief({ key: KEY, ...brief() });
  expect(store.drafts()).toEqual([]);
  const gh = vi.fn();
  const app = buildApp({ config, store, bus: new ChangeBus(), gh });
  try {
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/attention/${KEY}/replies/review/post`,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/attention/${KEY}/handled`,
          payload: { how: "copied", replyId: "review" },
        })
      ).statusCode,
    ).toBe(200);
    expect(notificationsView(config, store, NOW).handledToday[0]?.how).toBe(
      "reply copied for Teams",
    );
    expect(gh).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
it("does not expose an assessment or copy a reply after the source is edited", async () => {
  await draft();
  const n = store.notification("101");
  if (!n?.message) throw new Error("Missing message");
  n.message.source.revision = "edited";
  store.upsertNotifications([n], false, NOW);
  expect(notificationsView(config, store, NOW).open[0]?.brief).toBeUndefined();
});
it("serializes approval across different replies and draft routes for the same item", async () => {
  await draft();
  const b = brief();
  b.person?.replies?.push({ id: "later", label: "Later", text: "I will check tomorrow." });
  store.addBrief({ key: KEY, ...b });
  let release = () => {};
  let started = () => {};
  const ready = new Promise<void>((r) => {
    started = r;
  });
  let calls = 0;
  const gh = vi.fn(async () => {
    if (++calls === 1) {
      started();
      await new Promise<void>((r) => {
        release = r;
      });
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const app = buildApp({
    config,
    store,
    bus: new ChangeBus(),
    gh,
    notificationRest: rest,
    knownSecrets: async () => [],
  });
  try {
    const first = app
      .inject({ method: "POST", url: `/api/attention/${KEY}/replies/review/post`, payload: {} })
      .then((r) => r);
    await ready;
    const other = store.briefs().get(KEY)?.person?.replies?.[1]?.draftId;
    expect(
      (await app.inject({ method: "POST", url: `/api/drafts/${other}/post`, payload: {} }))
        .statusCode,
    ).toBe(409);
    release();
    expect((await first).statusCode).toBe(200);
    expect(gh).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await app.close();
  }
});

it("keeps JSON and origin guards on explicit approval and refuses unreadable sources", async () => {
  await draft();
  const gh = vi.fn();
  const app = buildApp({
    config,
    store,
    bus: new ChangeBus(),
    gh,
    notificationRest: async () => {
      throw new Error("unavailable");
    },
  });
  try {
    const url = `/api/attention/${KEY}/replies/review/post`;
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { "content-type": "text/plain" },
          payload: "{}",
        })
      ).statusCode,
    ).toBe(415);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { origin: "https://foreign.example" },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject({ method: "POST", url, payload: {} })).statusCode).toBe(502);
    expect(gh).not.toHaveBeenCalled();
    expect(store.drafts()).toHaveLength(1);
  } finally {
    await app.close();
  }
});
it("Let FLIGHT handle it records a local handoff with the catalogue promise", async () => {
  await hydrate();
  const gh = vi.fn();
  const app = buildApp({ config, store, bus: new ChangeBus(), gh });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/attention/${KEY}/handled`,
      payload: { how: "flight" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().message).toBe(
      "I will handle catalogue-helper's message: I will check what is needed, draft a reply and bring it back to you before anything is sent.",
    );
    expect(notificationsView(config, store, NOW).handledToday[0]?.how).toBe("with FLIGHT");
    expect(gh).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
