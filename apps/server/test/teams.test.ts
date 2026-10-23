import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { collectTeams, teamsStatus } from "../src/collectors/teams.ts";
import type { CcConfig, TeamsConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

const dirs: string[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mc-teams-"));
  dirs.push(dir);
  const store = new Store(join(dir, "store.sqlite"));
  const config: CcConfig & { sources: { teams: TeamsConfig } } = {
    operator: { id: "operator", timezone: "UTC" },
    accounts: [],
    loops: [],
    repos: [{ id: "work", github: "example/work", project: 1, statusMap: {}, autonomy: "draft" }],
    poll: { usageMinutes: 30, githubSeconds: 60 },
    sources: {
      teams: {
        token_command: ["fictional-token"],
        aliases: ["Operator"],
        refs: ["#42"],
        selected: [
          { kind: "chat", id: "chat-a", name: "Work chat", repoId: "work", lane: "work" },
          {
            kind: "channel",
            id: "channel-a",
            teamId: "team-a",
            name: "Work channel",
            repoId: "work",
            lane: "work",
          },
        ],
        areas: [{ repoId: "work", words: ["catalog"], keywords: ["bug", "urgent"] }],
      },
    },
  };
  return { config, store };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const message = (id: string, content: string, extra = {}) => ({
  id,
  body: { content },
  createdDateTime: "2026-10-23T10:00:00Z",
  lastModifiedDateTime: "2026-10-23T10:00:00Z",
  webUrl: "https://teams.microsoft.com/l/message/fictional",
  from: { user: { displayName: "Colleague" } },
  ...extra,
});
const response = (value: unknown[], extra = {}) =>
  new Response(JSON.stringify({ value, ...extra }));

it("collects selected chat/channel mentions, refs and area keywords, excluding nonmatches and personal lanes; only GETs", async () => {
  const { config, store } = setup();
  const read = vi.fn(async (_url, options) => {
    expect(options.method).toBe("GET");
    return response([
      message("1", "Operator please check"),
      message("2", "See #42"),
      message("3", "urgent catalog bug"),
      message("4", "urgent elsewhere"),
      message("5", "hello"),
      message("6", "hello", { mentions: [{ mentioned: { user: { displayName: "Operator" } } }] }),
    ]);
  });
  const token = vi.fn(async () => "secret");
  await collectTeams(config, store, 1_000, { fetch: read, token });
  expect(read).toHaveBeenCalledTimes(2);
  expect(store.notifications()).toHaveLength(8);
  expect(store.notifications()[0]?.message?.source.kind).toBe("teams");
  expect(store.notifications()[0]?.url).toContain("teams.microsoft.com");
  expect(store.drafts()).toEqual([]);
  config.sources.teams.selected[0].lane = "personal";
  read.mockClear();
  await collectTeams(config, store, 100_000, { fetch: read, token });
  expect(read).toHaveBeenCalledTimes(1);
  store.close();
});

it("paginates within a source, deduplicates across restart and records edits once", async () => {
  const { config, store: initial } = setup();
  let store = initial;
  config.sources.teams.selected.splice(1);
  let edited = false;
  const read = vi.fn(async (url) =>
    url.includes("skiptoken")
      ? response([message("2", "#42")])
      : response(
          [
            message(
              "1",
              edited ? "Operator edited" : "Operator",
              edited ? { lastModifiedDateTime: "2026-10-23T10:01:00Z" } : {},
            ),
          ],
          {
            "@odata.nextLink":
              "https://graph.microsoft.com/v1.0/chats/chat-a/messages?$skiptoken=next",
          },
        ),
  );
  const deps = { fetch: read, token: async () => "secret" };
  expect((await collectTeams(config, store, 1_000, deps)).changed).toBe(true);
  store.close();
  store = new Store(join(dirs[dirs.length - 1] as string, "store.sqlite"));
  expect((await collectTeams(config, store, 2_000, deps)).changed).toBe(false);
  edited = true;
  expect((await collectTeams(config, store, 3_000, deps)).changed).toBe(true);
  expect(store.notifications()).toHaveLength(2);
  expect(store.getSetting("teams.watermark:chat:chat-a")).toContain("2026-10-23T10:01");
  store.close();
});

it("refreshes on 401; consent failure stops all polling and never leaks provider errors or tokens", async () => {
  const { config, store } = setup();
  const token = vi.fn(async () => "very-secret");
  const read = vi
    .fn()
    .mockResolvedValueOnce(new Response("", { status: 401 }))
    .mockResolvedValueOnce(new Response("very-secret", { status: 403 }));
  await collectTeams(config, store, 1_000, { fetch: read, token });
  expect(token).toHaveBeenCalledTimes(2);
  await collectTeams(config, store, 100_000, { fetch: read, token });
  expect(read).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(teamsStatus(config, store))).toContain("not permitted with this login");
  expect(JSON.stringify(teamsStatus(config, store))).toContain("ChannelMessage.Read.All");
  expect(JSON.stringify(teamsStatus(config, store))).not.toContain("very-secret");
  store.close();
});

it("backs off on 429, bounds pagination, rejects foreign next links and sanitizes token failures", async () => {
  const { config, store } = setup();
  const token = async () => "secret";
  const read = vi.fn(
    async () => new Response("", { status: 429, headers: { "Retry-After": "120" } }),
  );
  await collectTeams(config, store, 1_000, { fetch: read, token });
  await collectTeams(config, store, 2_000, { fetch: read, token });
  expect(read).toHaveBeenCalledTimes(1);
  await collectTeams(config, store, 200_000, {
    fetch: read,
    token: async () => {
      throw new Error("secret");
    },
  });
  expect(JSON.stringify(teamsStatus(config, store))).not.toContain("secret");
  read.mockImplementation(async () =>
    response([], { "@odata.nextLink": "https://elsewhere.invalid/token" }),
  );
  await collectTeams(config, store, 500_000, { fetch: read, token });
  expect(read).toHaveBeenCalledTimes(2);
  store.close();
});

it("is off without a token command", async () => {
  const { config, store } = setup();
  delete config.sources.teams.token_command;
  const read = vi.fn();
  await collectTeams(config, store, 1_000, { fetch: read, token: async () => "secret" });
  expect(read).not.toHaveBeenCalled();
  expect(teamsStatus(config, store).note).toContain("sources.teams.token_command");
  store.close();
});

it("validates local argv and selection configuration", async () => {
  const { TeamsConfig } = await import("../src/config.ts");
  expect(TeamsConfig.safeParse({ token_command: "shell string" }).success).toBe(false);
  expect(
    TeamsConfig.safeParse({
      selected: [{ kind: "channel", id: "a", name: "Work", repoId: "work" }],
    }).success,
  ).toBe(false);
  expect(TeamsConfig.safeParse({ token_command: ["fictional-token"] }).success).toBe(true);
});

it("exposes off status and guards selection writes", async () => {
  const { buildApp } = await import("../src/api.ts");
  const { ChangeBus } = await import("../src/bus.ts");
  const { config, store } = setup();
  delete config.sources.teams.token_command;
  const app = buildApp({ config, store, bus: new ChangeBus() });
  const result = await app.inject({ method: "GET", url: "/api/sources/teams" });
  expect(result.statusCode).toBe(200);
  expect(result.json().enabled).toBe(false);
  const invalid = await app.inject({
    method: "POST",
    url: "/api/sources/teams/selection",
    payload: { selected: [] },
    headers: { origin: "https://foreign.invalid" },
  });
  expect(invalid.statusCode).toBe(403);
  await app.close();
  store.close();
});

it("caps each source at five pages and does not close Teams rows during a complete GitHub read", async () => {
  const { config, store } = setup();
  config.sources.teams.selected.splice(1);
  const read = vi.fn(async () =>
    response([message("1", "Operator")], {
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/chats/chat-a/messages?$skiptoken=next",
    }),
  );
  await collectTeams(config, store, 1_000, { fetch: read, token: async () => "secret" });
  expect(read).toHaveBeenCalledTimes(5);
  expect(teamsStatus(config, store).note).toContain("pagination limit");
  store.upsertNotifications([], true, 2_000, "github");
  expect(store.notifications()[0]?.unread).toBe(true);
  store.close();
});

it("runs the Teams job on the scheduler", async () => {
  const { JOBS } = await import("../src/scheduler.ts");
  expect(JOBS).toContain("teams");
});

it("executes argv without a shell, caps token output and hides command failures", async () => {
  const { teamsToken } = await import("../src/collectors/teams.ts");
  expect(
    await teamsToken([process.execPath, "-e", "process.stdout.write('fictional-token\\n')"]),
  ).toBe("fictional-token");
  await expect(
    teamsToken([process.execPath, "-e", "process.stdout.write('s'.repeat(20000))"]),
  ).rejects.toThrow("Teams token command failed");
  await expect(
    teamsToken([process.execPath, "-e", "process.stderr.write('private-detail'); process.exit(1)"]),
  ).rejects.toThrow("Teams token command failed");
});

it("atomically changes selection without changing token configuration and refuses symlinks", async () => {
  const { readFileSync, writeFileSync, symlinkSync } = await import("node:fs");
  const { setTeamsSelection } = await import("../src/config-write.ts");
  const { config, store } = setup();
  const dir = dirs[dirs.length - 1] as string;
  const path = join(dir, "config.yaml");
  const text = `# local configuration\noperator: {timezone: UTC}\naccounts: []\nrepos: []\nloops: []\npoll: {usage_minutes: 30, github_seconds: 60}\nsources:\n  teams:\n    token_command: [fictional-token]\n`;
  writeFileSync(path, text);
  const next = await setTeamsSelection(path, config.sources.teams.selected, 1_000);
  expect(next.sources?.teams?.selected).toEqual(config.sources.teams.selected);
  expect(next.sources?.teams?.token_command).toEqual(["fictional-token"]);
  expect(readFileSync(path, "utf8")).toContain("# local configuration");
  expect(readFileSync(`${path}.bak-19700101T000001Z`, "utf8")).toBe(text);
  const link = join(dir, "link.yaml");
  symlinkSync(path, link);
  await expect(setTeamsSelection(link, [], 2_000)).rejects.toThrow("symbolic link");
  store.close();
});

it("resumes bounded pagination after restart before advancing a source watermark", async () => {
  const { config, store } = setup();
  config.sources.teams.selected.splice(1);
  let page = 0;
  const read = vi.fn(async (_url: string | URL | Request) =>
    response([message(String(++page), "Operator")], {
      "@odata.nextLink": `https://graph.microsoft.com/v1.0/chats/chat-a/messages?$skiptoken=${page}`,
    }),
  );
  await collectTeams(config, store, 1_000, { fetch: read, token: async () => "secret" });
  expect(store.getSetting("teams.cursor:chat:chat-a")).toContain("skiptoken=5");
  const dir = dirs[dirs.length - 1] as string;
  store.close();
  const reopened = new Store(join(dir, "store.sqlite"));
  read.mockClear();
  await collectTeams(config, reopened, 2_000, { fetch: read, token: async () => "secret" });
  expect(String(read.mock.calls[0]?.[0])).toContain("skiptoken=5");
  expect(reopened.notifications()).toHaveLength(10);
  reopened.close();
});

it("matches replies expanded from selected channels", async () => {
  const { config, store } = setup();
  config.sources.teams.selected.splice(0, 1);
  const read = vi.fn(async (_url: string | URL | Request) =>
    response([
      message("root", "unrelated", { replies: [message("reply", "Operator please check")] }),
    ]),
  );
  await collectTeams(config, store, 1_000, { fetch: read, token: async () => "secret" });
  expect(store.notifications()).toHaveLength(1);
  expect(String(read.mock.calls[0]?.[0])).toContain("$expand=replies");
  store.close();
});

it("requires area keywords nearby and does not match partial aliases or reference numbers", async () => {
  const { config, store } = setup();
  config.sources.teams.selected.splice(1);
  await collectTeams(config, store, 1_000, {
    token: async () => "secret",
    fetch: async () =>
      response([
        message("far", `catalog ${"ordinary ".repeat(40)} urgent`),
        message("partial", "Operators see #420"),
        message("near", "catalog is urgent"),
      ]),
  });
  expect(store.notifications()).toHaveLength(1);
  store.close();
});

it("feeds existing person attention without creating drafts or publishing arrivals", async () => {
  const { attentionItems } = await import("../src/hud.ts");
  const { config, store } = setup();
  await collectTeams(config, store, 1_000, {
    token: async () => "secret",
    fetch: async () => response([message("1", "Operator please check")]),
  });
  const items = attentionItems(config, store, 1_000).filter((item) => item.kind === "person");
  expect(items).toHaveLength(2);
  expect(items.every((item) => item.url?.startsWith("https://teams.microsoft.com/"))).toBe(true);
  expect(store.drafts()).toEqual([]);
  expect(store.flightIncoming()).toEqual([]);
  store.close();
});
