import "./temp-home.ts";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ACTIVITY_LIMIT,
  type ActivityEvent,
  type AgentStream,
  type AttentionItem,
  type AwayDigest,
  type AwaySettings,
  type BoardItem,
  type ChangedFiles,
  COMMS_MESSAGE_BODY_LIMIT,
  COMMS_MESSAGE_MAX,
  type ConfigView,
  type Crew,
  type CrewChanges,
  type CrewSessionFolders,
  DEFAULT_AWAY,
  DEFAULT_PROFILES,
  DEFAULT_SEAT_COMMANDS,
  type Escalation,
  type FileDiff,
  FLIGHT_HEADLINE,
  FLIGHT_LIST_MAX,
  type FlightBriefView,
  type FlightLedgerEntry,
  type FlightSummaryView,
  type FlightView,
  fullAt5h,
  type MachineSample,
  NEW_LOOP,
  OPERATOR_BOOTSTRAP_PATH,
  OPERATOR_HEADER,
  OPERATOR_TOKEN_REQUIRED,
  otherLaneText,
  type PrCheck,
  type PullRequestView,
  projectAtReset,
  READONLY_FILES_NOTE,
  type ReloadResult,
  type Run,
  type RunDigest,
  type RunView,
  stopForecast,
  type Telemetry,
  TOPICS,
  TYPE_LABELS,
  type UsageSample,
  type VersionInfo,
} from "@mc/core";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, CHECK_FAILED, CONFIG_WRITES_UNAVAILABLE, NO_OPEN_NOTE } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import { collectGithub, type Gql, GqlError } from "../src/collectors/github.ts";
import {
  NO_OPEN_THREAD,
  type NotificationsView,
  personKey,
} from "../src/collectors/notifications.ts";
import { USAGE_BACKOFF_SETTING } from "../src/collectors/usage-claude.ts";
import { type CcConfig, loadConfig, seatInput } from "../src/config.ts";
import { noSessionText, SEATS_CHANGED } from "../src/config-write.ts";
import type { CrewReloader } from "../src/crew-apply.ts";
import * as files from "../src/files.ts";
import { GitFailed, NO_WORKTREE_NOTE } from "../src/files.ts";
import { TestLock } from "../src/guard/lock.ts";
import { CallRing } from "../src/map/ring.ts";
import { BOOTSTRAP_REFUSED } from "../src/operator.ts";
import { CheckoutError } from "../src/runtime/checkouts.ts";
import { recordNoReport } from "../src/runtime/no-report.ts";
import { type Supervisor, SupervisorError } from "../src/runtime/supervisor.ts";
import { type NotificationRead, Store } from "../src/store.ts";
import { readStream } from "../src/stream.ts";
import { UpdateError, type Updater } from "../src/update.ts";
import * as views from "../src/views.ts";
import { mapCheckout } from "./map-checkout.ts";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const HOUR = 3600e3;
const DAY = 24 * HOUR;

let dir: string;
let stateDir: string;
let store: Store;
let config: CcConfig;
let bus: ChangeBus;
let clock: number;
let logs: string[];
let app: FastifyInstance;
let apiRoutes: string[];
/** Fake GitHub for the setup routes: the project's fields, and every gql call made. */
let projectFields: { name: string; options?: { name: string }[] }[];
/** The labels the fake repository has (the setup action's createLabel adds to them). */
let repoLabels: string[];
let labelFail: string | null;
let labelReadFail: boolean;
let gqlCalls: { query: string; vars: Record<string, unknown> }[];
let gqlFail: boolean;
/** The repo labels the fake GitHub answers the add-repo preview with. */
let previewLabels: string[];
/** The fake GitHub has no such owner: `repositoryOwner(login:)` is NOT_FOUND. */
let gqlNoOwner: boolean;
let gqlFailField: string | null;
let refreshed: number;
/** The stub supervisor's status, the calls it received, and the error its next call throws. */
let supervisorStatus: { enabled: boolean; note: string | null };
let supervisorCalls: unknown[][];
let supervisorFail: unknown;
/** The stub updater's version, what its next update() does, and its calls. */
let updaterVersion: VersionInfo;
let updaterResult: () => Promise<{ upToDate: true } | { restarting: true }>;
let updaterCalls: string[];
let updaterCheckError: Error | null = null;
const stubUpdater = (): Updater => ({
  changes: async () => null,
  version: async () => {
    updaterCalls.push("version");
    return updaterVersion;
  },
  update: () => {
    updaterCalls.push("update");
    return updaterResult();
  },
  check: async () => {
    updaterCalls.push("check");
    if (updaterCheckError) throw updaterCheckError;
    return updaterVersion;
  },
  restart: () => void updaterCalls.push("restart"),
});
/** One crew seat, added to `config` by the tests that need it (the shared fixture has none). */
const withCrew = () => {
  config.crew = {
    worktrees: join(dir, "crew"),
    maxSeats: 4,
    sessions: [
      {
        id: "s1",
        repoId: "shop-app",
        checkout: join(dir, "clone"),
        seats: [
          { id: "guido-1", role: "GUIDO", accountId: "claude-main", model: "sonnet", area: [] },
        ],
      },
    ],
  };
};
const NO_CHANGES: CrewChanges = {
  sessions: [],
  pending: [],
  restartNeeded: [],
  error: null,
  checkedAt: null,
};
const stubReloader = (result: Partial<ReloadResult> = {}): CrewReloader => ({
  start: () => {},
  stop: () => {},
  reload: async () => ({ ...NO_CHANGES, applied: [], ...result }),
  settle: () => [],
  status: () => NO_CHANGES,
});
const stubSupervisor = (): Supervisor => {
  const call =
    <T>(name: string, value: T) =>
    async (...args: unknown[]): Promise<T> => {
      supervisorCalls.push([name, ...args]);
      if (supervisorFail !== null) throw supervisorFail;
      return value;
    };
  return {
    withAccountUpdate: (fn) => fn(),
    start: () => undefined,
    stopAll: async () => undefined,
    transferAccount: call("transfer", { outcome: "resumed" as const }),
    startRun: call("start", { runId: "r-1", branch: "feature/5-x" }),
    startWatch: call("startWatch", { runId: "r-3" }),
    startReview: call("startReview", { runId: "r-2" }),
    message: call("message", undefined),
    interrupt: call("interrupt", undefined),
    endRun: call("end", undefined),
    endRunByEngine: call("endByEngine", undefined),
    setAside: call("setAside", null),
    wakeRun: call("wakeRun", undefined),
    endAsideRun: call("endAside", undefined),
    send: call("send", "sent" as const),
    resumeRun: call("resumeRun", undefined),
    on: () => () => {},
    emitEvidence: () => {},
    emitFindings: () => {},
    seatFacts: () => null,
    contextUsage: call("context", { categories: [], total: 10, window: 100 }),
    seat: () => null,
    busy: () => [],
    seatBusy: () => false,
    status: () => supervisorStatus,
    inClone: (_checkout, fn) => fn(),
  };
};
let streamReads: ReturnType<typeof vi.fn<typeof readStream>>;
/** The app's config.yaml: a copy of the example (the in-memory `config` is the fixture's own). */
let configPath: string;
const EXAMPLE_CONFIG = resolve(import.meta.dirname, "../../../config.example.yaml");
/** The example, with `crew.node` pointed at a node that exists on this machine. */
const exampleText = () =>
  readFileSync(EXAMPLE_CONFIG, "utf8").replace(
    "\ncrew:\n",
    `\ncrew:\n  node: ${process.execPath}\n`,
  );

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mc-api-"));
  stateDir = join(dir, "ta-state");
  mkdirSync(stateDir);
  mkdirSync(join(dir, "studio-logs"));
  store = new Store(join(dir, "mc.sqlite"));
  configPath = join(dir, "config.yaml");
  writeFileSync(configPath, exampleText(), { mode: 0o600 });
  config = {
    operator: { id: "operator", timezone: "Europe/London" },
    accounts: [
      { id: "claude-main", vendor: "claude", alertAt: 85, stopAt: 95 },
      { id: "codex-main", vendor: "codex", alertAt: 70, stopAt: 80 },
    ],
    repos: [
      {
        id: "shop-app",
        github: "o/shop-app",
        project: 2,
        statusMap: { Todo: "planned" },
        autonomy: "draft",
      },
      {
        id: "site-builder",
        github: "o/ae",
        project: 3,
        statusMap: { Done: "done" },
        autonomy: "draft",
      },
    ],
    loops: [
      {
        id: "shop-app-ta",
        repoId: "shop-app",
        kind: "ta-loop",
        accountId: "claude-main",
        stateDir,
        worktree: join(dir, "wt-ta"),
        launchdLabel: "com.shop-app.ta-loop",
      },
      {
        id: "studio-builder",
        repoId: "site-builder",
        kind: "studio-loop",
        accountId: "claude-main",
        stateDir: join(dir, "studio"),
        logsDir: join(dir, "studio-logs"),
        worktree: join(dir, "wt-studio"),
        launchdLabel: "com.site-builder.studio-build-driver",
      },
    ],
    poll: { usageMinutes: 30, githubSeconds: 60 },
  };
  bus = new ChangeBus();
  supervisorStatus = { enabled: true, note: null };
  supervisorCalls = [];
  supervisorFail = null;
  updaterVersion = {
    sha: "a".repeat(40),
    behind: 0,
    checkedAt: NOW,
    canUpdate: true,
    reason: null,
  };
  updaterResult = async () => ({ upToDate: true });
  updaterCalls = [];
  updaterCheckError = null;
  clock = NOW;
  logs = [];
  projectFields = [{ name: "Status", options: [{ name: "Todo" }] }];
  repoLabels = [];
  labelFail = null;
  labelReadFail = false;
  gqlCalls = [];
  gqlFail = false;
  previewLabels = [];
  gqlNoOwner = false;
  gqlFailField = null;
  refreshed = 0;
  streamReads = vi.fn(readStream);
  issueNode = (n) => ({ number: n, title: "t", url: "", state: "OPEN", body: "" });
  const fakeGql: Gql = async (query, vars) => {
    gqlCalls.push({ query, vars });
    if (gqlFail) throw new Error("github: HTTP 502");
    if (query.includes("issue(number")) return { repository: { issue: issueNode(vars.number) } };
    if (query.includes("createLabel")) {
      const input = vars.input as { name: string };
      if (input.name === labelFail) throw new Error("github: HTTP 500");
      repoLabels.push(input.name);
      return {};
    }
    if (query.includes("existing: labels")) {
      if (labelReadFail) throw new Error("github: HTTP 503");
      return {
        repository: {
          id: "R_1",
          existing: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: repoLabels.map((name) => ({ name })),
          },
        },
      };
    }
    if (query.includes("viewer")) return { viewer: { login: "octo-op" } };
    if (query.includes("mutation")) {
      const input = vars.input as { name: string; singleSelectOptions: { name: string }[] };
      if (input.name === gqlFailField) throw new Error("github: HTTP 500");
      projectFields.push({ name: input.name, options: input.singleSelectOptions });
      return {};
    }
    if (query.includes("labels(first")) {
      if (gqlNoOwner) {
        throw new GqlError(
          "github: Could not resolve to a User",
          [{ type: "NOT_FOUND", path: ["repositoryOwner"] }],
          { repositoryOwner: null },
        );
      }
      return {
        repositoryOwner: {
          __typename: "User",
          projectV2: {
            title: "Studio",
            items: { totalCount: 5 },
            fields: { pageInfo: { hasNextPage: false }, nodes: projectFields },
          },
        },
        repository: { labels: { nodes: previewLabels.map((name) => ({ name })) } },
      };
    }
    return {
      repositoryOwner: {
        __typename: "User",
        projectV2: {
          id: "PVT_1",
          fields: { pageInfo: { hasNextPage: false }, nodes: projectFields },
        },
      },
    };
  };
  app = buildApp({
    githubGql: async () => fakeGql,
    refreshBoards: () => void refreshed++,
    config,
    store,
    bus,
    now: () => clock,
    logger: { stream: { write: (s: string) => void logs.push(s) } },
    heartbeatMs: 50,
    readStream: (path, limit, vendor) => streamReads(path, limit, vendor),
    configPath,
    crewReloader: stubReloader(),
    supervisor: stubSupervisor(),
    updater: stubUpdater(),
  });
  // The /api plugin registers its routes at ready(), so this sees every one of them.
  apiRoutes = [];
  app.addHook("onRoute", (r) => {
    for (const m of [r.method].flat()) apiRoutes.push(`${m} ${r.url}`);
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

let issueNode: (n: unknown) => unknown;

const json = { "content-type": "application/json" };

const get = (url: string) => app.inject({ method: "GET", url });
const post = (url: string, headers: Record<string, string> = json, body: object = {}) =>
  app.inject({
    method: "POST",
    url,
    headers,
    ...(headers["content-type"] === "application/json" ? { payload: body } : {}),
  });
const postBody = (url: string, body: unknown) =>
  app.inject({ method: "POST", url, headers: json, payload: JSON.stringify(body) });

describe("Comms API", () => {
  const commsConfig = (): CcConfig => ({
    ...config,
    crew: {
      worktrees: join(dir, "worktrees"),
      maxSeats: 4,
      sessions: [
        {
          id: "crew",
          repoId: "shop-app",
          checkout: join(dir, "checkout"),
          seats: [
            {
              id: "flight",
              role: "FLIGHT",
              accountId: "claude-main",
              model: "haiku",
              area: [],
            },
            {
              id: "alpha",
              role: "GUIDO",
              accountId: "claude-main",
              model: "haiku",
              area: ["apps/**"],
            },
            {
              id: "beta",
              role: "GUIDO",
              accountId: "claude-main",
              model: "haiku",
              area: ["web/**"],
            },
          ],
        },
      ],
    },
  });

  const withCommsApp = async (
    fn: (comms: FastifyInstance, delivered: ReturnType<typeof vi.fn>) => Promise<void>,
  ) => {
    const delivered = vi.fn();
    const comms = buildApp({
      config: commsConfig(),
      store,
      bus,
      now: () => clock,
      knownSecrets: async () => [],
      deliverComms: delivered,
    });
    await comms.ready();
    try {
      await fn(comms, delivered);
    } finally {
      await comms.close();
    }
  };

  const commsRow = (from: string, to: string, text: string, at = clock) => {
    const row = store.addComms({
      at,
      from,
      to,
      ticket: null,
      text,
      mentions: text.includes("@CAPCOM") ? ["CAPCOM"] : [],
    });
    if (row === null) throw new Error("Comms row was not stored");
    clock++;
    return row;
  };

  it("returns cursor-derived unread counts for every page scope and keeps scopes isolated", async () => {
    const crew = commsRow("alpha", "crew", "crew");
    const flight = commsRow("CAPCOM", "flight", "flight");
    const inbox = commsRow("beta", "alpha", "inbox");
    const all = commsRow("alpha", "CAPCOM", "all");
    await withCommsApp(async (comms) => {
      const getComms = async (url: string) => (await comms.inject({ method: "GET", url })).json();
      const read = (scope: string, messageId: string) =>
        comms.inject({
          method: "POST",
          url: "/api/comms/read",
          headers: json,
          payload: { scope, messageId },
        });
      for (const [url, scope, id, key] of [
        ["/api/comms/crew", "crew", crew.id, "unread"],
        ["/api/comms/flight", "flight", flight.id, "unread"],
        ["/api/comms/agents/alpha", "agent-all:alpha", all.id, "unread"],
        ["/api/comms/agents/alpha", "inbox:alpha", inbox.id, "inboxUnread"],
      ] as const) {
        expect((await getComms(url))[key]).toBeGreaterThan(0);
        expect((await read(scope, id)).statusCode).toBe(200);
        expect((await getComms(url))[key]).toBe(0);
      }
      const agent = await getComms("/api/comms/agents/alpha");
      expect(agent).toMatchObject({
        cursor: all.id,
        inboxCursor: inbox.id,
        unread: 0,
        inboxUnread: 0,
      });
      expect((await getComms("/api/comms/crew")).cursor).toBe(crew.id);
      expect((await getComms("/api/comms/flight")).cursor).toBe(flight.id);
    });
  });

  it("sends, reacts to, and pins CAPCOM messages with validation and exactly-once direct delivery", async () => {
    await withCommsApp(async (comms, delivered) => {
      const postComms = (url: string, payload: object) =>
        comms.inject({ method: "POST", url, headers: json, payload });
      const sent = await postComms("/api/comms", {
        to: "alpha",
        text: "operator @beta",
        label: "question",
        ref: "#703",
      });
      expect(sent.statusCode).toBe(200);
      const message = sent.json().message;
      expect(message).toMatchObject({
        from: "CAPCOM",
        operator: true,
        label: "question",
        ref: "#703",
      });
      expect(delivered).toHaveBeenCalledTimes(2);
      expect(delivered).toHaveBeenCalledWith("alpha", "operator @beta", "CAPCOM");
      expect(delivered).toHaveBeenCalledWith("beta", "operator @beta", "CAPCOM");
      expect(
        (
          await postComms(`/api/comms/${message.id}/reactions`, {
            reaction: "cant",
            reason: "blocked",
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await comms.inject({
            method: "PUT",
            url: `/api/comms/${message.id}/pin`,
            headers: json,
            payload: {},
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await comms.inject({
            method: "DELETE",
            url: `/api/comms/${message.id}/pin`,
            headers: json,
            payload: {},
          })
        ).statusCode,
      ).toBe(200);
      for (const payload of [
        { to: "nobody", text: "x" },
        { to: "alpha", text: "x", label: "wrong" },
        { to: "alpha", text: "x", ref: "703" },
        { to: "alpha", text: "x", extra: true },
      ])
        expect((await postComms("/api/comms", payload)).statusCode).toBe(400);
      for (const payload of [
        { reaction: "nope" },
        { reaction: "cant" },
        { reaction: "seen", reason: "why" },
      ])
        expect((await postComms(`/api/comms/${message.id}/reactions`, payload)).statusCode).toBe(
          400,
        );
    });
  });

  it("serves boundary-safe linked tickets, ordered mentions, pins and link counts", async () => {
    const mention = commsRow("alpha", "crew", "@CAPCOM ticket #703");
    commsRow("beta", "crew", "not #7030");
    const pinned = commsRow("beta", "alpha", "pin");
    store.setCommsPinned(pinned.id, true, "CAPCOM", clock++);
    await withCommsApp(async (comms) => {
      const ticket = await comms.inject({ method: "GET", url: "/api/comms/tickets/%23703" });
      expect(ticket.json()).toMatchObject({ ticket: { ref: "#703", linkedPr: null } });
      expect(ticket.json().messages.map((m: { id: string }) => m.id)).toEqual([mention.id]);
      store.upsertPullRequests(
        "shop-app",
        [
          {
            repoId: "shop-app",
            number: 711,
            title: "linked",
            url: "",
            branch: "fix/703",
            ticket: "shop-app#703",
            state: "open",
            isDraft: false,
            review: null,
            ci: null,
            createdAt: clock,
            updatedAt: clock,
            mergedAt: null,
            headSha: null,
            mergeable: null,
          },
        ],
        clock,
      );
      const linked = store.addComms({
        at: clock++,
        from: "beta",
        to: "crew",
        ticket: null,
        text: "ignored",
        ref: "PR 711",
      });
      const linkedTicket = (
        await comms.inject({ method: "GET", url: "/api/comms/tickets/%23703" })
      ).json();
      expect(linkedTicket).toMatchObject({
        ticket: { ref: "#703", linkedPr: "PR 711" },
      });
      expect(linkedTicket.messages.map((m: { id: string }) => m.id)).toContain(linked?.id);
      expect(
        (await comms.inject({ method: "GET", url: "/api/comms/mentions" })).json().mentions[0],
      ).toMatchObject({
        message: { id: mention.id },
        seen: false,
      });
      expect(
        (
          await comms.inject({
            method: "POST",
            url: "/api/comms/mentions/seen",
            headers: json,
            payload: { ids: [mention.id] },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await comms.inject({ method: "GET", url: "/api/comms/mentions" })).json().mentions[0].seen,
      ).toBe(true);
      expect(
        (await comms.inject({ method: "GET", url: "/api/comms/pins" })).json().messages[0].id,
      ).toBe(pinned.id);
      expect((await comms.inject({ method: "GET", url: "/api/comms/links" })).json().links).toEqual(
        expect.arrayContaining([expect.objectContaining({ from: "alpha", to: "crew", count: 1 })]),
      );
    });
  });
});

const run = (over: Partial<Run>): Run => ({
  id: "r",
  agentId: "shop-app-ta",
  repoId: "shop-app",
  seq: 1,
  startedAt: NOW - HOUR,
  endedAt: null,
  status: "running",
  sessionId: null,
  model: null,
  branch: null,
  ticket: null,
  costUsd: null,
  tokens: null,
  transcriptPath: "",
  prs: [],
  summary: null,
  ...over,
});

const escalation = (over: Partial<Escalation>): Escalation => ({
  id: "shop-app#9",
  repoId: "shop-app",
  issueNumber: 9,
  title: "[operator-decision] pick one",
  kind: "operator-decision",
  source: "title",
  openedAt: NOW - DAY,
  url: "https://github.com/o/shop-app/issues/9",
  question: null,
  ...over,
});

/** A valid `POST /api/repos` body: a repo in neither the fixture nor the example config. */
const NEW_REPO = {
  id: "studio",
  github: "octo-org/studio",
  project: 4,
  statusMap: { Todo: "planned", Done: "done" },
};

/** `[method, url, body?]`: a POST is sent with its valid body (default `{}`). */
const API_ROUTES: [string, string, object?][] = [
  ["GET", "/api/agents/shop-app-ta/runs"],
  ["GET", "/api/agents/guido-1/runs"],
  ["GET", "/api/agents/shop-app-ta/stream"],
  ["GET", "/api/comms/guido-1"],
  ["POST", "/api/comms/guido-1/read", { messageIds: [] }],
  ["GET", "/api/comms/crew"],
  ["GET", "/api/comms/flight"],
  ["GET", "/api/comms/agents/guido-1"],
  ["GET", "/api/comms/agents/guido-1/contacts/CAPCOM"],
  ["GET", "/api/comms/pairs/guido-1/CAPCOM"],
  ["GET", "/api/comms/tickets/%237"],
  ["GET", "/api/comms/mentions"],
  ["POST", "/api/comms/mentions/seen", { ids: [] }],
  ["GET", "/api/comms/pins"],
  ["GET", "/api/comms/links"],
  ["POST", "/api/comms/read", { scope: "crew", messageId: "comms:1" }],
  ["POST", "/api/comms", { to: "guido-1", text: "hello" }],
  ["POST", "/api/comms/comms:1/reactions", { reaction: "seen" }],
  ["PUT", "/api/comms/comms:1/pin", {}],
  ["DELETE", "/api/comms/comms:1/pin", {}],
  ["GET", "/api/agents/shop-app-ta/files"],
  ["GET", "/api/agents/shop-app-ta/files/diff?path=a.ts"],
  ["GET", "/api/agents/guido-1/stream"],
  ["GET", "/api/agents/guido-1/files"],
  ["GET", "/api/limits"],
  ["GET", "/api/limits/github"],
  ["GET", "/api/repos"],
  ["POST", "/api/repos", NEW_REPO],
  ["GET", "/api/repos/profiles"],
  ["POST", "/api/repos/preview", { github: "octo-org/studio", project: 4 }],
  ["GET", "/api/boards/shop-app"],
  ["GET", "/api/boards/shop-app/setup"],
  ["GET", "/api/boards/shop-app/items/7"],
  ["POST", "/api/boards/shop-app/setup"],
  ["GET", "/api/repos/shop-app/prs"],
  ["GET", "/api/repos/shop-app/map/conflicts"],
  ["GET", "/api/repos/shop-app/map"],
  ["GET", "/api/repos/shop-app/map/diff"],
  ["GET", "/api/repos/shop-app/prs?linked=1"],
  ["GET", "/api/escalations"],
  ["GET", "/api/drafts"],
  ["GET", "/api/drafts/history"],
  ["POST", "/api/drafts/guido-1/post"],
  ["POST", "/api/drafts/guido-1/discard"],
  ["POST", "/api/drafts/guido-1/copied"],
  ["POST", "/api/attention/person:101:1/replies/review/post"],
  ["GET", "/api/flight"],
  ["GET", "/api/flight/brief"],
  ["GET", "/api/flight/incoming"],
  ["GET", "/api/flight/schedule"],
  ["GET", "/api/flight/summary"],
  ["GET", "/api/flight/ledger"],
  ["GET", "/api/flight/memory?repo=shop-app"],
  ["PUT", "/api/flight/memory/:repo/:topic", { kind: "lesson", body: "note", source: "test" }],
  ["DELETE", "/api/flight/memory/:repo/:topic"],
  ["GET", "/api/health"],
  ["GET", "/api/machine"],
  ["GET", "/api/activity"],
  ["GET", "/api/config"],
  ["POST", "/api/profiles"],
  ["GET", "/api/accounts/status"],
  ["GET", "/api/sources/teams"],
  ["POST", "/api/sources/teams/selection", { selected: [] }],
  ["POST", "/api/accounts/claude-main/check"],
  ["POST", "/api/accounts", { name: "another", provider: "claude" }],
  ["POST", "/api/config/reload"],
  ["POST", "/api/github/refresh"],
  ["POST", "/api/crew/sessions/:sessionId/seats"],
  ["POST", "/api/crew/sessions"],
  ["POST", "/api/crew/sessions/:id/close"],
  ["GET", "/api/crew/changes"],
  ["GET", "/api/telemetry?range=6h"],
  ["GET", "/api/stream"],
  ["POST", "/api/agents/shop-app-ta/pause"],
  ["POST", "/api/agents/shop-app-ta/resume"],
  ["GET", "/api/crew"],
  ["GET", "/api/overview/timeline"],
  ["GET", "/api/overview"],
  ["GET", "/api/crew/status"],
  ["GET", "/api/crew/sessions"],
  ["GET", "/api/runs/guido-1/loop"],
  ["GET", "/api/runs/guido-1/attempts"],
  ["GET", "/api/version"],
  ["POST", "/api/version/check"],
  ["POST", "/api/update"],
  ["GET", "/api/seats/guido-1/focus"],
  ["POST", "/api/seats/guido-1/focus", { focus: "lane:work" }],
  ["POST", "/api/seats/guido-1/queue/reorder", { move: "shop-app#2", above: "shop-app#1" }],
  ["POST", "/api/queue/reorder/:key", { action: "deny" }],
  ["POST", "/api/seats/guido-1/start", { issue: 5 }],
  ["POST", "/api/seats/guido-1/message", { text: "hello", interrupt: true }],
  ["POST", "/api/seats/guido-1/interrupt"],
  ["POST", "/api/seats/guido-1/transfer", { accountId: "destination" }],
  ["POST", "/api/seats/guido-1/end"],
  ["POST", "/api/runs/shop-app-ta/end", {}],
  ["POST", "/api/runs/shop-app-ta/resume", {}],
  ["GET", "/api/seats/guido-1/context"],
  ["GET", "/api/attention"],
  ["GET", "/api/attention/held"],
  ["POST", "/api/attention/example/hold", { reason: "Waiting", condition: { kind: "manual" } }],
  ["POST", "/api/attention/example/hold/release", {}],
  ["GET", "/api/attention/unknown"],
  ["GET", "/api/attention/example/discussion"],
  ["POST", "/api/attention/example/discussion", { version: "old", messageId: "ask", text: "Why?" }],
  ["POST", "/api/attention/ack", { keys: ["esc:shop-app#9"] }],
  ["POST", "/api/attention/note:blocked:r1:0/dismiss", {}],
  ["GET", "/api/notifications"],
  ["POST", "/api/attention/person:101:1/handled", {}],
  ["GET", "/api/notification-preferences"],
  [
    "POST",
    "/api/notification-preferences",
    {
      categories: {
        people: true,
        decisions: true,
        stalls: true,
        prs: true,
        capcom: true,
        awayDigest: true,
        quota: false,
        agentMessages: false,
      },
      quietHours: { start: "19:00", end: "08:00", timezone: "UTC", stallsBypass: true },
      softChime: true,
    },
  ],
  ["GET", "/api/notifications/events"],
  ["POST", "/api/notifications/test", {}],
  ["GET", "/api/settings/crew-pause"],
  ["POST", "/api/settings/crew-pause", { seats: null }],
  ["GET", "/api/settings/away"],
  ["GET", "/api/away/digest"],
  ["POST", "/api/settings/away", DEFAULT_AWAY],
  [
    "POST",
    "/api/guard/check",
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: {} },
  ],
  ["GET", "/api/test-lock"],
  ["GET", "/api/test-lock/history"],
  ["GET", "/api/guard/hits?days=7"],
];

describe("repo profiles and the add-repo preview", () => {
  const body = { github: "octo-org/studio", project: 4 };

  it("GET /api/repos/profiles describes each configured repo, from stored rows", async () => {
    const r = await get("/api/repos/profiles");
    expect(r.statusCode).toBe(200);
    const rows = r.json<{ id: string; loops: string[]; statuses: unknown[] }[]>();
    expect(rows.map((x) => x.id)).toEqual(["shop-app", "site-builder"]);
    expect(rows[0]?.loops).toEqual(["shop-app-ta"]);
    expect(rows[0]?.statuses).toEqual([
      { status: "Todo", state: "planned", column: "Ready", items: 0 },
    ]);
    expect(gqlCalls).toEqual([]);
  });

  it("POST /api/repos/preview reads GitHub once and writes nothing", async () => {
    previewLabels = ["p2"];
    const r = await postBody("/api/repos/preview", body);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      github: "octo-org/studio",
      project: 4,
      projectTitle: "Studio",
      items: 5,
      statusOptions: ["Todo"],
      priority: "labels",
      loops: [],
    });
    expect(gqlCalls).toHaveLength(1);
    expect(gqlCalls.some((c) => c.query.includes("mutation"))).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(exampleText());
    expect(config.repos).toHaveLength(2);
  });

  it("validates the body like the add route", async () => {
    for (const bad of [
      {},
      { ...body, project: 0 },
      { ...body, github: "no-slash" },
      { ...body, x: 1 },
    ]) {
      expect((await postBody("/api/repos/preview", bad)).statusCode).toBe(400);
    }
    expect(gqlCalls).toEqual([]);
  });

  it("answers 404 for an unknown owner and 502 when GitHub fails", async () => {
    gqlNoOwner = true;
    const org = await postBody("/api/repos/preview", body);
    expect(org.statusCode).toBe(404);
    expect(org.json()).toEqual({ error: "owner octo-org not found" });
    gqlFail = true;
    const r = await postBody("/api/repos/preview", body);
    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({ error: "github: HTTP 502" });
  });

  it("requires JSON and a same-origin request", async () => {
    expect((await post("/api/repos/preview", {}, body)).statusCode).toBe(415);
    const r = await post("/api/repos/preview", { ...json, origin: "https://evil.example" }, body);
    expect(r.statusCode).toBe(403);
    expect(gqlCalls).toEqual([]);
  });
});

describe("add a repo (POST /api/repos)", () => {
  const BACKUP = "config.yaml.bak-20261017T120000Z";
  const unchanged = () => {
    expect(readFileSync(configPath, "utf8")).toBe(exampleText());
    expect(readdirSync(dir).some((f) => f.startsWith("config.yaml.bak-"))).toBe(false);
    expect(config.repos).toHaveLength(2);
  };

  it("writes config.yaml, applies the repo live and emits config", async () => {
    const events: string[] = [];
    bus.subscribe((t) => events.push(t));
    const r = await postBody("/api/repos", { ...NEW_REPO, needsYouLabels: ["needs-human"] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      repo: { id: "studio", github: "octo-org/studio", project: 4, projectUrl: null },
      backup: BACKUP,
    });
    expect(readdirSync(dir)).toContain(BACKUP);
    expect(readFileSync(configPath, "utf8")).toContain("  - id: studio\n");
    expect((await get("/api/repos")).json()).toEqual([
      { id: "shop-app", github: "o/shop-app", project: 2, projectUrl: null },
      { id: "site-builder", github: "o/ae", project: 3, projectUrl: null },
      { id: "studio", github: "octo-org/studio", project: 4, projectUrl: null },
    ]);
    expect(config.repos.at(-1)).toEqual({
      id: "studio",
      github: "octo-org/studio",
      project: 4,
      statusMap: { Todo: "planned", Done: "done" },
      needsYouLabels: ["needs-human"],
      fullSuite: [],
      requiredChecks: [],
      commands: DEFAULT_SEAT_COMMANDS,
      protectedFiles: [],
      autonomy: "draft",
      flightPowers: "standard",
    });
    expect(events).toContain("config");
    expect(events).toContain("boards");
    expect(refreshed).toBe(1);
    expect((await get("/api/boards/studio")).statusCode).toBe(200);
  });

  it.each([
    ["a github name with a space", { github: "a/b c" }],
    [
      "a 51-entry status map",
      { statusMap: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`s${i}`, "done"])) },
    ],
    ["an extra key", { path: "/etc/passwd" }],
    ["flightPowers (only the config file sets it)", { flightPowers: "superuser" }],
  ])("400 for %s, nothing written", async (_name, over) => {
    const r = await postBody("/api/repos", { ...NEW_REPO, ...over });
    expect(r.statusCode).toBe(400);
    unchanged();
  });

  it("409 for a repo already in the file or already loaded", async () => {
    // in the file (the example's shop-app) and loaded (the fixture's shop-app)
    expect((await postBody("/api/repos", { ...NEW_REPO, id: "shop-app" })).statusCode).toBe(409);
    // loaded only: the fixture's o/ae project 3 is not in the example file
    const loaded = await postBody("/api/repos", { ...NEW_REPO, github: "O/AE", project: 3 });
    expect(loaded.statusCode).toBe(409);
    // in the file only: the example's octo-org/shop-app project 2
    const inFile = await postBody("/api/repos", {
      ...NEW_REPO,
      github: "Octo-Org/shop-app",
      project: 2,
    });
    expect(inFile.statusCode).toBe(409);
    unchanged();
  });

  it("409 when the server has no config path", async () => {
    const a = buildApp({ config, store, bus });
    const r = await a.inject({
      method: "POST",
      url: "/api/repos",
      headers: json,
      payload: JSON.stringify(NEW_REPO),
    });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: "config writes are not available on this server" });
    unchanged();
    await a.close();
  });

  it("500 when the write fails; logs the reason", async () => {
    chmodSync(dir, 0o500);
    try {
      const r = await postBody("/api/repos", NEW_REPO);
      expect(r.statusCode).toBe(500);
      expect(r.json()).toEqual({ error: "could not write config.yaml" });
      expect(logs.join("")).toContain("config write failed");
    } finally {
      chmodSync(dir, 0o700);
    }
    unchanged();
  });

  it("409 when the current file does not load; says so, never the contents", async () => {
    writeFileSync(configPath, "operator: [ghp_LEAKED_TOKEN\n");
    const events: string[] = [];
    bus.subscribe((t) => events.push(t));
    const r = await postBody("/api/repos", NEW_REPO);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: "the current config.yaml does not load" });
    expect(readFileSync(configPath, "utf8")).toBe("operator: [ghp_LEAKED_TOKEN\n");
    expect(config.repos).toHaveLength(2);
    expect(events).toEqual([]);
    expect(r.body).not.toContain("ghp_LEAKED_TOKEN");
    expect(logs.join("")).not.toContain("ghp_LEAKED_TOKEN");
  });

  it("409 when config.yaml is a symbolic link; the link and its target are unchanged", async () => {
    const target = join(dir, "real.yaml");
    writeFileSync(target, exampleText());
    rmSync(configPath);
    symlinkSync(target, configPath);
    const r = await postBody("/api/repos", NEW_REPO);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: "config.yaml is a symbolic link" });
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(configPath)).toBe(target);
    expect(readFileSync(target, "utf8")).toBe(exampleText());
    expect(readdirSync(dir).some((f) => f.startsWith("config.yaml.bak-"))).toBe(false);
    expect(config.repos).toHaveLength(2);
  });
});

describe("POST /api/github/refresh", () => {
  it("answers 202 and asks for a refresh", async () => {
    const r = await post("/api/github/refresh");
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ ok: true });
    expect(refreshed).toBe(1);
  });
});

describe("board setup", () => {
  it("GET reports what is missing, without the project id, and writes nothing", async () => {
    const r = await get("/api/boards/shop-app/setup");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      missing: ["Stage", "Owner", "Priority", "Size"],
      mismatched: [],
      missingLabels: TYPE_LABELS.map((l) => l.name),
    });
    expect(gqlCalls.some((c) => c.query.includes("mutation"))).toBe(false);
  });

  it("GET reports no missing labels when all are present, matched without case", async () => {
    repoLabels = TYPE_LABELS.map((l) => l.name.toUpperCase());
    const r = await get("/api/boards/shop-app/setup");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ missingLabels: [] });
  });

  it("GET reports only the type labels the repo lacks", async () => {
    repoLabels = ["type:feature", "type:docs", "bug", "p0"];
    const r = await get("/api/boards/shop-app/setup");
    expect(r.json().missingLabels).toEqual([
      "type:bug",
      "type:chore",
      "type:test",
      "type:research",
    ]);
    expect(gqlCalls.some((c) => c.query.includes("mutation"))).toBe(false);
  });

  it("GET answers 502 when the labels cannot be read", async () => {
    labelReadFail = true;
    const r = await get("/api/boards/shop-app/setup");
    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({ error: "GitHub setup failed: github: HTTP 503" });
  });

  it("POST creates the missing fields and type labels, refreshes the board, and a second POST creates nothing", async () => {
    const r = await post("/api/boards/shop-app/setup");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      created: ["Stage", "Owner", "Priority", "Size"],
      mismatched: [],
      labelsCreated: TYPE_LABELS.map((l) => l.name),
    });
    expect(refreshed).toBe(1);
    const again = await post("/api/boards/shop-app/setup");
    expect(again.json()).toEqual({ created: [], mismatched: [], labelsCreated: [] });
    expect(gqlCalls.filter((c) => c.query.includes("createProjectV2Field")).length).toBe(4);
    expect(repoLabels).toEqual(TYPE_LABELS.map((l) => l.name));
  });

  it("targets the repo's own owner and project number", async () => {
    await post("/api/boards/site-builder/setup");
    expect(gqlCalls[0]?.vars).toEqual({ owner: "o", number: 3 });
  });

  it("answers 404 for an unknown repo and never calls GitHub", async () => {
    expect((await get("/api/boards/nope/setup")).statusCode).toBe(404);
    expect((await post("/api/boards/nope/setup")).statusCode).toBe(404);
    expect(gqlCalls).toEqual([]);
  });

  it("answers 502 with GitHub's message when GitHub fails, and does not refresh", async () => {
    gqlFail = true;
    const r = await post("/api/boards/shop-app/setup");
    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({ error: "GitHub setup failed: github: HTTP 502" });
    expect((await get("/api/boards/shop-app/setup")).statusCode).toBe(502);
    expect(refreshed).toBe(0);
  });

  it("after Owner fails following Stage: 502 with no created, GET shows Owner missing, retry creates only Owner", async () => {
    gqlFailField = "Owner";
    const r = await post("/api/boards/shop-app/setup");
    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({ error: "GitHub setup failed: github: HTTP 500" });
    expect(r.json()).not.toHaveProperty("created");
    expect(refreshed).toBe(0);
    expect((await get("/api/boards/shop-app/setup")).json()).toEqual({
      missing: ["Owner", "Priority", "Size"],
      mismatched: [],
      missingLabels: TYPE_LABELS.map((l) => l.name),
    });
    gqlFailField = null;
    gqlCalls.length = 0;
    expect((await post("/api/boards/shop-app/setup")).json()).toMatchObject({
      created: ["Owner", "Priority", "Size"],
      mismatched: [],
    });
    const made = gqlCalls.filter((c) => c.query.includes("createProjectV2Field"));
    expect(made.map((c) => (c.vars.input as { name: string }).name)).toEqual([
      "Owner",
      "Priority",
      "Size",
    ]);
  });

  it("answers 502 when a label cannot be created, and the next POST creates the rest", async () => {
    labelFail = "type:docs";
    const r = await post("/api/boards/shop-app/setup");
    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({ error: "GitHub setup failed: github: HTTP 500" });
    // the fields were created before the label failed, so the board is refreshed
    expect(refreshed).toBe(1);
    labelFail = null;
    const again = await post("/api/boards/shop-app/setup");
    expect(again.json()).toMatchObject({
      created: [],
      labelsCreated: ["type:docs", "type:research"],
    });
  });

  it("answers 502 without claiming a created field when the token cannot be read", async () => {
    const a = buildApp({
      config,
      store,
      bus,
      githubGql: async () => {
        throw new Error("gh: could not read a GitHub token (run `gh auth login`)");
      },
    });
    const r = await a.inject({
      method: "POST",
      url: "/api/boards/shop-app/setup",
      headers: json,
      payload: "{}",
    });
    expect(r.statusCode).toBe(502);
    expect(r.json()).not.toHaveProperty("created");
    await a.close();
  });

  it("requires JSON and a same-origin request", async () => {
    expect((await post("/api/boards/shop-app/setup", {})).statusCode).toBe(415);
    const r = await post("/api/boards/shop-app/setup", { ...json, origin: "https://evil.example" });
    expect(r.statusCode).toBe(403);
    expect(gqlCalls).toEqual([]);
  });
});

describe("GET /api/machine", () => {
  it("answers { latest: null } before the first sample, then the scheduler's latest", async () => {
    expect((await get("/api/machine")).json()).toEqual({
      latest: null,
      maxSeats: 8,
      seats: 0,
      perSessionMax: 0,
    });
    const latest: MachineSample = {
      at: NOW,
      cpuPct: null,
      cores: 8,
      memUsedBytes: 1,
      memTotalBytes: 2,
      diskFreeBytes: 3,
      diskTotalBytes: 4,
      agents: null,
    };
    const a = buildApp({ config, store, bus, machine: () => latest });
    const r = await a.inject({ method: "GET", url: "/api/machine" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ latest, maxSeats: 8, seats: 0, perSessionMax: 0 });
    await a.close();
  });

  it("carries the crew's seat cap, configured seats and largest session", async () => {
    const seat = (id: string) => ({
      id,
      role: "GUIDO",
      accountId: "claude-main",
      model: "sonnet",
      area: [],
    });
    config.crew = {
      worktrees: join(dir, "crew"),
      maxSeats: 8,
      sessions: [
        {
          id: "s1",
          repoId: "shop-app",
          checkout: join(dir, "clone"),
          seats: [seat("a-1"), seat("a-2"), seat("a-3")],
        },
        { id: "s2", repoId: "shop-app", checkout: join(dir, "clone2"), seats: [seat("b-1")] },
      ],
    };
    const r = await get("/api/machine");
    expect(r.json()).toMatchObject({ maxSeats: 8, seats: 4, perSessionMax: 3 });
  });
});

describe("local access", () => {
  it("serves /api without any cookie", async () => {
    expect((await get("/api/health")).statusCode).toBe(200);
    withCrew();
    for (const [method, url, body] of API_ROUTES) {
      if (url === "/api/stream") continue; // never ends; the SSE tests cover it
      if (url === "/api/comms/read") continue; // needs a stored Comms message; Comms tests cover it
      if (url.endsWith("/seats")) continue; // needs seatWrites and a real body; its own tests cover it
      if (url === "/api/guard/check") {
        // the hook's run token is its only key (guard.test.ts); there is no cookie to need
        expect((await post(url, json, body)).statusCode).toBe(401);
        continue;
      }
      const r =
        method === "GET"
          ? await get(url)
          : method === "PUT" || method === "DELETE"
            ? await app.inject({
                method,
                url: url.replace(":repo", "shop-app").replace(":topic", "topic"),
                payload: body,
              })
            : await post(url, json, body);
      if (url.endsWith("/files") || url.includes("/files/diff")) {
        // the shared fixture has no git worktree: answered (503), not refused
        expect([401, 403, 404], `${method} ${url}`).not.toContain(r.statusCode);
        continue;
      }
      if (url.startsWith("/api/runs/")) {
        // the fixture has no such run: unknown is a 404, not a refusal
        expect(r.statusCode, `${method} ${url}`).toBe(404);
        continue;
      }
      if (url.startsWith("/api/drafts/") && method === "POST") {
        // the fixture has no such draft: unknown is a 404, not a refusal
        expect(r.statusCode, `${method} ${url}`).toBe(404);
        continue;
      }
      if (url.endsWith("/discussion")) {
        expect(r.statusCode, `${method} ${url}`).toBe(method === "GET" ? 404 : 409);
        continue;
      }
      if (
        url.endsWith("/dismiss") ||
        url.endsWith("/handled") ||
        url.includes("/replies/") ||
        url.endsWith("/hold") ||
        url.endsWith("/hold/release")
      ) {
        // the fixture has no such note: unknown is a 404, not a refusal
        expect(r.statusCode, `${method} ${url}`).toBe(404);
        continue;
      }
      if (url === "/api/github/refresh") {
        // accepted, not done: the read happens later
        expect(r.statusCode, `${method} ${url}`).toBe(202);
        continue;
      }
      if (
        (method === "POST" && url.endsWith("/focus")) ||
        url.includes("/queue/reorder") ||
        url === "/api/profiles" ||
        url === "/api/sources/teams/selection" ||
        (method === "POST" && (url === "/api/crew/sessions" || url.endsWith("/close")))
      ) {
        // the fixture has no config path: a valid selection can't be written
        expect(r.statusCode, `${method} ${url}`).toBe(409);
        continue;
      }
      if (url === "/api/accounts" && method === "POST") {
        expect(r.statusCode).toBe(409);
        expect(r.json().error).toContain("one account per provider");
        continue;
      }
      if (url === "/api/attention/unknown") {
        expect(r.statusCode).toBe(404);
        continue;
      }
      if (url === "/api/repos/shop-app/map/diff") {
        expect(r.statusCode).toBe(503);
        expect(r.json()).toEqual({ error: "map collector unavailable" });
        continue;
      }
      if (url === "/api/repos/shop-app/map/conflicts" || url === "/api/repos/shop-app/map") {
        // This fixture has no crew checkout to check.
        expect(r.statusCode).toBe(503);
        expect(r.json()).toEqual({ error: "map checkout unavailable" });
        continue;
      }
      expect(r.statusCode, `${method} ${url}`).toBe(200);
    }
  });

  it("checks profile safety inside the supervisor account exclusion", async () => {
    const sup = stubSupervisor();
    let excluded = false;
    sup.withAccountUpdate = async (fn) => {
      excluded = true;
      return fn();
    };
    sup.busy = () => (excluded ? [{ seatId: "fictional-seat", state: "starting" }] : []);
    const a = buildApp({ config, store, bus, configPath, supervisor: sup });
    try {
      const result = await a.inject({
        method: "POST",
        url: "/api/accounts",
        payload: {
          name: "fictional-profile",
          provider: "codex",
          cliProfile: join(dir, "fictional-profile"),
        },
      });
      expect(result.statusCode).toBe(409);
      expect(excluded).toBe(true);
    } finally {
      await a.close();
    }
  });

  it("refuses a new CLI profile while an existing sandbox could read it", async () => {
    store.upsertRun({ ...run({}), endedAt: null });
    store.setSeatSession({
      seatId: "fictional-seat",
      runId: run({}).id,
      cliSessionId: "fictional-session",
      state: "idle",
      reason: null,
      worktree: null,
      updatedAt: 1,
    });
    const before = readFileSync(configPath, "utf8");
    const result = await app.inject({
      method: "POST",
      url: "/api/accounts",
      payload: {
        name: "fictional-profile",
        provider: "codex",
        cliProfile: join(dir, "fictional-profile"),
      },
    });
    expect(result.statusCode).toBe(409);
    expect(result.json().error).toContain("end existing seat processes");
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("grants no cross-origin read or preflight", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "https://evil.example" },
    });
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    const pre = await app.inject({
      method: "OPTIONS",
      url: "/api/agents/shop-app-ta/pause",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
      },
    });
    for (const h of Object.keys(pre.headers)) expect(h).not.toMatch(/^access-control-allow-/);
    expect(existsSync(join(stateDir, "PAUSE"))).toBe(false);
  });

  it("refuses a POST whose Origin is the literal null (403)", async () => {
    const r = await post("/api/agents/shop-app-ta/pause", { ...json, origin: "null" });
    expect(r.statusCode).toBe(403);
  });

  it("has no login, logout, setup or auth-state routes", async () => {
    for (const url of ["/login", "/logout", "/setup"]) {
      expect((await post(url)).statusCode, `POST ${url}`).toBe(404);
    }
    expect((await get("/auth/state")).statusCode).toBe(404);
  });

  it("an unknown /api path is 404", async () => {
    expect((await get("/api/nope")).statusCode).toBe(404);
  });

  it("refuses a non-JSON POST (415)", async () => {
    const form = await post("/api/agents/shop-app-ta/pause", {
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(form.statusCode).toBe(415);
    expect((await post("/api/agents/shop-app-ta/pause", {})).statusCode).toBe(415);
    expect(existsSync(join(stateDir, "PAUSE"))).toBe(false);
  });

  it("refuses a POST from a foreign Origin (403)", async () => {
    for (const origin of ["https://evil.example", "http://localhost.evil.example", "not a url"]) {
      const r = await post("/api/agents/shop-app-ta/pause", { ...json, origin });
      expect(r.statusCode, origin).toBe(403);
      expect(r.json()).toEqual({ error: "cross-origin request refused" });
    }
    expect(existsSync(join(stateDir, "PAUSE"))).toBe(false);
    for (const origin of ["http://127.0.0.1:7420", "http://localhost:7420"]) {
      const r = await post("/api/agents/shop-app-ta/pause", { ...json, origin });
      expect(r.statusCode, origin).toBe(200);
    }
    // No Origin header (curl, same-origin GET-less tooling) is allowed.
    expect((await post("/api/agents/shop-app-ta/resume")).statusCode).toBe(200);
  });

  it("refuses a cross-site request under /api (403) before its handler runs", async () => {
    const headers = { "sec-fetch-site": "cross-site" };
    for (const url of [
      "/api/boards/shop-app/setup",
      "/api/boards/shop-app/items/1",
      "/%61pi/boards/shop-app/setup",
    ]) {
      const r = await app.inject({ method: "GET", url, headers });
      expect(r.statusCode, url).toBe(403);
      expect(r.json()).toEqual({ error: "cross-site request refused" });
    }
    const p = await post("/api/boards/shop-app/setup", { ...json, ...headers });
    expect(p.statusCode).toBe(403);
    expect(p.json()).toEqual({ error: "cross-site request refused" });
    expect(gqlCalls).toEqual([]);
  });

  it("lets same-origin, none and header-less GETs reach the handler", async () => {
    for (const headers of [{ "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "none" }, {}]) {
      const r = await app.inject({ method: "GET", url: "/api/boards/shop-app/setup", headers });
      expect(r.statusCode, JSON.stringify(headers)).toBe(200);
    }
    expect(gqlCalls.length).toBeGreaterThan(0);
  });

  it("refuses an unexpected Host (421)", async () => {
    for (const host of ["localhost", "localhost:7420", "127.0.0.1:7420", "LOCALHOST:1"]) {
      expect(
        (await app.inject({ method: "GET", url: "/api/health", headers: { host } })).statusCode,
        host,
      ).toBe(200);
    }
    for (const host of [
      "evil.example",
      "evil.example:7420",
      "localhost.evil.example",
      "127.0.0.2:7420",
      "mc.tailnet.ts.net",
    ]) {
      for (const req of [
        { method: "GET" as const, url: "/api/health", headers: { host } },
        { method: "GET" as const, url: "/api/nope", headers: { host } },
        {
          method: "POST" as const,
          url: "/api/agents/shop-app-ta/pause",
          headers: { ...json, host },
          payload: {},
        },
      ]) {
        const r = await app.inject(req);
        expect(r.statusCode, `${host} ${req.method} ${req.url}`).toBe(421);
      }
    }
    expect(existsSync(join(stateDir, "PAUSE"))).toBe(false);
  });

  it("the operator can persist, read and clear a crew pause", async () => {
    withCrew();
    const pause = { seats: "all", reason: "Save tokens" };
    const r = await postBody("/api/settings/crew-pause", pause);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ...pause, at: clock, by: config.operator.id });
    expect((await get("/api/settings/crew-pause")).json()).toEqual(r.json());
    expect(JSON.parse(store.getSetting("crew.paused") ?? "null")).toEqual(r.json());
    const crew = (await get("/api/crew")).json();
    const seat = crew.rows.find((row: { kind: string }) => row.kind === "crew");
    expect(seat.crewPause).toEqual(r.json());
    const scoped = await postBody("/api/settings/crew-pause", {
      seats: [seat.id],
      reason: "Save tokens",
    });
    expect(scoped.json().seats).toEqual([seat.id]);
    expect((await postBody(`/api/seats/${seat.id}/start`, { issue: 7 })).statusCode).toBe(409);
    expect((await postBody("/api/settings/crew-pause", { seats: null })).statusCode).toBe(200);
    expect((await get("/api/settings/crew-pause")).json()).toBeNull();
  });

  it("refuses an empty reason or unknown pause seats", async () => {
    for (const body of [
      { seats: "all", reason: " " },
      { seats: [], reason: "Save tokens" },
      { seats: ["missing-seat"], reason: "Save tokens" },
    ]) {
      expect((await postBody("/api/settings/crew-pause", body)).statusCode).toBe(400);
    }
  });

  it("every registered /api route is in the route table", () => {
    const table = new Set(
      API_ROUTES.map(
        ([m, u]) =>
          `${m} ${u
            .split("?")[0]
            ?.replace("/attention/unknown", "/attention/:key")
            .replace("/comms/agents/guido-1/contacts/CAPCOM", "/comms/agents/:id/contacts/:contact")
            .replace("/comms/agents/guido-1", "/comms/agents/:id")
            .replace("/comms/pairs/guido-1/CAPCOM", "/comms/pairs/:a/:b")
            .replace("/comms/tickets/%237", "/comms/tickets/:ref")
            .replace("/shop-app-ta/", "/:id/")
            .replace("/guido-1/", "/:id/")
            .replace(/\/guido-1$/, "/:id")
            .replace(/\/comms:\d+(?=\/|$)/, "/:id")
            .replace("/claude-main/", "/:id/")
            .replace("/shop-app", "/:repoId")
            .replace("/items/7", "/items/:number")
            .replace(/\/attention\/[^/]+\/hold(\/release)?$/, "/attention/:key/hold$1")
            .replace(/\/attention\/[^/]+\/dismiss$/, "/attention/:key/dismiss")
            .replace(/\/attention\/[^/]+\/handled$/, "/attention/:key/handled")
            .replace(/\/attention\/[^/]+\/discussion$/, "/attention/:key/discussion")
            .replace(
              /\/attention\/[^/]+\/replies\/[^/]+\/post$/,
              "/attention/:key/replies/:replyId/post",
            )}`,
      ),
    );
    const registered = apiRoutes.filter((r) => !r.startsWith("HEAD "));
    expect(registered.length).toBeGreaterThan(0);
    expect(new Set(registered)).toEqual(table);
  });

  it("never logs a cookie or authorization header", async () => {
    await get("/api/health");
    app.log.info({ headers: { cookie: "cc=secretvalue", authorization: "Bearer tok" } }, "probe");
    const text = logs.join("");
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain("secretvalue");
    expect(text).not.toContain("Bearer tok");
  });
});

describe("agents", () => {
  it("runs honours ?limit and validates it as an integer 1..500", async () => {
    for (let i = 1; i <= 3; i++) store.upsertRun(run({ id: `r${i}`, seq: i, startedAt: NOW - i }));
    const two = await get("/api/agents/shop-app-ta/runs?limit=2");
    expect(two.statusCode).toBe(200);
    expect((two.json() as Run[]).map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(((await get("/api/agents/shop-app-ta/runs")).json() as Run[]).length).toBe(3);
    expect((await get("/api/agents/shop-app-ta/runs?limit=500")).statusCode).toBe(200);
    for (const bad of ["0", "501", "abc", "1.5", "-1", "", "1e2"]) {
      const r = await get(`/api/agents/shop-app-ta/runs?limit=${bad}`);
      expect(r.statusCode, `limit=${bad}`).toBe(400);
    }
    expect((await get("/api/agents/nope/runs")).statusCode).toBe(404);
  });

  // #26 A3: a run lists the PRs it published, joined to the stored rows, and its ticket falls
  // back to a PR's.
  it("runs carry their PRs and the resolved ticket", async () => {
    store.upsertPullRequests(
      "shop-app",
      [
        {
          repoId: "shop-app",
          number: 41,
          title: "Quote cache",
          url: "https://github.com/o/shop-app/pull/41",
          branch: "chore/cache",
          ticket: "shop-app#3349",
          state: "open",
          isDraft: false,
          review: null,
          ci: null,
          createdAt: 1,
          updatedAt: 2,
          mergedAt: null,
          headSha: null,
          mergeable: null,
        },
      ],
      0,
    );
    store.upsertRun(
      run({
        id: "r1",
        summary: "Opened PR #41.",
        prs: [
          { repo: "O/shop-app", number: 41 },
          { repo: "elsewhere/x", number: 2 },
        ],
      }),
    );
    store.upsertRun(run({ id: "r2", startedAt: NOW - 2 * HOUR, ticket: "shop-app#7" }));
    const rows = (await get("/api/agents/shop-app-ta/runs")).json() as RunView[];
    expect(rows.map((r) => [r.id, r.ticket, r.summary])).toEqual([
      ["r1", "shop-app#3349", "Opened PR #41."],
      ["r2", "shop-app#7", null],
    ]);
    expect(rows[0]?.prs).toEqual([
      {
        repoId: "shop-app",
        number: 41,
        title: "Quote cache",
        url: "https://github.com/o/shop-app/pull/41",
        state: "open",
        ticket: "shop-app#3349",
      },
    ]);
    expect(rows[1]?.prs).toEqual([]);
  });
});

const digest = (over: Partial<RunDigest> = {}): RunDigest => ({
  toolCalls: 0,
  turns: 0,
  lastEventAt: null,
  model: null,
  contextTokens: null,
  contextWindow: null,
  liveTool: null,
  tools: {},
  subagents: [],
  minuteTokens: [],
  turnUsage: [],
  background: [],
  compactions: 0,
  ...over,
});

const line = (text: string, at: number) =>
  `${JSON.stringify({
    type: "assistant",
    message: { id: `m${at}`, content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    timestamp: new Date(at).toISOString(),
  })}\n`;

describe("agent files", () => {
  const withFiles = async (fn: (wt: string) => Promise<ChangedFiles>) => {
    const a = buildApp({
      config,
      store,
      bus,
      changedFiles: fn,
      logger: { stream: { write: (s: string) => void logs.push(s) } },
    });
    await a.ready();
    return a;
  };

  it("worktree missing is 503 with fixed text, and git is never run", async () => {
    const calls: string[] = [];
    const a = await withFiles(async (wt) => {
      calls.push(wt);
      return { files: [], note: null, sha: null };
    });
    const r = await a.inject({ method: "GET", url: "/api/agents/shop-app-ta/files" });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: "worktree missing" });
    expect(calls).toEqual([]);
    await a.close();
  });

  it("returns the worktree's changed files", async () => {
    mkdirSync(join(dir, "wt-ta"));
    const out: ChangedFiles = {
      files: [{ path: "a.ts", add: 1, del: 0, state: "uncommitted" }],
      note: "no origin/HEAD: showing uncommitted changes only",
      sha: "a".repeat(40),
    };
    const seen: string[] = [];
    const a = await withFiles(async (wt) => {
      seen.push(wt);
      return out;
    });
    const r = await a.inject({ method: "GET", url: "/api/agents/shop-app-ta/files" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(out);
    expect(seen).toEqual([join(dir, "wt-ta")]);
    await a.close();
  });

  it("every git call failing is 502 with fixed text (no path, no git message)", async () => {
    mkdirSync(join(dir, "wt-ta"));
    const a = await withFiles(async () => {
      throw new GitFailed(`fatal: not a git repository: ${dir}`);
    });
    const r = await a.inject({ method: "GET", url: "/api/agents/shop-app-ta/files" });
    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({ error: "git failed" });
    await a.close();
  });

  it("a total failure keeps the filter note in the 502", async () => {
    mkdirSync(join(dir, "wt-ta"));
    const a = await withFiles(async () => {
      throw new GitFailed("git failed", {
        note: "repo uses git filters: uncommitted changes not read",
      });
    });
    const r = await a.inject({ method: "GET", url: "/api/agents/shop-app-ta/files" });
    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({
      error: "git failed",
      note: "repo uses git filters: uncommitted changes not read",
    });
    await a.close();
  });

  it.each([false, true])("logs original files errors, diff=%s", async (diff) => {
    mkdirSync(join(dir, "wt-ta"));
    const error = new Error("original files failure");
    const fail = async () => {
      throw error;
    };
    const a = buildApp({
      config,
      store,
      bus,
      changedFiles: fail,
      fileDiff: fail,
      logger: { stream: { write: (s: string) => void logs.push(s) } },
    });
    logs.length = 0;
    const response = await a.inject({
      method: "GET",
      url: `/api/agents/shop-app-ta/files${diff ? "/diff?path=a.ts" : ""}`,
    });
    expect(response.statusCode).toBe(502);
    const completed = logs.map((s) => JSON.parse(s)).filter((s) => s.msg === "request completed");
    expect(completed).toHaveLength(1);
    expect(completed[0].err).toMatchObject({ message: error.message, stack: error.stack });
    await a.close();
  });

  it("unknown agent is 404", async () => {
    expect((await get("/api/agents/nope/files")).statusCode).toBe(404);
  });
});

describe("agent file diff", () => {
  const url = (path: string) =>
    `/api/agents/shop-app-ta/files/diff?path=${encodeURIComponent(path)}`;
  const withDiff = async (fn: (wt: string, path: string) => Promise<FileDiff | null>) => {
    const a = buildApp({
      config,
      store,
      bus,
      fileDiff: fn,
      logger: { stream: { write: (s: string) => void logs.push(s) } },
    });
    await a.ready();
    return a;
  };

  it("worktree missing is 503 with fixed text, and git is never run", async () => {
    const calls: string[] = [];
    const a = await withDiff(async (wt) => {
      calls.push(wt);
      return null;
    });
    const r = await a.inject({ method: "GET", url: url("a.ts") });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: "worktree missing" });
    expect(calls).toEqual([]);
    await a.close();
  });

  it("returns the file's diff", async () => {
    mkdirSync(join(dir, "wt-ta"));
    const out: FileDiff = {
      path: "a b.ts",
      text: "+x",
      truncated: false,
      binary: false,
      sha: "a".repeat(40),
    };
    const seen: [string, string][] = [];
    const a = await withDiff(async (wt, p) => {
      seen.push([wt, p]);
      return out;
    });
    const r = await a.inject({ method: "GET", url: url("a b.ts") });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(out);
    expect(seen).toEqual([[join(dir, "wt-ta"), "a b.ts"]]);
    await a.close();
  });

  it("a path not in the list is 404; a missing or repeated path is 400", async () => {
    mkdirSync(join(dir, "wt-ta"));
    const a = await withDiff(async () => null);
    const r = await a.inject({ method: "GET", url: url("../etc/passwd") });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: "unknown file" });
    for (const q of ["", "?path=", "?path=a&path=b"]) {
      const bad = await a.inject({ method: "GET", url: `/api/agents/shop-app-ta/files/diff${q}` });
      expect(bad.statusCode, q).toBe(400);
    }
    await a.close();
  });

  it("git failing is 502 with fixed text and its original error is logged", async () => {
    mkdirSync(join(dir, "wt-ta"));
    const a = await withDiff(async () => {
      throw new GitFailed("fatal: bad revision 'origin/HEAD...HEAD'");
    });
    const r = await a.inject({ method: "GET", url: url("a.ts") });
    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({ error: "git failed" });
    const completed = logs.map((l) => JSON.parse(l)).find((l) => l.msg === "request completed");
    expect(completed.err).toMatchObject({
      message: "fatal: bad revision 'origin/HEAD...HEAD'",
      stack: expect.stringContaining("GitFailed"),
    });
    expect(logs.join("")).not.toContain(join(dir, "wt-ta"));
    await a.close();
  });

  it("unknown agent is 404", async () => {
    expect((await get("/api/agents/nope/files/diff?path=a")).statusCode).toBe(404);
  });

  it("with real git: a listed file's diff; ../etc/passwd and unlisted paths are 404", async () => {
    const wt = join(dir, "wt-ta");
    mkdirSync(wt);
    execFileSync("git", ["-C", wt, "init", "-q"]);
    writeFileSync(join(wt, "new.txt"), "hello\n");
    const ok = await get(url("new.txt"));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({
      path: "new.txt",
      text: "+hello",
      truncated: false,
      binary: false,
      sha: null, // a repo with no commit has no HEAD to name
    });
    for (const p of ["../etc/passwd", "/etc/passwd", "other.txt"]) {
      expect((await get(url(p))).statusCode, p).toBe(404);
    }
  });

  it("with real git: a listed name that cleaning changed is 404, and the ignored file it names is never read", async () => {
    const wt = join(dir, "wt-ta");
    mkdirSync(wt);
    execFileSync("git", ["-C", wt, "init", "-q"]);
    writeFileSync(join(wt, ".gitignore"), "x.env\n");
    writeFileSync(join(wt, "x.env"), "TOKEN=hunter2\n");
    writeFileSync(join(wt, "x\x07.env"), "harmless\n");
    const r = await get(url("x.env"));
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain("hunter2");
  });
});

describe("agent stream", () => {
  const transcript = (name: string, text: string, mtime: number) => {
    const p = join(dir, name);
    writeFileSync(p, text);
    utimesSync(p, mtime / 1000, mtime / 1000);
    return p;
  };
  const stream = async (url: string) => {
    const r = await get(url);
    expect(r.statusCode, url).toBe(200);
    return r.json() as AgentStream;
  };

  it("serves the latest run's events with lastOutputAt", async () => {
    const p = transcript("t.jsonl", line("hello", NOW - 2 * 60e3), NOW - 60e3);
    store.upsertRun(run({ id: "old", startedAt: NOW - 3 * HOUR, transcriptPath: "" }));
    store.upsertRun(run({ id: "r1", startedAt: NOW - HOUR, transcriptPath: p }));
    const s = await stream("/api/agents/shop-app-ta/stream");
    expect(s).toEqual({
      runId: "r1",
      tasks: [],
      events: [{ id: "0:0", at: NOW - 2 * 60e3, kind: "msg", text: "hello" }],
      truncated: false,
      lastOutputAt: NOW - 60e3,
      reason: null,
    });
  });

  it("no runs: an empty stream with the reason", async () => {
    expect(await stream("/api/agents/studio-builder/stream")).toEqual({
      runId: null,
      events: [],
      truncated: false,
      lastOutputAt: null,
      reason: "no runs yet",
    });
  });

  it("a missing transcript: the reason as fixed text, never the path", async () => {
    const gone = join(dir, "secret-dir", "gone.jsonl");
    store.upsertRun(run({ id: "r1", transcriptPath: gone }));
    store.setDigest("r1", digest({ lastEventAt: NOW - 5 * 60e3 }));
    const r = await get("/api/agents/shop-app-ta/stream");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      runId: "r1",
      tasks: [],
      events: [],
      truncated: false,
      lastOutputAt: NOW - 5 * 60e3,
      reason: "transcript not found",
    });
    expect(r.body).not.toContain("secret-dir");
    expect(r.body).not.toContain(dir);
    // A run with no transcript path at all reads the same.
    store.upsertRun(run({ id: "r2", startedAt: NOW, transcriptPath: "" }));
    expect((await stream("/api/agents/shop-app-ta/stream")).reason).toBe("transcript not found");
    expect(streamReads).not.toHaveBeenCalled();
  });

  it("validates limit (1..500, default 200) and 404s an unknown agent", async () => {
    const p = transcript("t.jsonl", line("x", NOW - 1000), NOW - 1000);
    store.upsertRun(run({ id: "r1", transcriptPath: p }));
    await stream("/api/agents/shop-app-ta/stream");
    expect(streamReads).toHaveBeenLastCalledWith(p, 200, undefined);
    await stream("/api/agents/shop-app-ta/stream?limit=500");
    expect(streamReads).toHaveBeenLastCalledWith(p, 500, undefined);
    for (const bad of ["0", "501", "abc", "1.5", "-1", "", "1e2"]) {
      const r = await get(`/api/agents/shop-app-ta/stream?limit=${bad}`);
      expect(r.statusCode, `limit=${bad}`).toBe(400);
    }
    expect((await get("/api/agents/nope/stream")).statusCode).toBe(404);
  });

  it("reads an unchanged transcript once; a new mtime, size, limit or run path reads again", async () => {
    const p = transcript("t.jsonl", line("one", NOW - 5000), NOW - 5000);
    store.upsertRun(run({ id: "r1", transcriptPath: p }));
    const url = "/api/agents/shop-app-ta/stream";
    const first = await stream(url);
    expect(await stream(url)).toEqual(first);
    expect(streamReads).toHaveBeenCalledTimes(1);

    utimesSync(p, (NOW - 4000) / 1000, (NOW - 4000) / 1000); // mtime only
    await stream(url);
    expect(streamReads).toHaveBeenCalledTimes(2);

    appendFileSync(p, line("two", NOW - 3000));
    utimesSync(p, (NOW - 4000) / 1000, (NOW - 4000) / 1000); // size only
    expect((await stream(url)).events.map((e) => e.text)).toEqual(["one", "two"]);
    expect(streamReads).toHaveBeenCalledTimes(3);

    await stream(`${url}?limit=1`);
    expect(streamReads).toHaveBeenCalledTimes(4);
    await stream(`${url}?limit=1`);
    expect(streamReads).toHaveBeenCalledTimes(4);

    const q = transcript("u.jsonl", line("one", NOW - 5000), NOW - 4000);
    store.upsertRun(run({ id: "r2", startedAt: NOW - 1000, transcriptPath: q }));
    expect((await stream(`${url}?limit=1`)).runId).toBe("r2");
    expect(streamReads).toHaveBeenCalledTimes(5);
  });

  it("lastOutputAt is the transcript mtime when that is newer than the last event (heartbeats)", async () => {
    // A long tool call: the newest event is 15 min old, but heartbeats touched the file 1 min ago.
    const p = transcript("t.jsonl", line("running tests", NOW - 15 * 60e3), NOW - 60e3);
    store.upsertRun(run({ id: "r1", transcriptPath: p }));
    store.setDigest("r1", digest({ lastEventAt: NOW - 15 * 60e3 }));
    expect((await stream("/api/agents/shop-app-ta/stream")).lastOutputAt).toBe(NOW - 60e3);
    // And the newest event when it is newer than the file time.
    store.setDigest("r1", digest({ lastEventAt: NOW - 30e3 }));
    expect((await stream("/api/agents/shop-app-ta/stream")).lastOutputAt).toBe(NOW - 30e3);
  });
});

describe("pause control", () => {
  it("pause on a ta-loop creates an empty PAUSE file and the agent shows paused: true", async () => {
    const events: string[] = [];
    bus.subscribe((t) => events.push(t));
    const r = await post("/api/agents/shop-app-ta/pause");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ id: "shop-app-ta", paused: true });
    expect(existsSync(join(stateDir, "PAUSE"))).toBe(true);
    expect((await post("/api/agents/shop-app-ta/pause")).statusCode).toBe(200); // already paused
    const rows = (await get("/api/crew")).json<Crew>().rows;
    expect(rows[0]?.paused).toBe(true);
    expect(events).toContain("agents");
  });

  it("resume removes PAUSE, and is fine when it is already absent", async () => {
    writeFileSync(join(stateDir, "PAUSE"), "");
    const r = await post("/api/agents/shop-app-ta/resume");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ id: "shop-app-ta", paused: false });
    expect(existsSync(join(stateDir, "PAUSE"))).toBe(false);
    expect((await post("/api/agents/shop-app-ta/resume")).statusCode).toBe(200);
    expect((await get("/api/crew")).json<Crew>().rows[0]?.paused).toBe(false);
  });

  it("pause on a studio loop is 409 and writes nothing", async () => {
    for (const action of ["pause", "resume"]) {
      const r = await post(`/api/agents/studio-builder/${action}`);
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error: "pause for studio-loop arrives with cutover" });
    }
    expect(existsSync(join(dir, "studio", "PAUSE"))).toBe(false);
  });

  it("a missing stateDir is 503 'source missing', with no path in the response", async () => {
    rmSync(stateDir, { recursive: true, force: true });
    for (const action of ["pause", "resume"]) {
      const r = await post(`/api/agents/shop-app-ta/${action}`);
      expect(r.statusCode, action).toBe(503);
      expect(r.json()).toEqual({ error: "source missing" });
      expect(r.body).not.toContain(dir);
    }
    expect(existsSync(stateDir)).toBe(false); // nothing recreated
  });

  it("other fs failures are 503 with fixed text, no path", async () => {
    mkdirSync(join(stateDir, "PAUSE", "inner"), { recursive: true }); // unlink of a directory fails
    const r = await post("/api/agents/shop-app-ta/resume");
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: "could not update pause state" });
    expect(r.body).not.toContain(dir);
  });

  it("an unknown agent is 404", async () => {
    expect((await post("/api/agents/nope/pause")).statusCode).toBe(404);
  });

  it("with noLoopWrites, pause and resume are 409 before touching the state dir", async () => {
    const a = buildApp({ config, store, bus, noLoopWrites: true });
    const send = (action: string) =>
      a.inject({
        method: "POST",
        url: `/api/agents/shop-app-ta/${action}`,
        headers: json,
        payload: {},
      });
    const refused = { error: "loop writes are disabled on this server" };
    const p = await send("pause");
    expect(p.statusCode).toBe(409);
    expect(p.json()).toEqual(refused);
    expect(existsSync(join(stateDir, "PAUSE"))).toBe(false);
    writeFileSync(join(stateDir, "PAUSE"), "");
    const r = await send("resume");
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual(refused);
    expect(existsSync(join(stateDir, "PAUSE"))).toBe(true);
    // No stat either: a missing state dir would otherwise be 503 "source missing".
    rmSync(stateDir, { recursive: true, force: true });
    expect((await send("pause")).statusCode).toBe(409);
    expect(existsSync(stateDir)).toBe(false);
    await a.close();
  });
});

describe("crew and attention", () => {
  it("GET /api/crew lists every loop in config order with firstRunToday", async () => {
    store.upsertRun(run({ id: "a", startedAt: NOW - 30 * 60e3, ticket: "shop-app#7" }));
    const c = (await get("/api/crew")).json() as Crew;
    expect(c.rows.map((r) => [r.id, r.index, r.hudState])).toEqual([
      ["shop-app-ta", 0, "running"],
      ["studio-builder", 1, "idle"],
    ]);
    expect(c.rows[0]?.run?.id).toBe("a");
    expect(c.rows[0]?.ticket).toBe("shop-app#7");
    expect(c.firstRunToday).toBe(NOW - 30 * 60e3);
    expect(c.rows[0]?.prs).toEqual([]);
    expect(c.rows[0]?.summary).toBeNull();
    expect(c.rows[1]).toMatchObject({ ticket: null, prs: [], summary: null });
  });

  const boardItem = (issueNumber: number, title: string): BoardItem => ({
    repoId: "shop-app",
    issueNumber,
    title,
    status: "Todo",
    state: "planned",
    labels: [],
    priority: null,
    updatedAt: 1,
    url: "",
    stage: null,
    owner: null,
    parent: null,
    subIssues: null,
    assignees: [],
    blockedBy: [],
    milestone: null,
    size: null,
    closed: false,
    prioritySource: null,
    createdAt: 1,
    itemId: null,
    projectId: null,
  });
  const seatRun = (over: Partial<Run>) =>
    run({ agentId: "guido-1", startedAt: NOW - 30 * 60e3, ...over });
  const seatRow = async () =>
    ((await get("/api/crew")).json() as Crew).rows.find((r) => r.id === "guido-1");

  // A ticket that is not on the board (or not polled yet) still has the title its run began with.
  it("a crew run's stored ticket title shows on /api/crew and /api/agents/:id/runs, null when none", async () => {
    withCrew();
    store.upsertRun(
      seatRun({
        id: "old",
        startedAt: NOW - 3 * HOUR,
        ticket: "shop-app#5",
        ticketTitle: "Old title",
      }),
    );
    store.upsertRun(seatRun({ id: "a", ticket: "shop-app#7", ticketTitle: "Fence the quotes" }));
    expect(await seatRow()).toMatchObject({
      ticket: "shop-app#7",
      ticketTitle: "Fence the quotes",
    });
    const rows = (await get("/api/agents/guido-1/runs")).json() as RunView[];
    expect(rows.map((r) => [r.id, r.ticketTitle])).toEqual([
      ["a", "Fence the quotes"],
      ["old", "Old title"],
    ]);
    store.upsertRun(seatRun({ id: "b", startedAt: NOW - HOUR, ticket: "shop-app#8" }));
    const again = (await get("/api/agents/guido-1/runs")).json() as RunView[];
    expect(again.find((r) => r.id === "b")?.ticketTitle).toBeNull();
  });

  it("the board's title wins over the run's stored one, and fills in a run with none", async () => {
    withCrew();
    store.replaceBoard("shop-app", [boardItem(7, "Board title"), boardItem(8, "Eight")]);
    store.upsertRun(seatRun({ id: "a", ticket: "shop-app#7", ticketTitle: "Stored title" }));
    store.upsertRun(seatRun({ id: "b", startedAt: NOW - HOUR, ticket: "shop-app#8" }));
    expect((await seatRow())?.ticketTitle).toBe("Board title");
    const rows = (await get("/api/agents/guido-1/runs")).json() as RunView[];
    // The same order as /api/crew: the board's title, else the one the run began with.
    expect(rows.map((r) => [r.id, r.ticketTitle])).toEqual([
      ["a", "Board title"],
      ["b", "Eight"],
    ]);
  });

  it("a stored title is the run's own ticket's: not shown for the ticket taken from a PR", async () => {
    withCrew();
    store.upsertRun(
      seatRun({
        id: "a",
        ticket: null,
        ticketTitle: "Stored title",
        prs: [{ repo: "o/shop-app", number: 7 }],
      }),
    );
    store.upsertPullRequests(
      "shop-app",
      [
        {
          repoId: "shop-app",
          number: 7,
          title: "Fence",
          url: "https://github.com/o/shop-app/pull/7",
          branch: "chore/fence",
          ticket: "shop-app#7",
          state: "open",
          isDraft: false,
          review: null,
          ci: null,
          createdAt: 1,
          updatedAt: 2,
          mergedAt: null,
          headSha: null,
          mergeable: null,
        },
      ],
      0,
    );
    const rows = (await get("/api/agents/guido-1/runs")).json() as RunView[];
    expect(rows[0]).toMatchObject({ ticket: "shop-app#7", ticketTitle: null });
    expect((await seatRow())?.ticketTitle).toBeNull();
  });

  // #26 A3: a run whose only link to a ticket is the PR it opened.
  it("GET /api/crew takes the ticket from the latest run's PR, with its PRs and summary", async () => {
    store.replaceBoard("shop-app", [
      {
        repoId: "shop-app",
        issueNumber: 3349,
        title: "Quote cache",
        status: "Todo",
        state: "planned",
        labels: [],
        priority: null,
        updatedAt: 1,
        url: "",
        stage: null,
        owner: null,
        parent: null,
        subIssues: null,
        assignees: [],
        blockedBy: [],
        milestone: null,
        size: null,
        closed: false,
        prioritySource: null,
        createdAt: 1,
        itemId: null,
        projectId: null,
      },
    ]);
    store.upsertPullRequests(
      "shop-app",
      [
        {
          repoId: "shop-app",
          number: 41,
          title: "Cache quotes",
          url: "https://github.com/o/shop-app/pull/41",
          branch: "chore/cache",
          ticket: "shop-app#3349",
          state: "merged",
          isDraft: false,
          review: null,
          ci: null,
          createdAt: 1,
          updatedAt: 2,
          mergedAt: 3,
          headSha: null,
          mergeable: null,
        },
      ],
      0,
    );
    store.upsertRun(
      run({
        id: "a",
        branch: "chore/cache",
        summary: "Merged PR #41.",
        prs: [{ repo: "o/shop-app", number: 41 }],
      }),
    );
    const row = ((await get("/api/crew")).json() as Crew).rows[0];
    expect(row).toMatchObject({
      ticket: "shop-app#3349",
      ticketTitle: "Quote cache",
      summary: "Merged PR #41.",
      prs: [{ repoId: "shop-app", number: 41, title: "Cache quotes", state: "merged" }],
    });
  });

  it("GET /api/attention lists items with their ack, and never deletes an ack", async () => {
    store.replaceEscalations("shop-app", [escalation({})]);
    store.ack(["esc:gone"], NOW - 30 * DAY);
    store.sweepAcks(new Set(), NOW - 10 * DAY); // absent for 10 days already
    const items = (await get("/api/attention")).json() as AttentionItem[];
    expect(items.map((i) => [i.key, i.kind, i.acked])).toEqual([
      ["esc:shop-app#9", "decision", false],
    ]);
    expect(store.acks().has("esc:gone")).toBe(true);
  });

  it("GET /api/attention includes an item's brief, and no brief field without one", async () => {
    store.replaceEscalations("shop-app", [escalation({})]);
    const first = (await get("/api/attention")).json() as AttentionItem[];
    expect(first[0]).not.toHaveProperty("brief");
    const brief = {
      for: "operator" as const,
      original: "Original question ".repeat(1000),
      assessment: "a".repeat(8000),
      did: [{ action: "d".repeat(8000), refs: ["mc#466"] }],
      ask: "q".repeat(8000),
      context: "Waiting since yesterday.",
      recommendation: "r".repeat(8000),
      options: [
        { label: "A", answer: "a".repeat(8000) },
        { label: "B", answer: "b" },
      ],
      basis: "read the issue",
      at: NOW,
    };
    store.addBrief({ key: "esc:shop-app#9", ...brief });
    bus.emit("attention");
    const items = (await get("/api/attention")).json() as AttentionItem[];
    expect(items[0]?.brief).toEqual(brief);
  });

  it("POST /api/attention/ack acks the keys, emits attention, and the next GET shows them acked", async () => {
    store.replaceEscalations("shop-app", [escalation({})]);
    const events: string[] = [];
    bus.subscribe((t) => events.push(t));
    const r = await postBody("/api/attention/ack", {
      keys: ["esc:shop-app#9", "esc:shop-app#9", "x"],
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ acked: 2 });
    expect(events).toEqual(["attention"]);
    expect(store.acks().get("esc:shop-app#9")).toBe(NOW);
    const items = (await get("/api/attention")).json() as AttentionItem[];
    expect(items[0]?.acked).toBe(true);
  });

  it("POST /api/attention/ack of a crew error acks its row, so it leaves the list", async () => {
    withCrew();
    const id = store.addCrewError({ agentId: "guido-1", runId: "r", text: "broke", at: NOW });
    const key = `crew-error:${id}`;
    expect(((await get("/api/attention")).json() as AttentionItem[]).map((i) => i.key)).toEqual([
      key,
    ]);
    expect((await postBody("/api/attention/ack", { keys: [key, "crew-error:x"] })).json()).toEqual({
      acked: 2,
    });
    expect((await get("/api/attention")).json()).toEqual([]);
  });

  const parked = (key: string, kind: "blocked" | "review" = "blocked") => ({
    key,
    kind,
    runId: "r1",
    seatId: "guido-1",
    repoId: "shop-app",
    text: "shop-app#7 parked",
    at: NOW,
  });

  const seedThread = (over: Partial<NotificationRead> = {}) =>
    store.upsertNotifications(
      [
        {
          id: "101",
          repoId: "shop-app",
          subjectType: "Issue",
          title: "Fix the stop race",
          number: 12,
          reason: "mention",
          url: "https://github.com/o/shop-app/issues/12",
          author: "alice",
          snippet: "can you look?",
          updatedAt: NOW - 60_000,
          lastReadAt: null,
          ...over,
        },
      ],
      false,
      NOW,
    );

  it("POST /api/attention/:key/handled closes the thread locally, emits attention, and calls no GitHub", async () => {
    seedThread();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const key = personKey({ id: "101", updatedAt: NOW - 60_000 });
    const before = (await get("/api/attention")).json() as AttentionItem[];
    expect(before.some((i) => i.key === key)).toBe(true);
    const events: string[] = [];
    bus.subscribe((t) => events.push(t));
    const r = await postBody(`/api/attention/${encodeURIComponent(key)}/handled`, {});
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ handled: key });
    expect(events).toEqual(["attention"]);
    const items = (await get("/api/attention")).json() as AttentionItem[];
    expect(items.find((i) => i.kind === "person")).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POST /api/attention/:key/handled answers 404 for a stale or unknown key", async () => {
    seedThread();
    const events: string[] = [];
    bus.subscribe((t) => events.push(t));
    const stale = personKey({ id: "101", updatedAt: NOW - 120_000 });
    const keys = [
      stale,
      "person:999:1",
      "person:x:1",
      "esc:shop-app#9",
      `person:101:${"9".repeat(30)}`,
    ];
    for (const key of keys) {
      const r = await postBody(`/api/attention/${encodeURIComponent(key)}/handled`, {});
      expect(r.statusCode, key).toBe(404);
      expect(r.json(), key).toEqual({ error: NO_OPEN_THREAD });
    }
    expect(events).toEqual([]);
    const live = encodeURIComponent(personKey({ id: "101", updatedAt: NOW - 60_000 }));
    expect((await postBody(`/api/attention/${live}/handled`, {})).statusCode).toBe(200);
    // already closed
    expect((await postBody(`/api/attention/${live}/handled`, {})).statusCode).toBe(404);
  });

  it("GET /api/notifications lists open threads and the ones handled today", async () => {
    seedThread();
    seedThread({ id: "102", number: 13, title: "Other", updatedAt: NOW - 30_000 });
    store.markNotificationHandled("102", NOW - 30_000, "marked", NOW);
    const v = (await get("/api/notifications")).json() as NotificationsView;
    expect(v.open.map((n) => n.id)).toEqual(["101"]);
    expect(v.open[0]).toMatchObject({
      repoId: "shop-app",
      number: 12,
      author: "alice",
      reason: "mention",
    });
    expect(v.handledToday.map((n) => [n.id, n.how])).toEqual([["102", "marked handled"]]);
  });

  it("POST /api/attention/:key/dismiss dismisses an open parked note, emits attention, and the next GET leaves it out", async () => {
    store.raiseNote(parked("blocked:r1:0"));
    const events: string[] = [];
    bus.subscribe((t) => events.push(t));
    const key = "note:blocked:r1:0";
    const r = await postBody(`/api/attention/${encodeURIComponent(key)}/dismiss`, {});
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ dismissed: key });
    expect(events).toEqual(["attention"]);
    const items = (await get("/api/attention")).json() as AttentionItem[];
    expect(items.find((i) => i.key === key)).toBeUndefined();
  });

  it("POST /api/attention/:key/dismiss dismisses a hard-rule flag", async () => {
    store.raiseNote({ ...parked("flag:r1:hard-rules:abc"), kind: "flag" });
    const key = "note:flag:r1:hard-rules:abc";
    const r = await postBody(`/api/attention/${encodeURIComponent(key)}/dismiss`, {});
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ dismissed: key });
    const items = (await get("/api/attention")).json() as AttentionItem[];
    expect(items.find((i) => i.key === key)).toBeUndefined();
  });

  it("POST /api/attention/:key/dismiss answers 404 for a key that is not an open note and 400 for a body", async () => {
    const events: string[] = [];
    bus.subscribe((t) => events.push(t));
    // a seat's open question (ask:) and a bare note key are not open notes
    for (const key of ["esc:shop-app#9", "ask:1", "note:nope", "blocked:r1:0"]) {
      const r = await postBody(`/api/attention/${encodeURIComponent(key)}/dismiss`, {});
      expect(r.statusCode, key).toBe(404);
      expect(r.json(), key).toEqual({ error: NO_OPEN_NOTE });
    }
    store.raiseNote(parked("blocked:r1:0"));
    const bad = await postBody(
      `/api/attention/${encodeURIComponent("note:blocked:r1:0")}/dismiss`,
      {
        x: 1,
      },
    );
    expect(bad.statusCode).toBe(400);
    expect(events).toEqual([]);
    expect(store.notes().every((n) => n.dismissedAt === null)).toBe(true);
  });

  it("GET /api/crew and /api/attention see the test lock: a waiting seat is waiting, not stalled", async () => {
    withCrew();
    const lock = new TestLock({ now: () => NOW });
    const live = new AbortController().signal;
    await lock.acquire(
      { runId: "other", toolUseId: "t0" },
      "guido-9",
      "pnpm -s test",
      60_000,
      live,
    );
    void lock.acquire({ runId: "c1", toolUseId: "t1" }, "guido-1", "pnpm -s test", 60_000, live);
    store.upsertRun(run({ id: "c1", agentId: "guido-1", startedAt: NOW - 3600e3 }));
    store.setSeatSession({
      seatId: "guido-1",
      runId: "c1",
      cliSessionId: null,
      state: "running",
      reason: null,
      worktree: null,
      updatedAt: NOW - 3600e3,
    });
    // silent for 20 min: without the lock's word it would be a stall item
    store.setDigest("c1", digest({ lastEventAt: NOW - 20 * 60e3 }));
    const a = buildApp({ config, store, bus, now: () => clock, lock });
    await a.ready();
    const row = ((await a.inject({ method: "GET", url: "/api/crew" })).json() as Crew).rows.find(
      (r) => r.id === "guido-1",
    );
    expect(row).toMatchObject({ hudState: "waiting", note: "waiting for the test lock" });
    const items = (
      await a.inject({ method: "GET", url: "/api/attention" })
    ).json() as AttentionItem[];
    expect(items.filter((i) => i.agentId === "guido-1")).toEqual([]);
    lock.releaseRun("c1");
    lock.releaseRun("other");
    await a.close();
  });

  it("POST /api/attention/ack validates the body (400) and acks nothing", async () => {
    const bad: unknown[] = [
      {},
      { keys: [] },
      { keys: Array.from({ length: 51 }, (_, i) => `k${i}`) },
      { keys: ["x".repeat(201)] },
      { keys: [""] },
      { keys: [1] },
      { keys: "esc:a" },
      [],
      null,
    ];
    for (const body of bad) {
      const r = await postBody("/api/attention/ack", body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect(typeof (r.json() as { error: unknown }).error).toBe("string");
    }
    expect(store.acks()).toEqual(new Map());
    const ok = await postBody("/api/attention/ack", {
      keys: [...Array.from({ length: 49 }, (_, i) => `k${i}`), "x".repeat(200)],
    });
    expect(ok.json()).toEqual({ acked: 50 });
  });
});

describe("away settings", () => {
  const away: AwaySettings = {
    on: true,
    until: "2026-10-28",
    may: { pickUp: true, research: false, check: true, status: false, safePr: true },
  };

  it("GET /api/away/digest assembles one item per group without saving a digest", async () => {
    store.replaceEscalations("shop-app", [escalation({})]);
    const pr: PullRequestView = {
      repoId: "shop-app",
      number: 41,
      title: "Safe docs",
      url: "https://github.com/o/shop-app/pull/41",
      branch: "docs/guide",
      ticket: "shop-app#7",
      state: "open",
      isDraft: false,
      review: null,
      ci: "passing",
      createdAt: NOW,
      updatedAt: NOW,
      mergedAt: null,
      headSha: "safe-sha",
      mergeable: null,
    };
    store.upsertRun(
      run({
        id: "safe",
        repoId: "shop-app",
        loop: { ...NEW_LOOP, prNumber: 41, merging: { sha: "safe-sha", done: ["ready"] } },
      }),
    );
    store.upsertPullRequests(
      "shop-app",
      [pr, { ...pr, number: 42, isDraft: true, ticket: "shop-app#8" }],
      NOW,
    );
    store.upsertRun(
      run({
        id: "failed",
        ticket: "shop-app#8",
        loop: {
          ...NEW_LOOP,
          phase: "parked",
          parked: { kind: "stuck", reason: "Verify stopped producing output", ended: false },
        },
      }),
    );
    store.addFlightDecision({
      at: NOW,
      kind: "note",
      seatId: null,
      targetRunId: null,
      ref: null,
      questionId: null,
      about: "shop-app#7",
      decision: "Ready for review",
      basis: "CI and RETRO passed",
    });
    store.addDraft("shop-app#7", "issue", "Review is ready", NOW);
    const result = await get("/api/away/digest");
    expect(result.statusCode).toBe(200);
    const digest = result.json() as AwayDigest;
    expect(digest.active).toBe(false);
    expect(digest.groups.map((g) => [g.kind, g.items.length])).toEqual([
      ["needYouNow", 1],
      ["safePrsReady", 1],
      ["draftsToWalkThrough", 1],
      ["failures", 1],
      ["flightDecisions", 1],
      ["messagesDrafted", 1],
    ]);
    expect(digest.groups[3].items[0]?.reason).toBe("Verify stopped producing output");
    expect((await get("/api/away/digest")).json()).toEqual(digest);
  });

  it("digest accepts a since timestamp and stores away start only on activation", async () => {
    await postBody("/api/settings/away", { ...away, until: "" });
    expect(store.getSetting("awayStartedAt")).toBe(String(NOW));
    expect((await get("/api/away/digest")).json().startedAt).toBe(NOW);
    await postBody("/api/settings/away", { ...away, on: false });
    expect((await get("/api/away/digest")).json().startedAt).toBe(NOW);
    store.addFlightDecision({
      at: NOW - 1,
      kind: "note",
      seatId: null,
      targetRunId: null,
      ref: null,
      questionId: null,
      about: "old",
      decision: "checked",
      basis: "test",
    });
    expect((await get("/api/away/digest")).json().groups[4].items).toEqual([]);
    expect((await get(`/api/away/digest?since=${NOW - 1}`)).json().groups[4].items).toHaveLength(1);
    expect((await get("/api/away/digest?since=nope")).statusCode).toBe(400);
    expect((await get("/api/away/digest?since=-1")).statusCode).toBe(400);
  });

  it("GET answers the defaults when nothing is stored", async () => {
    const r = await get("/api/settings/away");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(DEFAULT_AWAY);
  });

  it("POST saves the full settings, emits settings, and GET returns them", async () => {
    const events: string[] = [];
    bus.subscribe((t) => events.push(t));
    const r = await postBody("/api/settings/away", away);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(away);
    expect(events).toEqual(["settings"]);
    expect((await get("/api/settings/away")).json()).toEqual(away);
    // An empty until means "until you turn it off".
    const off = { ...away, on: false, until: "" };
    expect((await postBody("/api/settings/away", off)).json()).toEqual(off);
    expect((await get("/api/settings/away")).json()).toEqual(off);
  });

  it("POST refuses anything but a full AwaySettings with a real calendar date (400)", async () => {
    const { safePr: _s, ...partialMay } = away.may;
    const bad: unknown[] = [
      { ...away, until: "28 Oct" },
      { ...away, until: "2026-02-31" },
      { ...away, until: "2026-13-01" },
      { ...away, until: "2026-1-05" },
      { ...away, on: "yes" },
      { ...away, may: partialMay },
      { ...away, may: { ...away.may, check: 1 } },
      { on: true, may: away.may },
      {},
    ];
    for (const body of bad) {
      const r = await postBody("/api/settings/away", body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect(typeof (r.json() as { error: unknown }).error).toBe("string");
    }
    expect((await get("/api/settings/away")).json()).toEqual(DEFAULT_AWAY);
    expect(
      (await postBody("/api/settings/away", { ...away, until: "2028-02-29" })).statusCode,
    ).toBe(200);
  });

  it("GET fails closed when the stored value is unreadable", async () => {
    store.setSetting("away", "{not json");
    expect((await get("/api/settings/away")).json()).toEqual({
      on: true,
      until: "",
      may: { pickUp: false, research: false, check: false, status: false, safePr: false },
    });
    store.setSetting("away", JSON.stringify({ on: "x" }));
    expect((await get("/api/settings/away")).json()).toEqual({
      on: true,
      until: "",
      may: { pickUp: false, research: false, check: false, status: false, safePr: false },
    });
  });
});

describe("limits", () => {
  const sample = (over: Partial<UsageSample>): UsageSample => ({
    accountId: "codex-main",
    window: "7d",
    at: NOW,
    pct: 50,
    resetAt: NOW + 2 * DAY,
    source: "app-server",
    ...over,
  });

  it("projected and stopForecast come from projectAtReset/stopForecast over the current window", async () => {
    const resetAt = NOW + 7 * DAY - 5 * HOUR; // the 7d window reset 5h ago
    const current = [
      sample({ at: NOW - 270 * 60e3, pct: 1, resetAt }),
      sample({ at: NOW - 120 * 60e3, pct: 2, resetAt }),
      sample({ at: NOW - 10 * 60e3, pct: 3, resetAt, source: "rollout" }),
    ];
    // The previous window, still inside the 24h pace lookback: it must not drag the projection.
    const older = [
      sample({ at: NOW - 12 * HOUR, pct: 80, resetAt: NOW - 5 * HOUR }),
      sample({ at: NOW - 6 * HOUR, pct: 95, resetAt: NOW - 5 * HOUR }),
    ];
    for (const s of [...older, ...current]) store.addUsage(s);
    const fiveSamples = [
      sample({ window: "5h", at: NOW - 3 * HOUR, pct: 2, resetAt: NOW + HOUR }),
      sample({ window: "5h", at: NOW - 2 * HOUR, pct: 50, resetAt: NOW + HOUR }),
    ];
    for (const s of fiveSamples) store.addUsage(s);

    const rows = (await get("/api/limits")).json() as Record<string, unknown>[];
    const row = rows.find((r) => r.accountId === "codex-main" && r.window === "7d");
    const expected = projectAtReset(current, resetAt) as number;
    expect(expected).toBeGreaterThan(3);
    // What no filter gives: the old window's 95% makes the pace negative, so no growth at all.
    expect(projectAtReset([...older, ...current], resetAt)).toBe(3);
    expect(row).toEqual({
      accountId: "codex-main",
      window: "7d",
      used: 3,
      projected: expected,
      stopForecast: stopForecast(current, 80, resetAt),
      fullAt: stopForecast(current, 100, resetAt),
      resetAt,
      alertAt: 70,
      stopAt: 80,
      stale: false,
      source: "rollout",
      sampledAt: NOW - 10 * 60e3,
    });
    const fiveH = rows.find((r) => r.accountId === "codex-main" && r.window === "5h");
    // A 5h row has no projection or stop forecast, only the time to full at the window's pace.
    expect(fullAt5h(fiveSamples, NOW + HOUR)).not.toBeNull();
    expect(fiveH).toEqual({
      accountId: "codex-main",
      window: "5h",
      used: 50,
      projected: null,
      stopForecast: null,
      fullAt: fullAt5h(fiveSamples, NOW + HOUR),
      paceReady: true,
      resetAt: NOW + HOUR,
      alertAt: 70,
      stopAt: 80,
      stale: true,
      source: "app-server",
      sampledAt: NOW - 2 * HOUR,
    });
    // No samples for claude-main: no rows rather than invented numbers.
    expect(rows.filter((r) => r.accountId === "claude-main")).toEqual([]);
  });

  it("a 5h row's paceReady is false when its samples span under 30 minutes, true from 30", async () => {
    const resetAt = NOW + 2 * HOUR; // the window is 3h old
    const fiveRow = async () =>
      ((await get("/api/limits")).json() as Record<string, unknown>[]).find(
        (r) => r.window === "5h",
      );
    store.addUsage(sample({ window: "5h", at: NOW - 40 * 60e3, pct: 10, resetAt }));
    store.addUsage(sample({ window: "5h", at: NOW - 15 * 60e3, pct: 20, resetAt }));
    expect(await fiveRow()).toMatchObject({ paceReady: false, fullAt: null });
    store.addUsage(sample({ window: "5h", at: NOW - 10 * 60e3, pct: 21, resetAt }));
    expect(await fiveRow()).toMatchObject({ paceReady: true });
  });

  it("a 7d row's fullAt is when a rising pace reaches 100%, before the reset", async () => {
    const resetAt = NOW + 3 * DAY;
    const rising = [
      sample({ at: NOW - 20 * HOUR, pct: 40, resetAt }),
      sample({ at: NOW - 10 * HOUR, pct: 50, resetAt }),
      sample({ at: NOW, pct: 60, resetAt }),
    ];
    for (const s of rising) store.addUsage(s);
    const rows = (await get("/api/limits")).json() as Record<string, unknown>[];
    const row = rows.find((r) => r.window === "7d");
    // 1 point per hour: 100% is 40 h after the last sample.
    expect(row?.fullAt).toBe(NOW + 40 * HOUR);
    expect(row?.fullAt).toBe(stopForecast(rising, 100, resetAt));
    expect(row?.stopForecast).toBe(NOW + 20 * HOUR);
  });

  it("stale is false at exactly 60 minutes and true beyond", async () => {
    store.addUsage(
      sample({ accountId: "claude-main", window: "5h", at: NOW - HOUR, resetAt: NOW + HOUR }),
    );
    store.addUsage(sample({ accountId: "claude-main", at: NOW - HOUR - 1 }));
    const rows = (await get("/api/limits")).json() as Record<string, unknown>[];
    expect(rows.map((r) => [r.accountId, r.window, r.stale])).toEqual([
      ["claude-main", "5h", false],
      ["claude-main", "7d", true],
    ]);
  });

  it("includes the Claude usage retry while its collector is backing off", async () => {
    const nextTryAt = NOW + 2 * HOUR;
    store.addUsage(sample({ accountId: "claude-main", window: "5h", resetAt: NOW + HOUR }));
    store.setSetting(
      USAGE_BACKOFF_SETTING,
      JSON.stringify({ waitMs: 30 * 60e3, notBefore: nextTryAt }),
    );
    const rows = (await get("/api/limits")).json() as Record<string, unknown>[];
    expect(rows.find((r) => r.accountId === "claude-main" && r.window === "5h")?.nextTryAt).toBe(
      NOW + 30 * 60e3,
    );
  });
});

describe("ticket detail", () => {
  const issue = (over: Record<string, unknown> = {}) => ({
    number: 7,
    title: "Quote cache",
    url: "https://github.com/o/shop-app/issues/7",
    state: "OPEN",
    body: "line one\nline two",
    labels: { nodes: [{ name: "bug" }] },
    milestone: { title: "MVP" },
    subIssues: { nodes: [{ number: 8, title: "child", state: "CLOSED" }] },
    closedByPullRequestsReferences: {
      nodes: [
        {
          number: 20,
          title: "fix",
          url: "https://github.com/o/shop-app/pull/20",
          state: "MERGED",
          merged: true,
        },
        {
          number: 21,
          title: "wip",
          url: "https://github.com/o/shop-app/pull/21",
          state: "OPEN",
          merged: false,
        },
        {
          number: 22,
          title: "nope",
          url: "https://github.com/o/shop-app/pull/22",
          state: "CLOSED",
          merged: false,
        },
      ],
    },
    ...over,
  });

  it("returns the issue as a TicketView, asking the repo's own owner and name", async () => {
    issueNode = () => issue();
    const r = await get("/api/boards/shop-app/items/7");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      number: 7,
      title: "Quote cache",
      url: "https://github.com/o/shop-app/issues/7",
      state: "open",
      body: "line one\nline two",
      bodyTruncated: false,
      bodyLength: 17,
      labels: ["bug"],
      milestone: "MVP",
      subIssues: [{ number: 8, title: "child", state: "closed", repoId: null }],
      pullRequests: [
        {
          number: 20,
          title: "fix",
          url: "https://github.com/o/shop-app/pull/20",
          state: "merged",
          repoId: null,
        },
        {
          number: 21,
          title: "wip",
          url: "https://github.com/o/shop-app/pull/21",
          state: "open",
          repoId: null,
        },
        {
          number: 22,
          title: "nope",
          url: "https://github.com/o/shop-app/pull/22",
          state: "closed",
          repoId: null,
        },
      ],
    });
    expect(gqlCalls[0]?.vars).toEqual({ owner: "o", name: "shop-app", number: 7 });
  });

  it("maps a cross-repo sub-issue and PR to their configured repo through config.repos", async () => {
    const at = (owner: string, name: string) => ({ repository: { name, owner: { login: owner } } });
    issueNode = () =>
      issue({
        subIssues: {
          nodes: [
            { number: 8, title: "same", state: "OPEN", ...at("o", "shop-app") },
            { number: 3, title: "cross", state: "OPEN", ...at("o", "ae") },
          ],
        },
        closedByPullRequestsReferences: {
          nodes: [
            { number: 30, title: "p", url: "u", state: "OPEN", merged: false, ...at("o", "ae") },
          ],
        },
      });
    const t = (await get("/api/boards/shop-app/items/7")).json();
    expect(t.subIssues.map((s: { repoId: string | null }) => s.repoId)).toEqual([
      "shop-app",
      "site-builder",
    ]);
    expect(t.pullRequests.map((p: { repoId: string | null }) => p.repoId)).toEqual([
      "site-builder",
    ]);
  });

  it("cuts a body over 20 000 characters and says so", async () => {
    issueNode = () => issue({ body: "x".repeat(25_000) });
    const t = (await get("/api/boards/shop-app/items/7")).json();
    expect(t.body).toHaveLength(20_000);
    expect(t.bodyTruncated).toBe(true);
    expect(t.bodyLength).toBe(25_000);
  });

  it("cuts a body by code point, so an emoji is never split", async () => {
    issueNode = () => issue({ body: `${"x".repeat(19_999)}😀tail` });
    const t = (await get("/api/boards/shop-app/items/7")).json();
    expect(t.body).toBe(`${"x".repeat(19_999)}😀`);
    expect(t.bodyLength).toBe(20_004);
  });

  it("answers 404 for an unknown repo or a bad number without calling GitHub", async () => {
    expect((await get("/api/boards/nope/items/7")).statusCode).toBe(404);
    expect((await get("/api/boards/shop-app/items/abc")).statusCode).toBe(404);
    expect((await get("/api/boards/shop-app/items/0")).statusCode).toBe(404);
    expect((await get("/api/boards/shop-app/items/2147483648")).statusCode).toBe(404);
    expect((await get("/api/boards/shop-app/items/99999999999")).statusCode).toBe(404);
    expect(gqlCalls).toEqual([]);
  });

  it("answers 404 when GitHub has no such issue, as a null or as a NOT_FOUND error", async () => {
    issueNode = () => null;
    expect((await get("/api/boards/shop-app/items/99")).statusCode).toBe(404);
    issueNode = () => {
      throw new Error("github: Could not resolve to an Issue with the number of 99.");
    };
    expect((await get("/api/boards/shop-app/items/99")).statusCode).toBe(404);
  });

  it("answers 502 when GitHub fails", async () => {
    gqlFail = true;
    const r = await get("/api/boards/shop-app/items/7");
    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({ error: "GitHub failed: github: HTTP 502" });
  });
});

describe("boards, escalations, health", () => {
  const item: BoardItem = {
    repoId: "shop-app",
    issueNumber: 7,
    title: "<img src=x onerror=alert(1)>",
    status: "Todo",
    state: "planned",
    labels: ["bug"],
    priority: null,
    updatedAt: NOW,
    url: "https://github.com/o/shop-app/issues/7",
    stage: null,
    owner: null,
    parent: null,
    subIssues: null,
    assignees: [],
    blockedBy: [],
    milestone: null,
    size: null,
    closed: false,
    prioritySource: null,
    createdAt: 1,
    itemId: null,
    projectId: null,
  };

  it("boards/:repoId returns the repo's items, 404 for an unknown repo", async () => {
    store.replaceBoard("shop-app", [item]);
    const r = await get("/api/boards/shop-app");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([item]);
    expect((await get("/api/boards/site-builder")).json()).toEqual([]);
    expect((await get("/api/boards/nope")).statusCode).toBe(404);
  });

  it("serves a fixture repo's map snapshot under 300 KB, excluding observed loops", async () => {
    withCrew();
    const session = config.crew?.sessions[0];
    if (!session) throw new Error("fixture session missing");
    session.checkout = mapCheckout(dir);
    const response = await get("/api/repos/shop-app/map");
    expect(response.statusCode).toBe(200);
    expect(Buffer.byteLength(response.body)).toBeLessThan(300_000);
    expect(response.json()).toMatchObject({
      repoId: "shop-app",
      seq: 0,
      conflicts: [],
      findings: [],
      seats: [{ seat: "guido-1", context: null, scope: { read: [], modified: [] } }],
    });
    expect(response.json().tree).toContainEqual(
      expect.objectContaining({ path: "packages/core/src/map.ts", lines: expect.any(Number) }),
    );
    expect(response.json().imports).toContainEqual({
      from: "packages/core/src/map.ts",
      to: "packages/core/src/types.ts",
    });
    expect((await get("/api/repos/unknown/map")).statusCode).toBe(404);
  });

  for (const vendor of ["claude", "codex"] as const) {
    it(`scopes FLIGHT ${vendor} activity to the current turn and selected repo`, async () => {
      withCrew();
      const session = config.crew?.sessions[0];
      if (!session) throw new Error("fixture session missing");
      session.checkout = mapCheckout(dir);
      session.seats.push({
        id: "flight-1",
        role: "FLIGHT",
        accountId: "claude-main",
        model: "opus",
        area: [],
      });
      const transcriptPath = join(dir, "flight.jsonl");
      const call =
        vendor === "claude"
          ? {
              type: "assistant",
              message: {
                content: [
                  {
                    type: "tool_use",
                    id: "read",
                    name: "Read",
                    input: { file_path: join(session.checkout, "package.json") },
                  },
                ],
              },
            }
          : {
              method: "item/started",
              params: {
                item: {
                  id: "read",
                  type: "commandExecution",
                  command: `cat ${join(session.checkout, "package.json")}`,
                },
              },
            };
      const elsewhere =
        vendor === "claude"
          ? {
              type: "assistant",
              message: {
                content: [
                  {
                    type: "tool_use",
                    id: "outside",
                    name: "Read",
                    input: { file_path: join(dir, "outside.ts") },
                  },
                ],
              },
            }
          : {
              method: "item/started",
              params: {
                item: {
                  id: "outside",
                  type: "commandExecution",
                  command: `cat ${join(dir, "outside.ts")}`,
                },
              },
            };
      writeFileSync(join(dir, "outside.ts"), "outside\n");
      writeFileSync(transcriptPath, `${JSON.stringify(call)}\n${JSON.stringify(elsewhere)}\n`);
      store.upsertRun(run({ id: "flight-turn", agentId: "flight-1", transcriptPath, vendor }));
      store.setSeatSession({
        seatId: "flight-1",
        runId: "flight-turn",
        cliSessionId: null,
        vendor,
        state: "running",
        reason: null,
        worktree: null,
        updatedAt: NOW,
      });
      const response = await get("/api/repos/shop-app/map");
      expect(
        response.json().seats.find((s: { seat: string }) => s.seat === "FLIGHT"),
      ).toMatchObject({
        ticket: null,
        calls: [expect.objectContaining({ files: ["package.json"] })],
      });
      const end = vendor === "claude" ? { type: "result" } : { method: "turn/completed" };
      appendFileSync(transcriptPath, `${JSON.stringify(end)}\n`);
      const ended = await get("/api/repos/shop-app/map");
      expect(ended.json().seats.find((s: { seat: string }) => s.seat === "FLIGHT")).toMatchObject({
        calls: [],
        scope: { read: [], modified: [] },
        recent: [],
      });
    });
  }

  it("keeps aside churn after reassignment and drops it after merge", async () => {
    withCrew();
    const session = config.crew?.sessions[0];
    if (!session) throw new Error("fixture session missing");
    session.checkout = mapCheckout(dir);
    const transcriptPath = join(dir, "aside.jsonl");
    writeFileSync(
      transcriptPath,
      readFileSync(new URL("./fixtures/map/claude.jsonl", import.meta.url)),
    );
    store.upsertRun(
      run({
        id: "aside",
        agentId: "guido-1",
        transcriptPath,
        branch: "aside-branch",
        loop: { ...NEW_LOOP, aside: { worktree: dir, wake: false } },
      }),
    );
    store.upsertRun(run({ id: "next", agentId: "guido-1", startedAt: NOW + 1 }));
    const response = await get("/api/repos/shop-app/map");
    expect(response.json().seats[0].scope.modified).toEqual([
      { file: "file.ts", add: 2, rem: 1, source: "churn" },
    ]);
    expect(response.json().seats[0].scope.read).toEqual([]);
    store.upsertPullRequests(
      "shop-app",
      [
        {
          repoId: "shop-app",
          number: 7,
          title: "Fixture",
          url: "https://example.invalid/pr",
          branch: "aside-branch",
          ticket: null,
          state: "merged",
          isDraft: false,
          review: null,
          ci: "passing",
          createdAt: NOW,
          updatedAt: NOW,
          mergedAt: NOW,
          mergeCommitSha: null,
          headSha: null,
          mergeable: null,
          author: null,
          assignees: [],
          checks: [],
          closingIssues: [],
        },
      ],
      NOW,
    );
    expect((await get("/api/repos/shop-app/map")).json().seats[0].scope.modified).toEqual([]);
  });

  it("uses the loop park reason and its state age for waiting", async () => {
    withCrew();
    const session = config.crew?.sessions[0];
    if (!session) throw new Error("fixture session missing");
    session.checkout = mapCheckout(dir);
    store.upsertRun(
      run({
        id: "parked-loop",
        agentId: "guido-1",
        loop: {
          ...NEW_LOOP,
          phase: "parked",
          parked: { kind: "operator", reason: "Check the plan", ended: false },
        },
      }),
    );
    const response = await get("/api/repos/shop-app/map");
    expect(response.json().seats[0].badges.waiting).toEqual({
      kind: "parked",
      reason: "Check the plan",
      since: response.json().seats[0].since,
    });
  });

  for (const vendor of ["claude", "codex"] as const) {
    it(`assembles ${vendor} map calls, churn, parsed tests and measured context`, async () => {
      withCrew();
      const session = config.crew?.sessions[0];
      if (!session) throw new Error("fixture session missing");
      session.checkout = mapCheckout(dir);
      const transcriptPath = join(dir, "map.jsonl");
      writeFileSync(join(dir, "file.ts"), "before\n");
      const lines = readFileSync(new URL(`./fixtures/map/${vendor}.jsonl`, import.meta.url), "utf8")
        .trim()
        .split("\n");
      writeFileSync(transcriptPath, `${lines.join("\n")}\n`);
      store.upsertRun(
        run({ id: "map-run", agentId: "guido-1", transcriptPath, ticket: "shop-app#7" }),
      );
      store.setSeatSession({
        seatId: "guido-1",
        runId: "map-run",
        cliSessionId: null,
        vendor,
        state: "running",
        reason: null,
        worktree: dir,
        updatedAt: NOW,
      });
      const question = store.addQuestion({
        agentId: "guido-1",
        runId: "map-run",
        text: "Which approach?",
        at: NOW,
      });
      store.addQuestion({
        agentId: "guido-1",
        runId: "previous-run",
        text: "Old question",
        at: NOW - 1,
      });
      for (const round of [1, 2]) {
        const reviewId = store.requestReview({
          authorRunId: "map-run",
          repoId: "shop-app",
          seatId: "retro-1",
          prNumber: 7,
          sha: String(round).repeat(40),
          epoch: 1,
          attempt: round,
          round,
          at: NOW + round,
        });
        if (reviewId === null) throw new Error("fixture review missing");
        store.setReviewState(reviewId, ["queued"], "running", {
          at: NOW + round,
          runId: `review-${round}`,
        });
        store.recordFindings(reviewId, `review-${round}`, {
          verdict: { spec: "pass", quality: "fail" },
          summary: "Check boundary",
          findings: [
            {
              severity: round === 1 ? "Critical" : "Important",
              file: "file.ts",
              line: round,
              summary: "Check input",
              scenario: "Empty input",
              fix: "Handle empty input",
            },
          ],
          at: NOW + round,
        });
      }
      const a = buildApp({ config, store, bus, now: () => clock, supervisor: stubSupervisor() });
      try {
        const response = await a.inject({ method: "GET", url: "/api/repos/shop-app/map" });
        expect(response.statusCode).toBe(200);
        expect(response.json().findings).toEqual([
          expect.objectContaining({
            seat: "guido-1",
            ticket: 7,
            round: 2,
            severity: "Important",
            line: 2,
          }),
        ]);
        expect(response.json().seats[0].badges.questions).toEqual([
          { id: question, from: "guido-1", to: "CAPCOM", ticket: 7, since: NOW },
        ]);
        expect(response.json().seats[0].badges.review).toMatchObject({
          round: 2,
          counts: { Critical: 0, Important: 1, Minor: 0 },
        });
        expect(response.json().seats[0]).toMatchObject({
          seat: "guido-1",
          ticket: 7,
          context: { total: 10, window: 100 },
          scope: { modified: [{ file: "file.ts", add: 2, rem: 1, source: "churn" }] },
          badges: {
            tests: { runner: "vitest", status: "failed", passed: 2, failed: 1, editedSince: false },
            failures: [expect.objectContaining({ refused: true })],
          },
        });
        appendFileSync(transcriptPath, `${(lines[4] as string).replaceAll("denied", "pending")}\n`);
        const active = (await a.inject({ method: "GET", url: "/api/repos/shop-app/map" })).json();
        expect(active.seats[0].calls).toEqual([
          expect.objectContaining({ files: ["file.ts"], since: expect.any(Number) }),
        ]);
        store.setSeatSession({
          seatId: "guido-1",
          runId: "map-run",
          cliSessionId: null,
          vendor,
          state: "parked",
          reason: "Waiting for input",
          worktree: dir,
          updatedAt: NOW,
        });
        clock += 2100;
        const parked = (await a.inject({ method: "GET", url: "/api/repos/shop-app/map" })).json();
        expect(parked.seats[0]).toMatchObject({
          calls: [],
          scope: { read: [], modified: [{ file: "file.ts", add: 2, rem: 1, source: "churn" }] },
          badges: { waiting: { kind: "parked", since: NOW, reason: "Waiting for input" } },
        });
      } finally {
        await a.close();
      }
    });
  }
  it("exposes repo-scoped modified seat entries from the live map ring", async () => {
    const cwd = join(dir, "diff-checkout");
    mkdirSync(cwd);
    const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args]);
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture");
    writeFileSync(join(cwd, "file.ts"), "base\n");
    git("add", ".");
    git("commit", "-qm", "base");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    writeFileSync(join(cwd, "file.ts"), "edited\nextra\n");
    const transcriptPath = join(cwd, "transcript.jsonl");
    writeFileSync(transcriptPath, "");
    const ring = new CallRing(() => [
      { id: "run", seat: "seat", repoId: "shop-app", cwd, transcriptPath },
      { id: "other", seat: "seat", repoId: "site-builder", cwd, transcriptPath },
    ]);
    const a = buildApp({ config, store, bus, mapRing: ring });
    const stop = ring.start();
    try {
      await expect
        .poll(
          async () => {
            const r = await a.inject({ method: "GET", url: "/api/repos/shop-app/map/diff" });
            expect(r.statusCode).toBe(200);
            return r.json();
          },
          { timeout: 4500 },
        )
        .toEqual({
          seats: [
            {
              seat: "seat",
              scope: { modified: [{ file: "file.ts", add: 2, rem: 1, source: "diff" }] },
            },
          ],
        });
      expect((await a.inject({ method: "GET", url: "/api/repos/nope/map/diff" })).statusCode).toBe(
        404,
      );
    } finally {
      stop();
      await a.close();
    }
  });

  it("serves computed map conflicts from stored open PR tips without changing the checkout", async () => {
    withCrew();
    const checkout = join(dir, "clone");
    mkdirSync(checkout, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    writeFileSync(join(checkout, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    git("checkout", "-qb", "left");
    writeFileSync(join(checkout, "file.txt"), "left\n");
    git("commit", "-qam", "left");
    const left = git("rev-parse", "HEAD");
    git("checkout", "-qb", "right", base);
    writeFileSync(join(checkout, "file.txt"), "right\n");
    git("commit", "-qam", "right");
    const right = git("rev-parse", "HEAD");
    git("branch", "-f", "left", base);
    const prs = [left, right].map((headSha, i) => ({
      repoId: "shop-app",
      number: i + 1,
      title: "Fixture",
      url: "https://example.invalid/pr",
      branch: i === 0 ? "left" : "right",
      ticket: null,
      state: "open" as const,
      isDraft: false,
      review: null,
      ci: "pending" as const,
      createdAt: 1,
      updatedAt: 2,
      mergedAt: null,
      mergeCommitSha: null,
      headSha,
      mergeable: null,
      author: null,
      assignees: [],
      checks: [],
      closingIssues: [],
    }));
    store.upsertPullRequests("shop-app", prs, 0);
    const before = git("count-objects", "-v");
    const response = await get("/api/repos/shop-app/map/conflicts");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      conflicts: [{ file: "file.txt", branches: ["right", "left"], shas: [right, left] }],
    });
    expect(git("count-objects", "-v")).toBe(before);
    expect(git("status", "--porcelain")).toBe("");
    expect(readFileSync(join(checkout, "file.txt"), "utf8")).toBe("right\n");
    store.upsertPullRequests(
      "shop-app",
      prs.map((pr) => ({ ...pr, state: "closed" })),
      0,
    );
    expect((await get("/api/repos/shop-app/map/conflicts")).json()).toEqual({ conflicts: [] });
  });

  it("does not report a clean merge when the map checkout is unavailable", async () => {
    expect((await get("/api/repos/nope/map/conflicts")).statusCode).toBe(404);
    expect((await get("/api/repos/shop-app/map/conflicts")).statusCode).toBe(503);
    withCrew();
    expect((await get("/api/repos/shop-app/map/conflicts")).statusCode).toBe(503);
  });

  it("repos/:repoId/prs returns the stored pull requests, 404 for an unknown repo", async () => {
    expect((await get("/api/repos/shop-app/prs")).json()).toEqual([]);
    const pr = {
      repoId: "shop-app",
      number: 4,
      title: "t",
      url: "https://github.com/o/shop-app/pull/4",
      branch: "fix/9-x",
      ticket: "shop-app#9",
      state: "open",
      isDraft: false,
      review: null,
      ci: "pending",
      createdAt: 1,
      updatedAt: 2,
      mergedAt: null,
      mergeCommitSha: null,
      headSha: null,
      mergeable: null,
      author: null,
      assignees: [] as string[],
      checks: [] as PrCheck[],
      closingIssues: [] as number[],
    } as const;
    store.upsertPullRequests("shop-app", [pr], 0);
    const r = await get("/api/repos/shop-app/prs");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([pr]);
    expect((await get("/api/repos/nope/prs")).statusCode).toBe(404);
  });

  // #26 A1: the Board reads only the PRs it can put on a card.
  it("repos/:repoId/prs?linked=1 returns only PRs linked to a ticket", async () => {
    const pr = (number: number, ticket: string | null) => ({
      repoId: "shop-app",
      number,
      title: "t",
      url: `https://github.com/o/shop-app/pull/${number}`,
      branch: "chore/x",
      ticket,
      state: "open" as const,
      isDraft: false,
      review: null,
      ci: null,
      createdAt: 1,
      updatedAt: 2,
      mergedAt: null,
      mergeCommitSha: null,
      headSha: null,
      mergeable: null,
      author: null,
      assignees: [],
      checks: [],
      closingIssues: [] as number[],
    });
    store.upsertPullRequests("shop-app", [pr(4, "shop-app#9"), pr(5, null)], 0);
    expect((await get("/api/repos/shop-app/prs?linked=1")).json()).toEqual([pr(4, "shop-app#9")]);
    expect((await get("/api/repos/shop-app/prs")).json()).toEqual([
      pr(5, null),
      pr(4, "shop-app#9"),
    ]);
    const bad = await get("/api/repos/shop-app/prs?linked=yes");
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "linked must be 1" });
  });

  it("repos returns the configured repos as id, github, project and projectUrl", async () => {
    const r = await get("/api/repos");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([
      { id: "shop-app", github: "o/shop-app", project: 2, projectUrl: null },
      { id: "site-builder", github: "o/ae", project: 3, projectUrl: null },
    ]);
  });

  it("GET /api/repos and /api/repos/profiles carry projectUrl after a board read", async () => {
    const urlsOf = async (path: string) =>
      ((await get(path)).json() as { id: string; projectUrl: string | null }[]).map((r) => [
        r.id,
        r.projectUrl,
      ]);
    expect(await urlsOf("/api/repos")).toEqual([
      ["shop-app", null],
      ["site-builder", null],
    ]);
    const boardGql: Gql = async (query) => {
      if (query.includes("OpenIssues")) {
        return {
          repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
        };
      }
      if (!query.includes("projectV2")) throw new Error("not a board read");
      return {
        repositoryOwner: {
          __typename: "Organization",
          projectV2: {
            id: "PVT_1",
            url: "https://github.com/orgs/o/projects/2",
            items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          },
        },
      };
    };
    await collectGithub(config.repos[0] as CcConfig["repos"][number], store, boardGql, clock);
    const want = [
      ["shop-app", "https://github.com/orgs/o/projects/2"],
      ["site-builder", null],
    ];
    expect(await urlsOf("/api/repos")).toEqual(want);
    expect(await urlsOf("/api/repos/profiles")).toEqual(want);
  });

  it("escalations and health return the store rows", async () => {
    store.replaceEscalations("shop-app", [escalation({})]);
    store.setStatus("github:shop-app", false, "github: HTTP 502");
    expect((await get("/api/escalations")).json()).toEqual([escalation({})]);
    expect((await get("/api/health")).json()).toEqual([
      {
        collector: "github:shop-app",
        ok: false,
        error: "github: HTTP 502",
        at: expect.any(Number),
        lastOkAt: null,
      },
    ]);
  });
});

describe("activity", () => {
  it("takes an exclusive since timestamp and an optional limit", async () => {
    store.upsertRun(run({ startedAt: NOW - 3000, endedAt: NOW - 1000, status: "ok" }));
    const delta = (await get(`/api/activity?since=${NOW - 3000}`)).json() as ActivityEvent[];
    expect(delta.map((r) => r.at)).toEqual([NOW - 1000]);
    expect((await get("/api/activity?limit=1")).json()).toHaveLength(1);
    expect((await get(`/api/activity?since=${NOW}`)).json()).toEqual([]);
    for (const query of ["since=no", "since=-1", "since=1.5", "limit=0", "limit=no"]) {
      expect((await get(`/api/activity?${query}`)).statusCode).toBe(400);
    }
  });

  it("reuses slow responses until a topic changes or ten seconds pass", async () => {
    for (const path of ["/api/telemetry", "/api/attention", "/api/config"]) {
      const spy =
        path === "/api/config" ? vi.spyOn(views, "configView") : vi.spyOn(store, "runsOverlapping");
      await get(path);
      spy.mockClear();
      await get(path);
      expect(spy, path).not.toHaveBeenCalled();
      bus.emit("agents");
      await get(path);
      expect(spy, path).toHaveBeenCalled();
      spy.mockClear();
      clock += 10_000;
      await get(path);
      expect(spy, path).toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it("lists run starts/ends, new escalations and failing collectors from the last 24h, newest first", async () => {
    store.upsertRun(
      run({
        id: "a",
        seq: 7,
        startedAt: NOW - 2 * HOUR,
        endedAt: NOW - HOUR,
        status: "ok",
        ticket: "shop-app#5",
        costUsd: 1.234,
      }),
    );
    store.upsertRun(run({ id: "b", seq: 8, startedAt: NOW - HOUR / 2, status: "running" }));
    // started before the window: only its end is in it
    store.upsertRun(
      run({
        id: "c",
        agentId: "studio-builder",
        repoId: "site-builder",
        seq: 6,
        startedAt: NOW - 25 * HOUR,
        endedAt: NOW - 23 * HOUR,
        status: "failed",
      }),
    );
    store.upsertRun(run({ id: "old", seq: 1, startedAt: NOW - 3 * DAY, endedAt: NOW - 2 * DAY }));
    store.replaceEscalations("shop-app", [
      escalation({ openedAt: NOW - 3 * HOUR }),
      escalation({ id: "shop-app#10", issueNumber: 10, openedAt: NOW - 2 * DAY }),
    ]);
    const statusAt = (at: number, name: string, ok: boolean, error: string | null) => {
      const spy = vi.spyOn(Date, "now").mockReturnValue(at);
      store.setStatus(name, ok, error);
      spy.mockRestore();
    };
    statusAt(NOW - 4 * HOUR, "github:shop-app", false, "github: HTTP 502");
    statusAt(NOW - 5 * HOUR, "sessions", true, null);
    statusAt(NOW - 2 * DAY, "usage:claude-main", false, "stale");

    const r = await get("/api/activity");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([
      {
        at: NOW - HOUR / 2,
        who: "shop-app-ta",
        kind: "run-start",
        text: "started",
        ref: null,
        url: null,
        status: "running",
        prs: [],
        summary: null,
        runId: "b",
      },
      {
        at: NOW - HOUR,
        who: "shop-app-ta",
        kind: "run-end",
        text: "ok · shop-app#5 · ≈$1.23",
        ref: "shop-app#5",
        url: null,
        status: "ok",
        prs: [],
        summary: null,
        runId: "a",
      },
      {
        at: NOW - 2 * HOUR,
        who: "shop-app-ta",
        kind: "run-start",
        text: "started on shop-app#5",
        ref: "shop-app#5",
        url: null,
        status: "ok",
        prs: [],
        summary: null,
        runId: "a",
      },
      {
        at: NOW - 3 * HOUR,
        who: "shop-app",
        kind: "escalation",
        text: "[operator-decision] pick one",
        ref: "shop-app#9",
        url: "https://github.com/o/shop-app/issues/9",
        status: null,
        prs: [],
        summary: null,
      },
      {
        at: NOW - 4 * HOUR,
        who: "github:shop-app",
        kind: "collector",
        text: "failing: github: HTTP 502",
        ref: null,
        url: null,
        status: null,
        prs: [],
        summary: null,
      },
      {
        at: NOW - 23 * HOUR,
        who: "studio-builder",
        kind: "run-end",
        text: "failed",
        ref: null,
        url: null,
        status: "failed",
        prs: [],
        summary: null,
        runId: "c",
      },
    ] satisfies ActivityEvent[]);
  });

  it("keeps the newest ACTIVITY_LIMIT events", async () => {
    const runs = ACTIVITY_LIMIT / 2 + 100; // each run is a start and an end
    for (let i = 0; i < runs; i++) {
      const startedAt = NOW - 20 * HOUR + i * 60e3;
      store.upsertRun(
        run({ id: `r${i}`, seq: i, startedAt, endedAt: startedAt + 60e3, status: "ok" }),
      );
    }
    const events = (await get("/api/activity")).json() as ActivityEvent[];
    expect(events).toHaveLength(ACTIVITY_LIMIT);
    const ats = events.map((e) => e.at);
    expect(ats).toEqual([...ats].sort((a, b) => b - a));
    expect(ats[0]).toBe(NOW - 20 * HOUR + (runs - 1) * 60e3 + 60e3);
  });
});

describe("telemetry", () => {
  it("intersects repo-qualified tickets, agent, account and range and clears scope", async () => {
    for (const [id, ticket, input] of [
      ["a", "shop-app#7", 10],
      ["b", "shop-app#8", 20],
      ["c", "site-builder#7", 40],
    ] as const) {
      store.upsertRun(
        run({
          id,
          ticket,
          tokens: { input, output: 0, cacheRead: 0, cacheCreate: 0 },
          startedAt: NOW - HOUR,
          endedAt: NOW - HOUR / 2,
        }),
      );
    }
    const read = async (q: string) => (await get(`/api/telemetry?${q}`)).json<Telemetry>();
    expect((await read("ticket=shop-app%237")).totals[0]?.input).toBe(10);
    expect((await read("ticket=site-builder%237")).totals[0]?.input).toBe(40);
    expect(
      (await read("ticket=shop-app%237&agent=shop-app-ta&account=claude-main")).tokensByTicket,
    ).toEqual([{ ticket: "shop-app#7", tokens: 10, costUsd: null }]);
    expect((await read("ticket=shop-app%237&account=codex-main")).totals).toEqual([]);
    expect((await read("ticket=&agent=&account=")).totals[0]?.input).toBe(70);
    store.upsertRun(
      run({
        id: "older",
        ticket: "shop-app#7",
        startedAt: NOW - 8 * HOUR,
        endedAt: NOW - 7 * HOUR,
        tokens: { input: 100, output: 0, cacheRead: 0, cacheCreate: 0 },
      }),
    );
    expect((await read("range=6h&ticket=shop-app%237")).totals[0]?.input).toBe(10);
    expect((await read("range=24h&ticket=shop-app%237")).totals[0]?.input).toBe(110);
    for (const q of [
      "ticket=7",
      "ticket=unknown%237",
      "ticket=shop-app%230",
      "ticket=shop-app%231.5",
      "ticket=a&ticket=b",
    ]) {
      expect((await get(`/api/telemetry?${q}`)).statusCode, q).toBe(400);
    }
  });

  it("defaults to 6h, accepts each range and refuses an unknown one with 400", async () => {
    store.upsertRun(
      run({
        id: "a",
        startedAt: NOW - 3 * HOUR,
        endedAt: NOW - 2 * HOUR,
        status: "ok",
        tokens: { input: 600, output: 0, cacheRead: 0, cacheCreate: 0 },
      }),
    );
    const tokensIn = (t: Telemetry) =>
      t.tokensPerMinute.flatMap((s) => s.points).reduce((a, b) => a + b, 0);
    // 3 h back: inside the default 6h range, outside 1h.
    const byDefault = (await get("/api/telemetry")).json() as Telemetry;
    expect(tokensIn(byDefault)).toBeGreaterThan(0);
    expect(byDefault.today.agents).toBe(2);
    const lastHour = (await get("/api/telemetry?range=1h")).json() as Telemetry;
    expect(tokensIn(lastHour)).toBe(0);
    for (const range of ["1h", "6h", "24h", "7d"]) {
      expect((await get(`/api/telemetry?range=${range}`)).statusCode, range).toBe(200);
    }
    for (const bad of ["2h", "", "toString", "__proto__"]) {
      const r = await get(`/api/telemetry?range=${bad}`);
      expect(r.statusCode, bad).toBe(400);
      expect(r.json()).toEqual({ error: "range must be one of 1h, 6h, 24h, 7d" });
    }
    expect((await get("/api/telemetry?range=6h&range=1h")).statusCode).toBe(400);
  });

  it("scopes by a configured agent and account; anything else is a 400", async () => {
    expect((await get("/api/telemetry?agent=shop-app-ta")).json<Telemetry>().today.agents).toBe(1);
    expect((await get("/api/telemetry?account=codex-main")).json<Telemetry>().today.agents).toBe(0);
    expect((await get("/api/telemetry?agent=&account=")).json<Telemetry>().today.agents).toBe(2);
    for (const q of ["agent=nope", "account=nope", "agent=__proto__", "agent=a&agent=b"]) {
      const r = await get(`/api/telemetry?${q}`);
      expect(r.statusCode, q).toBe(400);
      expect(r.json()).toHaveProperty("error");
    }
  });
});

describe("config", () => {
  it("returns the loaded config with defaults filled and never the password hash", async () => {
    config.repos[1] = { ...(config.repos[1] as CcConfig["repos"][number]), needsYouLabels: ["x"] };
    const r = await get("/api/config");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      operator: { id: "operator", timezone: "Europe/London" },
      githubLogin: "octo-op",
      accounts: [
        {
          id: "claude-main",
          vendor: "claude",
          alertAt: 85,
          stopAt: 95,
          binding: "machine",
          canCheck: true,
          signInHint: "Sign in with the Claude CLI on this machine.",
        },
        {
          id: "codex-main",
          vendor: "codex",
          alertAt: 70,
          stopAt: 80,
          binding: "machine",
          canCheck: true,
          signInHint: "Sign in with the Codex CLI on this machine.",
        },
      ],
      repos: [
        {
          id: "shop-app",
          github: "o/shop-app",
          project: 2,
          statusMap: { Todo: "planned" },
          needsYouLabels: null,
          fullSuite: [],
        },
        {
          id: "site-builder",
          github: "o/ae",
          project: 3,
          statusMap: { Done: "done" },
          needsYouLabels: ["x"],
          fullSuite: [],
        },
      ],
      loops: [
        {
          id: "shop-app-ta",
          repoId: "shop-app",
          kind: "ta-loop",
          accountId: "claude-main",
          stateDir,
          logsDir: null,
          worktree: join(dir, "wt-ta"),
          launchdLabel: "com.shop-app.ta-loop",
        },
        {
          id: "studio-builder",
          repoId: "site-builder",
          kind: "studio-loop",
          accountId: "claude-main",
          stateDir: join(dir, "studio"),
          logsDir: join(dir, "studio-logs"),
          worktree: join(dir, "wt-studio"),
          launchdLabel: "com.site-builder.studio-build-driver",
        },
      ],
      poll: { usageMinutes: 30, githubSeconds: 60 },
      crew: null,
    } satisfies ConfigView);
    expect(r.body.toLowerCase()).not.toContain("password");
  });

  it("reads the GitHub login once, and answers null when it cannot be read", async () => {
    let reads = 0;
    const a = buildApp({
      config,
      store,
      bus,
      githubGql: async () => async () => {
        reads++;
        return { viewer: { login: "octo-op" } };
      },
    });
    for (let i = 0; i < 3; i++) {
      const r = await a.inject({ method: "GET", url: "/api/config" });
      expect(r.json().githubLogin).toBe("octo-op");
    }
    expect(reads).toBe(1);
    await a.close();

    const b = buildApp({
      config,
      store,
      bus,
      githubGql: async () => {
        throw new Error("gh: could not read a GitHub token (run `gh auth login`)");
      },
    });
    const r = await b.inject({ method: "GET", url: "/api/config" });
    expect(r.statusCode).toBe(200);
    expect(r.json().githubLogin).toBeNull();
    await b.close();
  });

  it("does not retry a failed GitHub login read until the back-off has passed", async () => {
    let calls = 0;
    let t = 1_000_000;
    const a = buildApp({
      config,
      store,
      bus,
      now: () => t,
      githubGql: async () => {
        calls++;
        throw new Error("gh: GitHub unreachable");
      },
    });
    const get = () => a.inject({ method: "GET", url: "/api/config" });
    expect((await get()).json().githubLogin).toBeNull();
    expect((await get()).json().githubLogin).toBeNull();
    expect(calls).toBe(1);
    t += 5 * 60_000 + 1;
    await get();
    expect(calls).toBe(2);
    await a.close();
  });

  it("carries the template profiles: built-in without a file, the error when it cannot load", async () => {
    const profilesPath = join(dir, "profiles.yaml");
    const a = buildApp({ config, store, bus, profilesPath });
    const view = async () => (await a.inject({ method: "GET", url: "/api/config" })).json();
    const feature = DEFAULT_PROFILES.find((p) => p.name === "feature");
    const builtIn = (await view()).profiles;
    expect(builtIn.source).toBe("built-in");
    expect(builtIn.error).toBeNull();
    expect(builtIn.list.map((p: { name: string }) => p.name)).toEqual(
      DEFAULT_PROFILES.map((p) => p.name),
    );
    expect(builtIn.list[0]).toEqual({
      name: "feature",
      labels: ["type:feature"],
      steps: feature?.steps.map((step) => ({ ...step, agents: [] })),
      nodes: feature?.nodes,
      trigger: feature?.trigger,
      budget: feature?.budget,
      orchestrationOnly: false,
      planRequired: true,
      reviewer: { role: "RETRO", depth: "full" },
      tries: 3,
      rounds: 3,
    });
    writeFileSync(profilesPath, "profiles: [");
    const bad = (await view()).profiles;
    expect(bad.source).toBe(profilesPath);
    expect(bad.error).not.toBe("");
    expect(bad.error).not.toBeNull();
    expect(bad.list).toEqual([]);
    await a.close();
  });

  it("marks a retiring seat", async () => {
    withCrew();
    const seat = config.crew?.sessions[0]?.seats[0];
    if (seat) seat.retiring = true;
    const r = await get("/api/config");
    expect(r.json().crew.sessions[0].seats[0].retiring).toBe(true);
  });
});

describe("reload", () => {
  const changes: CrewChanges = {
    sessions: [{ id: "s1", seats: [] }],
    pending: [],
    restartNeeded: ["loops"],
    error: null,
    checkedAt: NOW,
  };
  const withReloader = (result: Partial<ReloadResult>) => {
    const reload = vi.fn(
      async (): Promise<ReloadResult> => ({ ...changes, applied: [], ...result }),
    );
    const reloader: CrewReloader = {
      start: () => {},
      stop: () => {},
      reload,
      settle: () => [],
      status: () => changes,
    };
    return { reload, reloader, a: buildApp({ config, store, bus, crewReloader: reloader }) };
  };
  const reloadPost = (a: FastifyInstance) =>
    a.inject({ method: "POST", url: "/api/config/reload", headers: json, payload: {} });

  it("is 409 without a reloader", async () => {
    const r = await reloadPost(buildApp({ config, store, bus }));
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: CONFIG_WRITES_UNAVAILABLE });
  });

  it("is 400 with the error when the file does not load", async () => {
    const { a } = withReloader({ error: "crew.sessions[0]: boom" });
    const r = await reloadPost(a);
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: "crew.sessions[0]: boom" });
    await a.close();
  });

  it("is 200 with what was applied", async () => {
    const { a, reload } = withReloader({ applied: ["seat guido-2 added"] });
    const r = await reloadPost(a);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ...changes, applied: ["seat guido-2 added"] });
    expect(reload).toHaveBeenCalledTimes(1);
    await a.close();
  });

  it("refuses a foreign origin and a non-JSON body", async () => {
    const { a } = withReloader({});
    const origin = await a.inject({
      method: "POST",
      url: "/api/config/reload",
      headers: { ...json, origin: "https://evil.example" },
      payload: {},
    });
    expect(origin.statusCode).toBe(403);
    const text = await a.inject({
      method: "POST",
      url: "/api/config/reload",
      headers: { "content-type": "text/plain" },
      payload: "x",
    });
    expect(text.statusCode).toBe(415);
    await a.close();
  });
});

describe("set a session's seats (POST /api/crew/sessions/:sessionId/seats)", () => {
  const URL = "/api/crew/sessions/mission-control/seats";
  const seats = () => loadConfig(configPath).crew?.sessions[0]?.seats.map(seatInput) ?? [];
  const reloading = (over: Partial<Parameters<typeof buildApp>[0]> = {}) => {
    const reload = vi.fn(async () => ({ ...NO_CHANGES, applied: ["seat x added"] }));
    const reloader: CrewReloader = { ...stubReloader(), reload };
    const a = buildApp({
      config,
      store,
      bus,
      now: () => clock,
      configPath,
      crewReloader: reloader,
      seatWrites: true,
      ...over,
    });
    return { a, reload };
  };
  const send = (a: FastifyInstance, body: unknown, url = URL) =>
    a.inject({ method: "POST", url, headers: json, payload: JSON.stringify(body) });

  it("needs a writable config", async () => {
    const body = { base: seats(), seats: seats() };
    for (const over of [
      { seatWrites: undefined },
      { configPath: undefined },
      { crewReloader: undefined },
    ]) {
      const { a } = reloading(over);
      const r = await send(a, body);
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error: CONFIG_WRITES_UNAVAILABLE });
      await a.close();
    }
    expect(readFileSync(configPath, "utf8")).toBe(exampleText());
  });

  it("validates the body", async () => {
    const { a, reload } = reloading();
    const s = seats();
    const dup = await send(a, { base: s, seats: [...s, s[0]] });
    expect(dup.statusCode).toBe(400);
    expect(dup.json()).toEqual({ error: "seats: seat ids must be unique" });
    const far = await send(a, { base: s, seats: [{ ...s[0], area: ["../x"] }] });
    expect(far.statusCode).toBe(400);
    const extra = await send(a, { base: s, seats: s, x: 1 });
    expect(extra.statusCode).toBe(400);
    expect(reload).not.toHaveBeenCalled();
    expect(readFileSync(configPath, "utf8")).toBe(exampleText());
    await a.close();
  });

  it("saves a display call sign through the guarded seat editor", async () => {
    const { a, reload } = reloading();
    const base = seats();
    const renamed = base.map((s) =>
      s.id === "guido-1" ? { ...s, displayCallSign: "Orbit One" } : s,
    );
    expect((await send(a, { base, seats: renamed })).statusCode).toBe(200);
    expect(seats()).toEqual(renamed);
    expect(reload).toHaveBeenCalledTimes(1);
    const saved = readFileSync(configPath, "utf8");
    expect((await send(a, { base, seats: base })).statusCode).toBe(409);
    for (const displayCallSign of ["", "  ", "x".repeat(65), "INCO-1"]) {
      const invalid = renamed.map((s) => (s.id === "guido-1" ? { ...s, displayCallSign } : s));
      expect((await send(a, { base: renamed, seats: invalid })).statusCode).toBe(400);
      expect(readFileSync(configPath, "utf8")).toBe(saved);
    }
    expect(reload).toHaveBeenCalledTimes(1);
    await a.close();
  });

  it("writes, then reloads once", async () => {
    const { a, reload } = reloading();
    const base = seats();
    const r = await send(a, { base, seats: base.filter((s) => s.id !== "retro-1") });
    expect(r.statusCode).toBe(200);
    const out = r.json<{ backup: string; changes: unknown }>();
    expect(out.backup).toMatch(/^config\.yaml\.bak-/);
    expect(out.changes).toMatchObject({ applied: ["seat x added"] });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(seats().map((s) => s.id)).toEqual(["guido-1", "inco-1"]);
    await a.close();
  });

  it("maps errors to statuses with their text", async () => {
    const { a, reload } = reloading();
    const base = seats();
    const missing = await send(a, { base: [], seats: [] }, "/api/crew/sessions/nope/seats");
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: noSessionText("nope") });
    const conflict = await send(a, { base: [], seats: [] });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: SEATS_CHANGED });
    const clash = { ...base[1], id: "inco-3", area: ["apps/web/src/**"] };
    const invalid = await send(a, { base, seats: [...base, clash] });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ error: string }>().error).toContain("overlap");
    expect(reload).not.toHaveBeenCalled();
    expect(readFileSync(configPath, "utf8")).toBe(exampleText());
    await a.close();
  });

  it("refuses cross-site writes", async () => {
    const { a } = reloading();
    const body = { base: seats(), seats: [] };
    const text = await a.inject({
      method: "POST",
      url: URL,
      headers: { "content-type": "text/plain" },
      payload: JSON.stringify(body),
    });
    expect(text.statusCode).toBe(415);
    const origin = await a.inject({
      method: "POST",
      url: URL,
      headers: { ...json, origin: "https://evil.example" },
      payload: JSON.stringify(body),
    });
    expect(origin.statusCode).toBe(403);
    expect(readFileSync(configPath, "utf8")).toBe(exampleText());
    await a.close();
  });
});

describe("crew changes", () => {
  it("is the empty shape without a reloader", async () => {
    const r = await get("/api/crew/changes");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      sessions: [],
      pending: [],
      restartNeeded: [],
      error: null,
      checkedAt: null,
    });
  });

  it("is the reloader's status", async () => {
    const status: CrewChanges = {
      sessions: [{ id: "s1", seats: [] }],
      pending: [{ sessionId: "s1", seatId: "guido-2", change: "add", reason: "r" }],
      restartNeeded: [],
      error: "boom",
      checkedAt: NOW,
    };
    const a = buildApp({
      config,
      store,
      bus,
      crewReloader: {
        start: () => {},
        stop: () => {},
        reload: async () => ({ ...status, applied: [] }),
        settle: () => [],
        status: () => status,
      },
    });
    expect((await a.inject({ method: "GET", url: "/api/crew/changes" })).json()).toEqual(status);
    await a.close();
  });
});

describe("SSE stream", () => {
  // In-process: app.inject() with payloadAsStream, so no port is bound.
  async function open(url = "/api/stream") {
    const res = await app.inject({ method: "GET", url, payloadAsStream: true });
    const stream = res.stream();
    const chunks = stream[Symbol.asyncIterator]();
    let text = "";
    const until = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await chunks.next();
        if (done) throw new Error(`stream ended before ${needle}`);
        text += String(value);
      }
    };
    return { res, until, text: () => text };
  }

  it.each(["claude", "codex"] as const)(
    "%s: sends ordered map calls only to the selected repo and keeps changed pings",
    async (vendor) => {
      withCrew();
      const transcriptPath = join(dir, "map.jsonl");
      writeFileSync(transcriptPath, "");
      store.upsertRun(run({ id: "map-run", agentId: "guido-1", vendor, transcriptPath }));
      store.setSeatSession({
        seatId: "guido-1",
        runId: "map-run",
        cliSessionId: null,
        state: "running",
        reason: null,
        worktree: dir,
        updatedAt: NOW,
      });
      const selected = await open("/api/stream?map=shop-app");
      const other = await open("/api/stream?map=site-builder");
      const plain = await open();
      await Promise.all([
        selected.until(": connected"),
        other.until(": connected"),
        plain.until(": connected"),
      ]);
      const otherWrite = vi.spyOn(other.res.raw.res, "write");
      const plainWrite = vi.spyOn(plain.res.raw.res, "write");
      const frames = readFileSync(
        resolve(import.meta.dirname, `fixtures/map/${vendor}.jsonl`),
        "utf8",
      )
        .trim()
        .split("\n");
      appendFileSync(transcriptPath, `${frames[0]}\n${frames[1]}\n`);
      bus.emit("boards");
      await selected.until('"type":"call.end"');
      const deltas = selected
        .text()
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)))
        .filter((d) => d.seq !== undefined);
      expect(deltas.map((d) => [d.seq, d.type])).toEqual([
        [1, "call.start"],
        [2, "edit"],
        [3, "call.end"],
      ]);
      expect(deltas[0]).toMatchObject({
        seat: "guido-1",
        tool: "Edit",
        files: ["file.ts"],
        writeTok: 3,
      });
      expect(deltas[2]).toMatchObject({
        seat: "guido-1",
        files: ["file.ts"],
        error: false,
        refused: false,
      });
      for (const writes of [otherWrite, plainWrite]) {
        expect(writes.mock.calls.some(([chunk]) => String(chunk).includes("event: map"))).toBe(
          false,
        );
        expect(
          writes.mock.calls.some(([chunk]) => String(chunk).includes('"topic":"boards"')),
        ).toBe(true);
      }
      for (const client of [selected, other, plain]) client.res.raw.res.emit("close");
    },
  );

  it.each(["cleared", "reassigned"] as const)(
    "finishes the previous run's calls after its seat is %s",
    async (transition) => {
      withCrew();
      const transcriptPath = join(dir, "previous-map.jsonl");
      const frames = readFileSync(resolve(import.meta.dirname, "fixtures/map/claude.jsonl"), "utf8")
        .trim()
        .split("\n");
      writeFileSync(transcriptPath, `${frames[0]}\n`);
      store.upsertRun(run({ id: "previous-map", agentId: "guido-1", transcriptPath }));
      const session = {
        seatId: "guido-1",
        runId: "previous-map",
        cliSessionId: null,
        state: "running" as const,
        reason: null,
        worktree: dir,
        updatedAt: NOW,
      };
      store.setSeatSession(session);
      const client = await open("/api/stream?map=shop-app");
      await client.until('"type":"call.start"');
      store.setSeatSession({
        ...session,
        runId: transition === "cleared" ? null : "next-map",
        worktree: null,
      });
      appendFileSync(transcriptPath, `${frames[1]}\n`);
      const write = vi.spyOn(client.res.raw.res, "write");
      try {
        await vi.waitFor(
          () => {
            expect(
              write.mock.calls.some(([chunk]) => String(chunk).includes('"type":"call.end"')),
            ).toBe(true);
          },
          { timeout: 2000 },
        );
      } finally {
        client.res.raw.res.emit("close");
      }
    },
  );

  it("emits event: changed with the topic, sends heartbeats, and cleans up on close", async () => {
    const s = await open();
    expect(s.res.statusCode).toBe(200);
    expect(s.res.headers["content-type"]).toContain("text/event-stream");
    expect(s.res.headers["cache-control"]).toContain("no-cache");
    await s.until(": connected");
    expect(bus.size).toBe(2); // notification transitions and the SSE client
    bus.emit("boards");
    await s.until('event: changed\ndata: {"topic":"boards"}\n\n');
    bus.emit("limits");
    await s.until('data: {"topic":"limits"}');
    await s.until(": heartbeat");
    // stands in for Node's `close` on a client disconnect
    s.res.raw.res.emit("close");
    expect(bus.size).toBe(1); // the notification subscriber lives until app.close()
    await app.close();
    expect(bus.size).toBe(0);
  });

  it("batches machine pushes to one event per ten seconds and cancels on close", async () => {
    const s = await open();
    await s.until(": connected");
    const write = vi.spyOn(s.res.raw.res, "write");
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 30; i++) bus.emit("machine");
      expect(
        write.mock.calls.filter(([chunk]) => String(chunk).includes('"machine"')),
      ).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(
        write.mock.calls.filter(([chunk]) => String(chunk).includes('"machine"')),
      ).toHaveLength(1);
      bus.emit("machine");
      bus.emit("boards");
      expect(write.mock.calls.some(([chunk]) => String(chunk).includes('"boards"'))).toBe(true);
      s.res.raw.res.emit("close");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(
        write.mock.calls.filter(([chunk]) => String(chunk).includes('"machine"')),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("app.close() ends open streams", async () => {
    const s = await open();
    await s.until(": connected");
    await app.close();
    expect(bus.size).toBe(0);
    await expect(s.until("\u0000never")).rejects.toThrow("stream ended");
  });
});

describe("crew routes", () => {
  beforeEach(withCrew);
  const post5 = (action: string, body: unknown = {}) =>
    postBody(`/api/seats/guido-1/${action}`, body);

  it("identifies an operator start while away", async () => {
    store.setSetting("away", JSON.stringify({ ...DEFAULT_AWAY, on: true }));
    expect((await post5("start", { issue: 5 })).statusCode).toBe(200);
    expect(supervisorCalls).toEqual([["start", "guido-1", 5, { operator: true }]]);
  });

  it("transfers one seat explicitly and returns the supervisor outcome", async () => {
    const r = await post5("transfer", { accountId: "destination" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ outcome: "resumed" });
    expect(supervisorCalls).toEqual([["transfer", "guido-1", "destination"]]);
    expect(
      (await post5("transfer", { accountId: "destination", credential: "fictional" })).statusCode,
    ).toBe(400);
  });

  it("start answers { runId, branch } and emits agents", async () => {
    const seen: string[] = [];
    bus.subscribe((t) => seen.push(t));
    const r = await post5("start", { issue: 5 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ runId: "r-1", branch: "feature/5-x" });
    expect(supervisorCalls).toEqual([["start", "guido-1", 5, { operator: true }]]);
    expect(seen).toContain("agents");
  });

  describe("start with the engine", () => {
    const startVia = async (engineOn: boolean | null, seatId: string) => {
      const a = buildApp({
        config,
        store,
        bus,
        supervisor: stubSupervisor(),
        ...(engineOn === null
          ? {}
          : {
              engine: {
                onOperatorMessage: async () => false,
                status: () => ({ on: engineOn, note: null }),
              },
            }),
      });
      const r = await a.inject({
        method: "POST",
        url: `/api/seats/${seatId}/start`,
        headers: json,
        payload: { issue: 5 },
      });
      await a.close();
      return r;
    };
    const withReader = () => {
      config.crew?.sessions[0]?.seats.push({
        id: "retro",
        role: "RETRO",
        accountId: "claude-main",
        model: "sonnet",
        area: [],
      });
    };

    it("starts a writer seat's run looped when the engine is on, in a draft repo too", async () => {
      expect(config.repos[0]?.autonomy).toBe("draft");
      expect((await startVia(true, "guido-1")).statusCode).toBe(200);
      expect(supervisorCalls).toEqual([
        ["start", "guido-1", 5, { loop: NEW_LOOP, operator: true }],
      ]);
    });

    it("starts a writer seat's run looped in a merge repo too", async () => {
      const repo = config.repos[0];
      if (repo === undefined) throw new Error("no repo");
      repo.autonomy = "merge";
      expect((await startVia(true, "guido-1")).statusCode).toBe(200);
      expect(supervisorCalls).toEqual([
        ["start", "guido-1", 5, { loop: NEW_LOOP, operator: true }],
      ]);
    });

    it("starts it with no loop when the engine is off or absent", async () => {
      await startVia(false, "guido-1");
      await startVia(null, "guido-1");
      expect(supervisorCalls).toEqual([
        ["start", "guido-1", 5, { operator: true }],
        ["start", "guido-1", 5, { operator: true }],
      ]);
    });

    it("never loops a read-only seat's run", async () => {
      withReader();
      await startVia(true, "retro");
      expect(supervisorCalls).toEqual([["start", "retro", 5, { operator: true }]]);
    });
  });

  it("message, interrupt and end answer 200 { ok: true } and emit agents", async () => {
    const seen: string[] = [];
    bus.subscribe((t) => seen.push(t));
    const m = await post5("message", { text: "hi" });
    const mi = await post5("message", { text: "now", interrupt: true });
    const i = await post5("interrupt");
    const e = await post5("end");
    for (const r of [m, mi, i, e]) {
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ ok: true });
    }
    expect(supervisorCalls).toEqual([
      ["message", "guido-1", "hi", { interrupt: false }],
      ["message", "guido-1", "now", { interrupt: true }],
      ["interrupt", "guido-1"],
      ["end", "guido-1", { hold: undefined }],
    ]);
    expect(seen.filter((t) => t === "agents")).toHaveLength(4);
  });

  it("ends a set-aside run by id, and refuses an unknown run, a bad body and a supervisor refusal", async () => {
    store.upsertRun(run({ id: "r-aside", agentId: "guido-1" }));
    const seen: string[] = [];
    bus.subscribe((t) => seen.push(t));
    const ok = await postBody("/api/runs/r-aside/end", {});
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect(supervisorCalls).toEqual([["endAside", "r-aside"]]);
    expect(seen).toContain("agents");
    const unknown = await postBody("/api/runs/nope/end", {});
    expect(unknown.statusCode).toBe(404);
    const bad = await postBody("/api/runs/r-aside/end", { extra: 1 });
    expect(bad.statusCode).toBe(400);
    expect(supervisorCalls).toHaveLength(1);
    supervisorFail = new SupervisorError(409, "the run is not waiting");
    const refused = await postBody("/api/runs/r-aside/end", {});
    expect([refused.statusCode, refused.json()]).toEqual([
      409,
      { error: "the run is not waiting" },
    ]);
  });

  it("refuses bad bodies with 400 and calls nothing", async () => {
    const bad: [string, unknown][] = [
      ["start", { issue: 0 }],
      ["start", { issue: 1.5 }],
      ["start", { issue: 2 ** 31 }],
      ["start", { issue: "5" }],
      ["start", {}],
      ["start", { issue: 5, extra: 1 }],
      ["message", { text: "" }],
      ["message", { text: "   " }],
      ["message", { text: "\n\t" }],
      ["message", { text: "hi", extra: 1 }],
      ["message", { text: "hi", interrupt: "yes" }],
      ["interrupt", { extra: 1 }],
      ["end", { extra: 1 }],
      ["end", { hold: "yes" }],
      ["end", { hold: true, extra: 1 }],
    ];
    for (const [action, body] of bad) {
      const r = await post5(action, body);
      expect(r.statusCode, `${action} ${JSON.stringify(body).slice(0, 40)}`).toBe(400);
      expect(r.json<{ error: string }>().error).toEqual(expect.any(String));
    }
    expect(supervisorCalls).toEqual([]);
  });

  it("ends only the exact blocked run named by a watch action", async () => {
    const session = config.crew?.sessions[0];
    if (!session) throw new Error("Missing crew fixture");
    session.seats.push({
      id: "flight-1",
      role: "FLIGHT",
      accountId: "claude-main",
      model: "opus",
      area: [],
    });
    const since = NOW - 20 * 60_000;
    const lock = new TestLock({ now: () => since });
    const key = { runId: "preview-run", toolUseId: "preview-suite" };
    await lock.acquire(key, "guido-1", "pnpm test", 60_000, new AbortController().signal);
    const waiting = lock.acquire(
      { runId: "waiting-preview", toolUseId: "waiting-suite" },
      "inco-1",
      "pnpm test",
      60_000,
      new AbortController().signal,
    );
    store.upsertRun(run({ id: key.runId, agentId: "guido-1", startedAt: since }));
    store.setSeatSession({
      seatId: "guido-1",
      runId: key.runId,
      cliSessionId: null,
      state: "running",
      reason: null,
      worktree: null,
      updatedAt: since,
    });
    store.addLockHold({ ...key, seatId: "guido-1", command: "pnpm test", since });
    store.setFlightWatch(
      session.id,
      {
        upsert: [
          {
            id: "stop-preview",
            state: "warn",
            title: "Preview suite is blocking",
            detail: "A suite is waiting",
            catchUp: { kind: "old", line: "Holder is silent" },
            next: "Stop the run",
            action: { kind: "lock-hold", ...key, since },
          },
        ],
      },
      NOW,
    );
    const preview = buildApp({
      config,
      store,
      bus,
      lock,
      supervisor: stubSupervisor(),
      now: () => NOW,
    });
    try {
      const stop = (expectedSince: number) =>
        preview.inject({
          method: "POST",
          url: "/api/seats/guido-1/end",
          payload: { watch: { id: "stop-preview", ...key, since: expectedSince } },
        });
      expect((await stop(since + 1)).statusCode).toBe(409);
      expect(supervisorCalls).toEqual([]);
      expect((await stop(since)).statusCode).toBe(200);
      expect(supervisorCalls).toEqual([["end", "guido-1", { hold: undefined }]]);
      lock.releaseRun(key.runId);
      expect((await stop(since)).statusCode).toBe(409);
      expect(supervisorCalls).toHaveLength(1);
    } finally {
      lock.releaseRun(key.runId);
      lock.releaseRun("waiting-preview");
      await waiting;
      await preview.close();
    }
  });

  it("refuses a stale watch stop target before ending any run", async () => {
    const response = await post5("end", {
      watch: { id: "stop-preview", runId: "preview-run", toolUseId: "preview-suite", since: NOW },
    });
    expect(response.statusCode).toBe(409);
    expect(supervisorCalls).toEqual([]);
  });

  it("ends a run without a hold by default, and with one when asked", async () => {
    expect((await post5("end", {})).statusCode).toBe(200);
    expect((await post5("end", { hold: true })).statusCode).toBe(200);
    expect(supervisorCalls).toEqual([
      ["end", "guido-1", { hold: undefined }],
      ["end", "guido-1", { hold: true }],
    ]);
  });

  it("names the blank-text refusal", async () => {
    const r = await post5("message", { text: "   " });
    expect(r.statusCode).toBe(400);
    expect(r.json<{ error: string }>().error).toBe("text: must not be blank");
  });

  it.each(["x", "\u0001"])("delivers and stores a message at the cap whole (%j)", async (char) => {
    const text = char.repeat(COMMS_MESSAGE_MAX);
    const r = await post5("message", { text });
    expect(r.statusCode).toBe(200);
    expect(supervisorCalls).toEqual([["message", "guido-1", text, { interrupt: false }]]);
    expect(store.comms(0).map((m) => m.text)).toEqual([text]);
  });

  it.each([
    [COMMS_MESSAGE_MAX + 1, 400],
    [COMMS_MESSAGE_BODY_LIMIT + 1, 413],
  ])("rejects %i characters with %i before delivery or storage", async (length, status) => {
    const r = await post5("message", { text: "x".repeat(length) });
    expect(r.statusCode).toBe(status);
    expect(supervisorCalls).toEqual([]);
    expect(store.comms(0)).toEqual([]);
  });

  it("passes message text on as typed, indentation included", async () => {
    expect((await post5("message", { text: "  - item\n" })).statusCode).toBe(200);
    expect(supervisorCalls).toEqual([["message", "guido-1", "  - item\n", { interrupt: false }]]);
  });

  describe("the watch seat", () => {
    beforeEach(() => {
      config.crew?.sessions[0]?.seats.push({
        id: "flight-1",
        role: "FLIGHT",
        accountId: "claude-main",
        model: "opus",
        area: [],
      });
    });

    it("starts with {} through startWatch", async () => {
      const r = await postBody("/api/seats/flight-1/start", {});
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ runId: "r-3" });
      expect(supervisorCalls).toEqual([["startWatch", "flight-1"]]);
    });

    it("refuses an issue with 400", async () => {
      const r = await postBody("/api/seats/flight-1/start", { issue: 5 });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual({
        error: "FLIGHT-1 runs the crew and is started without a ticket.",
      });
      expect(supervisorCalls).toEqual([]);
    });

    it("a dev seat with {} is refused with ISSUE_REQUIRED", async () => {
      const r = await post5("start", {});
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual({ error: "issue: an issue number is required" });
      expect(supervisorCalls).toEqual([]);
    });
  });

  it("returns an empty schedule without FLIGHT", async () => {
    const res = await get("/api/flight/schedule");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ session: null, entries: [] });
  });

  it("serves only actual pending plans ordered by due time, including later and overdue work", async () => {
    config.crew?.sessions[0]?.seats.push({
      id: "flight-1",
      role: "FLIGHT",
      accountId: "claude-main",
      model: "opus",
      area: [],
    });
    const session = config.crew?.sessions[0]?.id ?? "";
    const at = clock;
    store.setFlightPlans(
      session,
      {
        upsert: [
          {
            id: "later",
            dueAt: at + 300 * 60_000,
            kind: "brief",
            target: "crew",
            label: "Standup brief ready",
            status: "pending",
          },
          {
            id: "overdue",
            dueAt: at - 60_000,
            kind: "report",
            target: "missing-seat",
            label: "Example report",
            status: "pending",
          },
          {
            id: "done",
            dueAt: at,
            kind: "report",
            target: "crew",
            label: "Read report",
            status: "completed",
            detail: "Read the report",
          },
        ],
      },
      at,
    );
    const body = (await get("/api/flight/schedule")).json();
    expect(body.session).toBe(session);
    expect(body.entries.map((e: { id: string }) => e.id)).toEqual(["overdue", "later"]);
    expect(body.entries[0]).toMatchObject({
      label: "Example report",
      overdue: true,
      minutesFromNow: -1,
    });
    expect(body.entries[1]).toMatchObject({
      label: "Standup brief ready",
      overdue: false,
      minutesFromNow: 300,
    });
  });

  describe("GET /api/flight/brief", () => {
    it("has no session and nine empty sections without a watch seat", async () => {
      const body = (await get("/api/flight/brief")).json<FlightBriefView>();
      expect(body.session).toBeNull();
      expect(body.sections).toHaveLength(9);
      expect(body.sections.every((s) => s.text === "" && s.updatedAt === null)).toBe(true);
    });

    it("lists FLIGHT's saved sections in order", async () => {
      config.crew?.sessions[0]?.seats.push({
        id: "flight-1",
        role: "FLIGHT",
        accountId: "claude-main",
        model: "opus",
        area: [],
      });
      store.setFlightBriefSection({
        sessionId: config.crew?.sessions[0]?.id ?? "",
        section: "crew",
        text: "GUIDO builds.",
        updatedAt: 5,
        updatedBy: "flight-1",
      });
      const body = (await get("/api/flight/brief")).json<FlightBriefView>();
      expect(body.session).toBe(config.crew?.sessions[0]?.id);
      expect(body.sections[5]).toMatchObject({
        section: "crew",
        text: "GUIDO builds.",
        updatedBy: "flight-1",
      });
    });
  });

  describe("GET /api/flight", () => {
    it("has no seat without a watch seat", async () => {
      const r = await get("/api/flight");
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ seat: null, decisions: [] });
    });

    it("lists the last day's decisions, newest first", async () => {
      config.crew?.sessions[0]?.seats.push({
        id: "flight-1",
        role: "FLIGHT",
        accountId: "claude-main",
        model: "opus",
        area: [],
      });
      const d = (at: number, about: string) =>
        store.addFlightDecision({
          at,
          kind: "note",
          seatId: null,
          targetRunId: null,
          ref: null,
          questionId: null,
          about,
          decision: "d",
          basis: "b",
        });
      const now = Date.now();
      d(now - 25 * 60 * 60_000, "old");
      d(now - 2000, "first");
      d(now - 1000, "second");
      const r = await get("/api/flight");
      const body = r.json<FlightView>();
      expect(body.seat).toEqual({
        id: "flight-1",
        call: "FLIGHT-1",
        model: "opus",
        state: null,
        live: false,
        turns: null,
      });
      expect(body.decisions.map((x) => x.about)).toEqual(["second", "first"]);
    });

    it("counts the wakes of FLIGHT's current run as its turn", async () => {
      config.crew?.sessions[0]?.seats.push({
        id: "flight-1",
        role: "FLIGHT",
        accountId: "claude-main",
        model: "opus",
        area: [],
      });
      store.upsertRun(run({ id: "rf", agentId: "flight-1", startedAt: NOW - 3600e3 }));
      store.setSeatSession({
        seatId: "flight-1",
        runId: "rf",
        cliSessionId: null,
        state: "running",
        reason: null,
        worktree: null,
        updatedAt: NOW,
      });
      const claim = (key: string, runId: string) =>
        store.claimLine(key, { runId, seatId: "flight-1", origin: "engine", text: "w", at: NOW });
      for (const k of [1, 2, 3]) claim(`flight:wake:rf:${k}`, "rf");
      claim("flight:wake:other:1", "other");
      claim("flight:note:rf:1", "rf");
      const body = (await get("/api/flight")).json<FlightView>();
      expect(body.seat?.turns).toEqual({ n: 4, max: 41 });
    });
  });

  it("accepts the largest issue number", async () => {
    expect((await post5("start", { issue: 2 ** 31 - 1 })).statusCode).toBe(200);
  });

  it("answers 404 for an unknown seat, a loop id included", async () => {
    for (const id of ["nobody", "shop-app-ta"]) {
      expect((await postBody(`/api/seats/${id}/start`, { issue: 5 })).statusCode).toBe(404);
      expect((await get(`/api/seats/${id}/context`)).statusCode).toBe(404);
    }
    expect(supervisorCalls).toEqual([]);
  });

  it("answers 409 when the supervisor is disabled, with its note when it has one", async () => {
    supervisorStatus = { enabled: false, note: null };
    for (const [action, body] of [
      ["start", { issue: 5 }],
      ["message", { text: "hi" }],
      ["interrupt", {}],
      ["end", {}],
    ] as const) {
      const r = await post5(action, body);
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error: "crew is disabled on this server" });
    }
    expect((await get("/api/seats/guido-1/context")).statusCode).toBe(409);
    supervisorStatus = { enabled: false, note: "crew lock held by pid 7" };
    expect((await post5("end")).json()).toEqual({ error: "crew lock held by pid 7" });
    expect(supervisorCalls).toEqual([]);
  });

  it("answers 409 when no supervisor is wired", async () => {
    const a = buildApp({ config, store, bus });
    const r = await a.inject({
      method: "POST",
      url: "/api/seats/guido-1/end",
      headers: json,
      payload: {},
    });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: "crew is disabled on this server" });
    const st = await a.inject({ method: "GET", url: "/api/crew/status" });
    expect(st.json()).toEqual({ enabled: false, note: null });
    await a.close();
  });

  it("passes the supervisor's status and text through, and emits nothing", async () => {
    const seen: string[] = [];
    bus.subscribe((t) => seen.push(t));
    for (const [status, text] of [
      [409, "GUIDO-1 already has a run"],
      [404, "unknown issue"],
      [502, "could not read o/shop-app#5 from GitHub"],
      [504, "GUIDO-1 did not answer the interrupt"],
    ] as const) {
      supervisorFail = new SupervisorError(status, text);
      const r = await post5("start", { issue: 5 });
      expect(r.statusCode).toBe(status);
      expect(r.json()).toEqual({ error: text });
    }
    expect(seen).not.toContain("agents");
  });

  it("answers 422 with the start check's text", async () => {
    const text = otherLaneText("shop-app#5", [], "work");
    supervisorFail = new SupervisorError(422, text);
    const r = await post5("start", { issue: 5 });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toEqual({ error: text });
  });

  it("maps a CheckoutError to 422 with its fixed text", async () => {
    supervisorFail = new CheckoutError("dirty", "the clone has uncommitted changes");
    const r = await post5("start", { issue: 5 });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toEqual({ error: "the clone has uncommitted changes" });
  });

  it("logs a CheckoutError's detail (a path, git's text) and never sends it", async () => {
    supervisorFail = new CheckoutError("worktree", "could not create a worktree for feature/5-x", {
      detail: "fatal: '/Users/someone/secret/wt' already exists",
    });
    const r = await post5("start", { issue: 5 });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toEqual({ error: "could not create a worktree for feature/5-x" });
    expect(r.body).not.toContain("secret");
    expect(logs.join("")).toContain("fatal: '/Users/someone/secret/wt' already exists");
  });

  it("hides an unexpected error behind fixed text", async () => {
    supervisorFail = new Error("ENOENT /Users/someone/secret/path");
    const r = await post5("end");
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: "crew action failed" });
    expect(r.body).not.toContain("secret");
  });

  it("logs an unexpected error's message at warn", async () => {
    supervisorFail = new Error("spawn git EAGAIN");
    const r = await post5("end");
    expect(r.json()).toEqual({ error: "crew action failed" });
    expect(logs.join("")).toContain("spawn git EAGAIN");
  });

  it("checks that the crew is enabled before the seat, and the seat before the body", async () => {
    supervisorStatus = { enabled: false, note: null };
    const disabled = await postBody("/api/seats/nobody/start", { issue: 5 });
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json()).toEqual({ error: "crew is disabled on this server" });
    supervisorStatus = { enabled: true, note: null };
    const unknown = await postBody("/api/seats/nobody/start", { issue: "not a number" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: "unknown seat" });
    expect(supervisorCalls).toEqual([]);
  });

  it("GET context hides a supervisor failure behind fixed text", async () => {
    supervisorFail = new Error("ENOENT /Users/someone/secret/path");
    const r = await get("/api/seats/guido-1/context");
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: "crew action failed" });
    expect(r.body).not.toContain("secret");
  });

  it("GET context answers the usage, or null", async () => {
    const r = await get("/api/seats/guido-1/context");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ categories: [], total: 10, window: 100 });
    expect(supervisorCalls).toEqual([["context", "guido-1"]]);
  });

  it("GET /api/crew/sessions lists top-level folders only, with owners from the seats' areas", async () => {
    const clone = join(dir, "clone");
    mkdirSync(join(clone, "apps", "web"), { recursive: true });
    mkdirSync(join(clone, "docs"));
    mkdirSync(join(clone, ".git"));
    writeFileSync(join(clone, "README.md"), "x");
    const s = config.crew?.sessions[0];
    if (!s) throw new Error("no session");
    s.seats = [
      {
        id: "guido-1",
        role: "GUIDO",
        accountId: "claude-main",
        model: "sonnet",
        area: ["apps/**"],
      },
      { id: "retro-1", role: "RETRO", accountId: "claude-main", model: "sonnet", area: [] },
    ];
    const r = await get("/api/crew/sessions");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([
      {
        id: "s1",
        readable: true,
        folders: [
          { name: "apps", owners: ["guido-1"] },
          { name: "docs", owners: [] },
        ],
      },
    ]);
    // two writers nested under one top folder, not overlapping: the folder lists both, in config order
    s.seats = [
      {
        id: "guido-1",
        role: "GUIDO",
        accountId: "claude-main",
        model: "sonnet",
        area: ["apps/web/**"],
      },
      {
        id: "guido-2",
        role: "GUIDO",
        accountId: "claude-main",
        model: "sonnet",
        area: ["apps/server/**"],
      },
    ];
    const shared = (await get("/api/crew/sessions")).json<CrewSessionFolders[]>();
    expect(shared[0]?.folders).toEqual([
      { name: "apps", owners: ["guido-1", "guido-2"] },
      { name: "docs", owners: [] },
    ]);
    // a read-only seat owns nothing, and a whole-checkout writer owns every folder
    s.seats = [
      { id: "guido-1", role: "GUIDO", accountId: "claude-main", model: "sonnet", area: [] },
      { id: "retro-1", role: "RETRO", accountId: "claude-main", model: "sonnet", area: [] },
    ];
    const all = (await get("/api/crew/sessions")).json<CrewSessionFolders[]>();
    expect(all[0]?.folders.map((f) => f.owners)).toEqual([["guido-1"], ["guido-1"]]);
  });

  it("GET /api/crew/sessions answers a missing checkout with no folders, not a 500", async () => {
    rmSync(join(dir, "clone"), { recursive: true, force: true });
    const r = await get("/api/crew/sessions");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([{ id: "s1", readable: false, folders: [] }]);
  });

  it("GET /api/crew/sessions is empty without a crew section", async () => {
    config.crew = undefined;
    expect((await get("/api/crew/sessions")).json()).toEqual([]);
  });

  it("GET /api/crew/status answers the supervisor's status", async () => {
    supervisorStatus = { enabled: false, note: "crew lock held by pid 7" };
    const r = await get("/api/crew/status");
    expect(r.json()).toEqual({ enabled: false, note: "crew lock held by pid 7" });
  });

  it("refuses a foreign Origin", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/seats/guido-1/end",
      headers: { ...json, origin: "https://evil.example" },
      payload: {},
    });
    expect(r.statusCode).toBe(403);
    expect(supervisorCalls).toEqual([]);
  });
});

describe("update routes", () => {
  it("GET /api/version answers the updater's version", async () => {
    updaterVersion = {
      sha: "b".repeat(40),
      behind: 3,
      checkedAt: 7,
      canUpdate: false,
      reason: "not on main",
    };
    const r = await get("/api/version");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(updaterVersion);
  });

  it("POST /api/version/check answers the updater's check", async () => {
    updaterVersion = {
      sha: "c".repeat(40),
      behind: 0,
      checkedAt: 9,
      canUpdate: false,
      reason: "x",
    };
    const r = await post("/api/version/check");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(updaterVersion);
    expect(updaterCalls).toEqual(["check"]);
  });

  it("POST /api/version/check answers the updater's 502 with its text", async () => {
    updaterCheckError = new UpdateError(502, "Could not reach origin; last checked 2026-10-20.", {
      checkedAt: 1234,
    });
    const r = await post("/api/version/check");
    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({
      error: "Could not reach origin; last checked 2026-10-20.",
      checkedAt: 1234,
    });
  });

  it("POST /api/version/check answers an unexpected failure with its own text, not update's", async () => {
    updaterCheckError = new Error("boom");
    const r = await post("/api/version/check");
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: CHECK_FAILED });
  });

  it("POST /api/version/check refuses a body other than {} with 400, and a foreign Origin", async () => {
    const bad = await postBody("/api/version/check", { force: true });
    expect(bad.statusCode).toBe(400);
    const foreign = await app.inject({
      method: "POST",
      url: "/api/version/check",
      headers: { ...json, origin: "https://evil.example" },
      payload: {},
    });
    expect(foreign.statusCode).toBe(403);
    expect(updaterCalls).toEqual([]);
  });

  it("answers 200 { upToDate } and restarts nothing", async () => {
    const r = await post("/api/update");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ upToDate: true });
    expect(updaterCalls).toEqual(["update"]);
  });

  it("answers 202 { restarting }, and asks for the restart only after the response", async () => {
    updaterResult = async () => ({ restarting: true });
    const r = await post("/api/update");
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ restarting: true });
    expect(updaterCalls).toEqual(["update", "restart"]);
  });

  it("passes a refusal (409) and a failed step (500) through, and restarts nothing", async () => {
    for (const [status, text] of [
      [409, "the checkout has uncommitted changes"],
      [409, "GUIDO-1 is mid-turn"],
      [500, "update failed at build; see update.log"],
    ] as const) {
      updaterResult = async () => {
        throw new UpdateError(status, text);
      };
      const r = await post("/api/update");
      expect(r.statusCode).toBe(status);
      expect(r.json()).toEqual({ error: text });
    }
    expect(updaterCalls).not.toContain("restart");
  });

  it("hides an unexpected error behind fixed text", async () => {
    updaterResult = async () => {
      throw new Error("EACCES /Users/someone/secret");
    };
    const r = await post("/api/update");
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: "update failed; see update.log" });
  });

  it("refuses a body other than {} with 400 and updates nothing", async () => {
    const r = await postBody("/api/update", { ref: "evil" });
    expect(r.statusCode).toBe(400);
    expect(updaterCalls).toEqual([]);
  });

  it("refuses a foreign Origin", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/update",
      headers: { ...json, origin: "https://evil.example" },
      payload: {},
    });
    expect(r.statusCode).toBe(403);
    expect(updaterCalls).toEqual([]);
  });

  it("with no updater wired: version says why, update answers 409", async () => {
    const a = buildApp({ config, store, bus });
    const v = await a.inject({ method: "GET", url: "/api/version" });
    expect(v.json()).toEqual({
      sha: "",
      behind: null,
      checkedAt: null,
      canUpdate: false,
      reason: "updates are not available on this server",
    });
    const u = await a.inject({ method: "POST", url: "/api/update", headers: json, payload: {} });
    expect(u.statusCode).toBe(409);
    expect(u.json()).toEqual({ error: "updates are not available on this server" });
    const c = await a.inject({
      method: "POST",
      url: "/api/version/check",
      headers: json,
      payload: {},
    });
    expect(c.json()).toMatchObject({
      canUpdate: false,
      reason: "updates are not available on this server",
    });
    await a.close();
  });
});

describe("seat ids in the agent routes", () => {
  beforeEach(withCrew);
  it("GET /api/agents/<seat id>/runs lists the seat's runs", async () => {
    store.upsertRun(run({ id: "c1", agentId: "guido-1", repoId: "shop-app" }));
    const r = await get("/api/agents/guido-1/runs");
    expect(r.statusCode).toBe(200);
    expect(r.json<RunView[]>().map((x) => x.id)).toEqual(["c1"]);
  });

  it("GET /api/agents/<seat id>/stream reads the seat's latest run transcript", async () => {
    const p = join(dir, "seat.jsonl");
    writeFileSync(p, line("brief read", NOW - 2 * 60e3));
    utimesSync(p, (NOW - 60e3) / 1000, (NOW - 60e3) / 1000);
    store.upsertRun(
      run({ id: "c0", agentId: "guido-1", startedAt: NOW - HOUR, transcriptPath: "" }),
    );
    store.upsertRun(run({ id: "c1", agentId: "guido-1", startedAt: NOW, transcriptPath: p }));
    const r = await get("/api/agents/guido-1/stream");
    expect(r.statusCode).toBe(200);
    expect(r.json<AgentStream>()).toEqual({
      runId: "c1",
      tasks: [],
      events: [{ id: "0:0", at: NOW - 2 * 60e3, kind: "msg", text: "brief read" }],
      truncated: false,
      lastOutputAt: NOW - 60e3,
      reason: null,
    });
  });

  it.each(["codex", undefined] as const)(
    "GET /api/agents/<seat id>/stream reads Codex events with vendor %s",
    async (vendor) => {
      const p = join(dir, "codex.jsonl");
      writeFileSync(p, readFileSync(resolve(import.meta.dirname, "fixtures/stream/codex.jsonl")));
      store.upsertRun(
        run({ id: "cx1", agentId: "guido-1", vendor, startedAt: NOW, transcriptPath: p }),
      );
      const response = await get("/api/agents/guido-1/stream");
      expect(response.statusCode).toBe(200);
      const events = response.json<AgentStream>().events;
      expect(events.some((e) => e.kind === "msg" && e.text === "Done. Tests pass.")).toBe(true);
      expect(events.find((e) => e.text === "Bash")?.tool).toMatchObject({
        result: "Tests passed\n",
        status: "completed",
        exitCode: 0,
      });
    },
  );

  describe("a seat's Files tab", () => {
    const gitIn = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=n", ...args], {
        cwd,
        encoding: "utf8",
      });
    let clone: string;
    let wt: string;
    const seatRow = (worktree: string | null) => ({
      seatId: "guido-1",
      runId: "c1",
      cliSessionId: null,
      state: "running" as const,
      reason: null,
      worktree,
      updatedAt: NOW,
    });
    // a clone with origin/HEAD at its first commit
    const makeClone = (name: string) => {
      const r = join(dir, name);
      mkdirSync(r, { recursive: true });
      gitIn(r, "init", "-q");
      writeFileSync(join(r, "a.txt"), "one\n");
      gitIn(r, "add", "-A");
      gitIn(r, "commit", "-qm", "init");
      gitIn(r, "update-ref", "refs/remotes/origin/main", "HEAD");
      gitIn(r, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
      return r;
    };
    // the seat's worktree: one commit ahead, with an uncommitted edit and an untracked file
    beforeEach(() => {
      clone = makeClone("clone");
      wt = join(dir, "seat-wt");
      gitIn(clone, "worktree", "add", "-q", "-b", "seat", wt);
      writeFileSync(join(wt, "done.txt"), "x\n");
      gitIn(wt, "add", "-A");
      gitIn(wt, "commit", "-qm", "done");
      writeFileSync(join(wt, "a.txt"), "two\n");
      writeFileSync(join(wt, "new.txt"), "n1\nn2\n");
      store.upsertRun(run({ id: "c1", agentId: "guido-1", repoId: "shop-app" }));
      store.setSeatSession(seatRow(wt));
    });

    it("a writer seat lists its committed, uncommitted and untracked files, and diffs one", async () => {
      const list = await get("/api/agents/guido-1/files");
      expect(list.statusCode).toBe(200);
      const body = list.json<ChangedFiles>();
      expect(body.note).toBeNull();
      expect(body.sha).toBe(gitIn(wt, "rev-parse", "HEAD").trim());
      expect([...body.files].sort((x, y) => x.path.localeCompare(y.path))).toEqual([
        { path: "a.txt", add: 1, del: 1, state: "uncommitted", commitSha: null },
        { path: "done.txt", add: 1, del: 0, state: "committed", commitSha: body.sha },
        { path: "new.txt", add: null, del: null, state: "untracked", commitSha: null },
      ]);
      const diff = await get("/api/agents/guido-1/files/diff?path=a.txt");
      expect(diff.statusCode).toBe(200);
      const text = diff.json<FileDiff>().text;
      expect(text).toContain("-one");
      expect(text).toContain("+two");
      expect((await get("/api/agents/guido-1/files/diff?path=nope.txt")).statusCode).toBe(404);
    });

    it("a run set aside in review, with no seat worktree, is read from the run's aside", async () => {
      store.setSeatSession(seatRow(null));
      store.setRunLoop("c1", {
        ...NEW_LOOP,
        phase: "review",
        aside: { worktree: wt, wake: false },
      });
      const body = (await get("/api/agents/guido-1/files")).json<ChangedFiles>();
      expect(body.files.map((f) => f.path)).toContain("done.txt");
    });

    it("answers 502 when the worktree's .git pointer was rewritten to another repository", async () => {
      const other = makeClone("other");
      gitIn(other, "worktree", "add", "-q", "-b", "evil", join(dir, "evil-wt"));
      writeFileSync(join(wt, ".git"), `gitdir: ${join(other, ".git", "worktrees", "evil-wt")}\n`);
      const list = await get("/api/agents/guido-1/files");
      expect(list.statusCode).toBe(502);
      expect(list.json()).toEqual({ error: "git failed" });
      const diff = await get("/api/agents/guido-1/files/diff?path=a.txt");
      expect(diff.statusCode).toBe(502);
      expect(diff.json()).toEqual({ error: "git failed" });
    });

    it("a writer seat with no worktree answers the no-worktree note, and 404 for a diff", async () => {
      store.setSeatSession(seatRow(null));
      expect((await get("/api/agents/guido-1/files")).json()).toEqual({
        files: [],
        note: NO_WORKTREE_NOTE,
        sha: null,
      });
      store.setSeatSession(seatRow(join(dir, "gone")));
      expect((await get("/api/agents/guido-1/files")).json<ChangedFiles>().note).toBe(
        NO_WORKTREE_NOTE,
      );
      const diff = await get("/api/agents/guido-1/files/diff?path=a.txt");
      expect(diff.statusCode).toBe(404);
      expect(diff.json()).toEqual({ error: "unknown file" });
    });

    it("a read-only seat answers the read-only note and runs no git", async () => {
      config.crew?.sessions[0]?.seats.push({
        id: "retro-1",
        role: "RETRO",
        accountId: "claude-main",
        model: "haiku",
        area: [],
      });
      store.setSeatSession({ ...seatRow(wt), seatId: "retro-1" });
      const seen: string[] = [];
      const a = buildApp({
        config,
        store,
        bus,
        changedFiles: async (w) => {
          seen.push(w);
          return { files: [], note: null, sha: null };
        },
      });
      await a.ready();
      const files = await a.inject({ method: "GET", url: "/api/agents/retro-1/files" });
      expect(files.statusCode).toBe(200);
      expect(files.json()).toEqual({ files: [], note: READONLY_FILES_NOTE, sha: null });
      const diff = await a.inject({ method: "GET", url: "/api/agents/retro-1/files/diff?path=a" });
      expect(diff.statusCode).toBe(404);
      expect(diff.json()).toEqual({ error: "unknown file" });
      expect(seen).toEqual([]);
      expect(READONLY_FILES_NOTE).toBe("Read-only agent: no file changes.");
      await a.close();
    });
  });

  it("GET /api/telemetry?agent=<seat id> is accepted", async () => {
    expect((await get("/api/telemetry?agent=guido-1")).statusCode).toBe(200);
  });

  it("GET /api/telemetry?agent=guido-1 returns only that seat's series", async () => {
    for (const [id, agentId] of [
      ["c1", "guido-1"],
      ["c2", "shop-app-ta"],
    ] as const) {
      store.upsertRun(
        run({
          id,
          agentId,
          startedAt: NOW - 3 * HOUR,
          endedAt: NOW - 2 * HOUR,
          status: "ok",
          tokens: { input: 600, output: 0, cacheRead: 0, cacheCreate: 0 },
        }),
      );
    }
    // the scope narrows today and totals; the per-agent series stay crew-wide (telemetry.ts)
    const all = (await get("/api/telemetry")).json<Telemetry>();
    expect(all.totals.map((t) => t.agentId).sort()).toEqual(["guido-1", "shop-app-ta"]);
    const one = (await get("/api/telemetry?agent=guido-1")).json<Telemetry>();
    expect(one.totals.map((t) => t.agentId)).toEqual(["guido-1"]);
    expect(one.today.agents).toBe(1);
    expect(one.today.tokens).toBeGreaterThan(0);
    expect(one.today.tokens).toBeLessThan(all.today.tokens);
  });

  it("refuses an unknown agent with the configured-id text", async () => {
    const r = await get("/api/telemetry?agent=nobody");
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: "agent must be a configured agent id" });
  });
});

describe("the first loop's engine", () => {
  beforeEach(withCrew);
  const loop = {
    phase: "ci",
    reportedEvidenceId: 1,
    prNumber: null,
    pushStartedAt: NOW,
    pushFor: null,
    unparkedAt: null,
    ciFails: 0,
    ciFailedSha: null,
    relayedSha: null,
    transient: 0,
    lastRefusal: null,
    epoch: 0,
    budgetExtra: 0,
    parked: null,
    touches: null,
    cardFor: null,
  } as const;
  const engineApp = (seatRunId: string | null) => {
    const told: string[] = [];
    const sup = stubSupervisor();
    sup.seat = () =>
      seatRunId === null
        ? null
        : {
            seatId: "guido-1",
            runId: seatRunId,
            cliSessionId: null,
            state: "idle",
            reason: null,
            worktree: null,
            updatedAt: NOW,
          };
    const a = buildApp({
      config,
      store,
      bus,
      supervisor: sup,
      engine: {
        onOperatorMessage: async (runId) => {
          told.push(runId);
          return false;
        },
        status: () => ({ on: true, note: "mc: the Mission Control section has no yaml block" }),
      },
    });
    return { a, told };
  };
  const message = (a: FastifyInstance) =>
    a.inject({
      method: "POST",
      url: "/api/seats/guido-1/message",
      headers: json,
      payload: { text: "go on" },
    });

  it("tells the engine of a message to a seat whose run is looped", async () => {
    store.upsertRun(run({ id: "looped", agentId: "guido-1", loop }));
    const { a, told } = engineApp("looped");
    expect((await message(a)).statusCode).toBe(200);
    expect(told).toEqual(["looped"]);
    await a.close();
  });

  it("does not for a run no loop drives, or a seat with no run", async () => {
    store.upsertRun(run({ id: "plain", agentId: "guido-1" }));
    const plain = engineApp("plain");
    expect((await message(plain.a)).statusCode).toBe(200);
    expect(plain.told).toEqual([]);
    await plain.a.close();
    const none = engineApp(null);
    expect((await message(none.a)).statusCode).toBe(200);
    expect(none.told).toEqual([]);
    await none.a.close();
  });

  it("resumes a parked looped run through the engine, though its seat holds no run (#477)", async () => {
    store.upsertRun(run({ id: "aside", agentId: "guido-1", loop }));
    const { a, told } = engineApp(null);
    const r = await a.inject({
      method: "POST",
      url: "/api/runs/aside/resume",
      headers: json,
      payload: {},
    });
    expect(told).toEqual(["aside"]);
    expect(r.statusCode).toBe(409);
    expect(
      (await a.inject({ method: "POST", url: "/api/runs/nope/resume", headers: json, payload: {} }))
        .statusCode,
    ).toBe(404);
    await a.close();
  });

  it.each([
    ["a body", { x: 1 }, true, "aside", 400],
    ["no engine", {}, false, "aside", 409],
    ["an unlooped run", {}, true, "plain-run", 404],
  ] as const)("refuses %s", async (_what, payload, withEngine, id, code) => {
    store.upsertRun(run({ id: "aside", agentId: "guido-1", loop }));
    store.upsertRun(run({ id: "plain-run", agentId: "guido-1" }));
    const a = buildApp({
      config,
      store,
      bus,
      supervisor: stubSupervisor(),
      ...(withEngine
        ? {
            engine: { onOperatorMessage: async () => true, status: () => ({ on: true, note: "" }) },
          }
        : {}),
    });
    const r = await a.inject({
      method: "POST",
      url: `/api/runs/${id}/resume`,
      headers: json,
      payload,
    });
    expect(r.statusCode).toBe(code);
    await a.close();
  });

  it("answers ok when the engine lifts the park", async () => {
    store.upsertRun(run({ id: "aside", agentId: "guido-1", loop }));
    const a = buildApp({
      config,
      store,
      bus,
      supervisor: stubSupervisor(),
      engine: { onOperatorMessage: async () => true, status: () => ({ on: true, note: "" }) },
    });
    const r = await a.inject({
      method: "POST",
      url: "/api/runs/aside/resume",
      headers: json,
      payload: {},
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    await a.close();
  });

  it("records the operator's message as CAPCOM to the seat, about its run's ticket", async () => {
    store.upsertRun(run({ id: "plain", agentId: "guido-1", ticket: "shop-app#9" }));
    const { a } = engineApp("plain");
    expect((await message(a)).statusCode).toBe(200);
    expect(store.comms(0)).toEqual([
      {
        at: expect.any(Number),
        from: "CAPCOM",
        to: "guido-1",
        ticket: "shop-app#9",
        text: "go on",
      },
    ]);
    await a.close();
  });

  it("records a message to a seat with no run against no ticket, and a refused one not at all", async () => {
    const none = engineApp(null);
    expect((await message(none.a)).statusCode).toBe(200);
    expect(store.comms(0).map((c) => c.ticket)).toEqual([null]);
    supervisorFail = new SupervisorError(409, "GUIDO-1 has no live session");
    expect((await message(none.a)).statusCode).toBe(409);
    expect(store.comms(0)).toHaveLength(1);
    await none.a.close();
  });

  it("does not when the message is refused", async () => {
    store.upsertRun(run({ id: "looped", agentId: "guido-1", loop }));
    const { a, told } = engineApp("looped");
    supervisorFail = new SupervisorError(409, "GUIDO-1 has no live session");
    expect((await message(a)).statusCode).toBe(409);
    expect(told).toEqual([]);
    await a.close();
  });

  it("carries the engine's note in /api/crew/status, and nothing extra without an engine", async () => {
    const { a } = engineApp(null);
    const st = await a.inject({ method: "GET", url: "/api/crew/status" });
    expect(st.json()).toEqual({
      enabled: true,
      note: null,
      engine: { on: true, note: "mc: the Mission Control section has no yaml block" },
    });
    await a.close();
    expect((await get("/api/crew/status")).json()).toEqual({ enabled: true, note: null });
  });

  it("serves measured attempts including review usage, and keeps a new run's tasks empty", async () => {
    store.upsertRun(run({ id: "measured", agentId: "guido-1", loop }));
    store.addLoopEvent("measure-report", "measured", "reported; pushing", NOW - 3000);
    store.addLoopEvent("measure-ci", "measured", "CI passed on abc1234", NOW - 2000);
    const tasks = [{ id: "verify", text: "Verify measurements", status: "in_progress" as const }];
    store.setDigest(
      "measured",
      digest({ tasks, attemptUsage: [{ id: "author", at: NOW - 4000, tokens: 0 }] }),
    );
    const reviewId = store.requestReview({
      authorRunId: "measured",
      repoId: "shop-app",
      seatId: "retro-1",
      prNumber: 1,
      sha: "abc1234",
      epoch: loop.epoch,
      attempt: 1,
      round: 1,
      at: NOW - 2000,
    });
    expect(reviewId).not.toBeNull();
    store.setReviewState(reviewId as number, ["queued"], "running", {
      at: NOW - 2000,
      runId: "review-measured",
    });
    store.upsertRun(run({ id: "review-measured", agentId: "retro-1" }));
    store.setDigest(
      "review-measured",
      digest({ attemptUsage: [{ id: "review", at: NOW - 1000, tokens: 17 }] }),
    );
    const view = (await get("/api/runs/measured/loop")).json();
    expect(view.tries.map((t: { tokens: number | null }) => t.tokens)).toEqual([0, null, 17]);
    expect((await get("/api/agents/guido-1/stream")).json().tasks).toEqual(tasks);
    expect(
      (await get("/api/crew")).json<Crew>().rows.find((r) => r.id === "guido-1")?.digest?.tasks,
    ).toEqual(tasks);
    store.upsertRun(run({ id: "fresh-measured", agentId: "guido-1", startedAt: NOW + 1 }));
    expect((await get("/api/agents/guido-1/stream")).json().tasks).toEqual([]);
  });

  it.each([
    { cacheRead: 0, cacheCreate: 0, budget: 105000 },
    { cacheRead: 20, cacheCreate: 0, budget: null },
    { cacheRead: 0, cacheCreate: 20, budget: null },
  ])(
    "shows the budget only when HUD and enforced usage match: %j",
    async ({ cacheRead, cacheCreate, budget }) => {
      if (config.crew) config.crew.runTokenBudget = 100000;
      store.upsertRun(
        run({
          id: "budgeted",
          agentId: "guido-1",
          loop: { ...loop, budgetExtra: 5000 },
          tokens: { input: 100, output: 50, cacheRead, cacheCreate },
        }),
      );
      const view = (await get("/api/runs/budgeted/loop")).json();
      expect(view.usage).toMatchObject({ input: 100, output: 50, cacheRead, cacheCreate });
      expect(view.budget).toBe(budget);
    },
  );

  it("GET /api/runs/:id/attempts returns retained history and rejects unknown runs", async () => {
    store.upsertRun(run({ id: "history", agentId: "guido-1" }));
    store.setRunPush({ runId: "history", sha: "head", at: NOW });
    const response = await get("/api/runs/history/attempts");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      runId: "history",
      attempts: [{ kind: "run" }, { kind: "push", data: { sha: "head" } }],
    });
    expect((await get("/api/runs/unknown/attempts")).statusCode).toBe(404);
  });

  it("caps the served review round at the run profile limit", async () => {
    store.upsertRun(
      run({
        id: "profiled",
        agentId: "guido-1",
        loop,
        profile: {
          profile: { ...DEFAULT_PROFILES[0], rounds: 2 },
          route: { by: "size", size: "S" },
          hash: "h",
        },
      }),
    );
    for (let n = 1; n <= 3; n++)
      store.claimLine(`fix:profiled:${loop.epoch}:${n}`, {
        runId: "profiled",
        seatId: "guido-1",
        origin: "engine",
        text: "fix",
        at: NOW,
      });
    expect((await get("/api/runs/profiled/loop")).json().round).toBe(2);
  });

  it("GET /api/runs/:id/loop answers the run's loop and its events, or 404", async () => {
    store.upsertRun(run({ id: "looped", agentId: "guido-1", loop }));
    store.upsertRun(run({ id: "plain", agentId: "guido-1" }));
    store.addLoopEvent("k1", "looped", "reported; pushing", NOW);
    store.addLoopEvent("k2", "plain", "other", NOW);
    if (config.crew) config.crew.runTokenBudget = 100_000;
    const body = (await get("/api/runs/looped/loop")).json();
    expect(body).toMatchObject({
      runId: "looped",
      loop,
      events: [{ key: "k1", runId: "looped", text: "reported; pushing", at: NOW }],
      round: 1,
      budget: null,
      review: null,
    });
    expect(body.tries.map((t: { step: string }) => t.step)).toEqual(["working", "ci"]);
    store.setRunLoop("looped", { ...loop, budgetExtra: 5000 });
    expect((await get("/api/runs/looped/loop")).json().budget).toBeNull();
    const claim = (n: number) =>
      store.claimLine(`fix:looped:${loop.epoch}:${n}`, {
        runId: "looped",
        seatId: "guido-1",
        origin: "engine",
        text: "fix",
        at: NOW,
      });
    claim(1);
    claim(2);
    expect((await get("/api/runs/looped/loop")).json().round).toBe(3);
    claim(3);
    expect((await get("/api/runs/looped/loop")).json().round).toBe(3);
    expect((await get("/api/runs/plain/loop")).json()).toEqual({
      runId: "plain",
      usage: {
        input: null,
        output: null,
        cacheRead: null,
        cacheCreate: null,
        costUsd: null,
        model: null,
        turns: null,
        durationMs: 3600000,
      },
      noReport: null,
      loop: null,
      events: [{ key: "k2", runId: "plain", text: "other", at: NOW }],
      tries: [],
      round: null,
      budget: null,
      review: null,
    });
    expect((await get("/api/runs/nobody/loop")).statusCode).toBe(404);
  });

  it("omits toolStarts from /api/crew digests", async () => {
    store.upsertRun(run({ id: "ticks", agentId: "guido-1", loop }));
    store.setDigest("ticks", digest({ toolStarts: [NOW - 100, NOW] }));
    const row = (await get("/api/crew")).json<Crew>().rows.find((r) => r.id === "guido-1");
    expect(row?.digest).toBeTruthy();
    expect(row?.digest).not.toHaveProperty("toolStarts");
    expect(store.digest("ticks")?.toolStarts).toEqual([NOW - 100, NOW]);
  });

  it("serves full missing-report diagnostics only on the single-run loop view", async () => {
    const r = run({ id: "unreported", agentId: "guido-1", loop });
    store.upsertRun(r);
    recordNoReport(store, r, "build", { code: 1, signal: null, lastStderr: null }, null, NOW);
    const noReport = store.run(r.id)?.noReport;
    if (!noReport) throw new Error("missing diagnostics");
    store.recordNoReport(
      r.id,
      { ...noReport, lastAssistantText: "The unfinished work." },
      {
        key: `no_report:${r.id}`,
        kind: "flag",
        runId: r.id,
        seatId: r.agentId,
        repoId: r.repoId,
        text: "Missing report",
        at: NOW,
      },
    );
    const view = (await get(`/api/runs/${r.id}/loop`)).json();
    expect(view.noReport.lastAssistantText).toBe("The unfinished work.");
    const rows = (await get("/api/agents/guido-1/runs")).json<RunView[]>();
    expect(rows.find((row) => row.id === r.id)?.noReport).toMatchObject({ code: 1 });
    expect(rows.find((row) => row.id === r.id)?.noReport).not.toHaveProperty("lastAssistantText");
    expect((await get("/api/agents")).body).not.toContain("lastAssistantText");
    expect((await get("/api/crew")).body).not.toContain("lastAssistantText");
  });
});

describe("test lock history", () => {
  it("returns seven days newest first, local today waits and medians after three done holds", async () => {
    const midnight = Date.parse("2026-10-16T23:00:00Z");
    const add = (id: string, started: number, command: string, length: number, freed = false) => {
      store.addLockHold({
        runId: id,
        seatId: "guido-1",
        toolUseId: "call",
        command,
        since: started,
        queuedAt: started - 1000,
      });
      if (freed) store.deleteLockHolds(id, started + length);
      else store.deleteLockHold(id, "call", started + length);
    };
    add("old", NOW - 7.5 * 86400000, "test", 100);
    add("yesterday", midnight - 1, "test", 100);
    add("one", midnight, "test", 200);
    add("two", midnight + 1, "test", 900);
    add("free", midnight + 2, "test", 500, true);
    add("rare", midnight + 3, "rare", 500);
    const response = await get("/api/test-lock/history");
    expect(response.statusCode).toBe(200);
    const h = response.json();
    expect(h.runs.map((r: { runId: string }) => r.runId)).toEqual([
      "rare",
      "free",
      "two",
      "one",
      "yesterday",
    ]);
    expect(h.today).toEqual({ runs: 4, waitMs: 4000 });
    expect(h.usualMs).toEqual({ test: 200 });
  });
});

// Status transport is exercised with fake CLIs in accounts.test.ts, never the machine's login.
vi.mock("../src/accounts.ts", () => ({
  readAccountStatus: async (account: { id: string; vendor: string }, now: number) => ({
    accountId: account.id,
    provider: account.vendor,
    binding: "machine",
    identity: null,
    plan: null,
    status: "unknown",
    checkedAt: now,
    detail: null,
  }),
}));

it("bounds uncached telemetry reads, filters first and persists immutable counts", async () => {
  store.upsertRun(
    run({
      id: "many",
      ticket: "shop-app#7",
      tokens: { input: 1, output: 0, cacheRead: 0, cacheCreate: 0 },
    }),
  );
  for (let i = 0; i < 50; i++)
    store.addRunCommit({
      runId: "many",
      repoId: "shop-app",
      branch: "b",
      sha: i.toString(16).padStart(40, "0"),
      at: NOW - 1000 + i,
    });
  let active = 0;
  let peak = 0;
  const read = vi.spyOn(files, "committedLines").mockImplementation(async () => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return { additions: 2, deletions: 1 };
  });
  try {
    await get("/api/telemetry?ticket=shop-app%238");
    expect(read).toHaveBeenCalledTimes(0);
    const first = (await get("/api/telemetry")).json<Telemetry>();
    expect(read).toHaveBeenCalledTimes(32);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    expect(first.totals[0]?.additions).toBeNull();
    const second = (await get("/api/telemetry")).json<Telemetry>();
    expect(read).toHaveBeenCalledTimes(50);
    expect(new Set(read.mock.calls.map((c) => c[1])).size).toBe(50);
    expect(second.totals[0]?.additions).toBe(100);
    await get("/api/telemetry");
    expect(read).toHaveBeenCalledTimes(50);
  } finally {
    read.mockRestore();
  }
});

it("does not log successful GET requests", async () => {
  logs.length = 0;
  expect(
    (await app.inject({ method: "GET", url: "/api/crew", headers: { host: "localhost" } }))
      .statusCode,
  ).toBe(200);
  expect(logs).toEqual([]);
});

it("logs one response line for a 500", async () => {
  vi.spyOn(store, "getSetting").mockImplementation(() => {
    throw new Error("test failure");
  });
  logs.length = 0;
  expect(
    (await app.inject({ method: "GET", url: "/api/settings/away", headers: { host: "localhost" } }))
      .statusCode,
  ).toBe(500);
  expect(logs).toHaveLength(1);
  expect(JSON.parse(logs[0])).toMatchObject({ res: { statusCode: 500 } });
  expect(JSON.parse(logs[0]).err).toMatchObject({
    message: "test failure",
    stack: expect.stringContaining("Error: test failure"),
  });
});

it("logs a 4xx response once", async () => {
  logs.length = 0;
  expect(
    (await app.inject({ method: "GET", url: "/api/missing", headers: { host: "localhost" } }))
      .statusCode,
  ).toBe(404);
  expect(logs).toHaveLength(1);
  expect(JSON.parse(logs[0])).toMatchObject({ res: { statusCode: 404 } });
});

it("logs a successful request taking over one second", async () => {
  vi.spyOn(store, "getSetting").mockImplementationOnce(() => {
    const until = performance.now() + 1010;
    while (performance.now() < until) {
      /* a slow store read */
    }
    return null;
  });
  logs.length = 0;
  expect(
    (await app.inject({ method: "GET", url: "/api/settings/away", headers: { host: "localhost" } }))
      .statusCode,
  ).toBe(200);
  expect(logs).toHaveLength(1);
  expect(JSON.parse(logs[0]).responseTime).toBeGreaterThan(1000);
});

it("logs the error message and stack of an explicit 5xx response", async () => {
  updaterCheckError = new UpdateError(502, "Could not reach origin.");
  logs.length = 0;
  const response = await post("/api/version/check");
  expect(response.statusCode).toBe(502);
  expect(logs).toHaveLength(1);
  expect(JSON.parse(logs[0]).err).toMatchObject({
    message: "Could not reach origin.",
    stack: expect.stringContaining("Could not reach origin."),
  });
});

it("keeps claim keys and the review round for a retained run past seven days", async () => {
  const retained = run({
    id: "retained-loop",
    endedAt: NOW - 8 * 86_400_000,
    loop: { ...NEW_LOOP },
  });
  store.upsertRun(retained);
  const key = `fix:${retained.id}:0:1`;
  store.claimLine(key, {
    runId: retained.id,
    seatId: "flight-1",
    origin: "engine",
    text: "fix",
    at: 1,
  });
  await store.pruneHistory(NOW);
  expect(store.claimedKeys(retained.id)).toEqual({ [key]: 1 });
  expect((await get(`/api/runs/${retained.id}/loop`)).json().round).toBe(2);
});

it.each([false, true])(
  "logs the original caught exception with generic response: %s",
  async (generic) => {
    const error = generic
      ? new Error("original private failure")
      : new UpdateError(502, "Could not reach origin.");
    error.stack = "Error: original failure\n    at originalThrowSite (updater.ts:123:4)";
    updaterCheckError = error;
    logs.length = 0;
    const response = await post("/api/version/check");
    expect(response.statusCode).toBe(generic ? 500 : 502);
    expect(response.json().error).toBe(generic ? CHECK_FAILED : error.message);
    const completed = logs
      .map((line) => JSON.parse(line))
      .filter((line) => line.msg === "request completed");
    expect(completed).toHaveLength(1);
    expect(completed[0].err).toMatchObject({ message: error.message, stack: error.stack });
  },
);

it("builds without Fastify's request-logging deprecation warning", async () => {
  const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  try {
    const quiet = buildApp({
      config,
      store,
      bus,
      now: () => clock,
      configPath,
      crewReloader: stubReloader(),
      supervisor: stubSupervisor(),
      updater: stubUpdater(),
    });
    await quiet.ready();
    await quiet.close();
    // Fastify calls emitWarning(message, name, code).
    expect(warn.mock.calls.filter((call) => (call as unknown[])[2] === "FSTDEP023")).toEqual([]);
  } finally {
    warn.mockRestore();
  }
});

describe("operator token", () => {
  let guarded: FastifyInstance;

  beforeEach(async () => {
    guarded = buildApp({
      config,
      store,
      bus,
      now: () => clock,
      configPath,
      crewReloader: stubReloader(),
      supervisor: stubSupervisor(),
      updater: stubUpdater(),
      operatorToken: "tok-1",
    });
    await guarded.ready();
  });

  afterEach(async () => {
    await guarded.close();
  });

  const guardedPost = (url: string, headers: Record<string, string>, payload: object = {}) =>
    guarded.inject({ method: "POST", url, headers: { ...json, ...headers }, payload });

  it("refuses a mutating route without the operator token (401)", async () => {
    const pause = "/api/agents/shop-app-ta/pause";
    const bare = await guardedPost(pause, {});
    expect(bare.statusCode).toBe(401);
    expect(bare.json()).toEqual({ error: OPERATOR_TOKEN_REQUIRED });
    expect(existsSync(join(stateDir, "PAUSE"))).toBe(false);
    expect((await guardedPost(pause, { [OPERATOR_HEADER]: "wrong" })).statusCode).toBe(401);
    const away = await guardedPost("/api/settings/away", {}, { ...DEFAULT_AWAY, on: true });
    expect(away.statusCode).toBe(401);
    const read = await guarded.inject({ method: "GET", url: "/api/settings/away" });
    expect(read.json()).toEqual(DEFAULT_AWAY);
    const crewPause = await guardedPost(
      "/api/settings/crew-pause",
      {},
      { seats: "all", reason: "Save tokens" },
    );
    expect(crewPause.statusCode).toBe(401);
    expect(store.getSetting("crew.paused")).toBeNull();
  });

  it("leaves GET routes and the guard check as they were", async () => {
    expect((await guarded.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    const check = await guardedPost(
      "/api/guard/check",
      {},
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: {} },
    );
    expect(check.statusCode).toBe(401);
    expect(check.json().error).not.toBe(OPERATOR_TOKEN_REQUIRED);
  });

  it("runs a mutating route with the operator token", async () => {
    const key = { [OPERATOR_HEADER]: "tok-1" };
    const paused = await guardedPost("/api/agents/shop-app-ta/pause", key);
    expect(paused.statusCode).toBe(200);
    expect(existsSync(join(stateDir, "PAUSE"))).toBe(true);
    const away = await guardedPost("/api/settings/away", key, { ...DEFAULT_AWAY, on: true });
    expect(away.statusCode).toBe(200);
    const read = await guarded.inject({ method: "GET", url: "/api/settings/away" });
    expect(read.json()).toMatchObject({ on: true });
  });

  it("hands the token to a same-origin page only", async () => {
    const boot = (headers: Record<string, string>) =>
      guarded.inject({ method: "GET", url: OPERATOR_BOOTSTRAP_PATH, headers });
    const ok = await boot({ "sec-fetch-site": "same-origin" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ token: "tok-1" });
    expect(ok.headers["cache-control"]).toBe("no-store");
    const bare = await boot({});
    expect(bare.statusCode).toBe(403);
    expect(bare.json()).toEqual({ error: BOOTSTRAP_REFUSED });
    expect((await boot({ "sec-fetch-site": "cross-site" })).statusCode).toBe(403);
    const fromAddress = (remoteAddress: string) =>
      guarded.inject({
        method: "GET",
        url: OPERATOR_BOOTSTRAP_PATH,
        headers: { "sec-fetch-site": "same-origin" },
        remoteAddress,
      });
    const remote = await fromAddress("10.0.0.5");
    expect(remote.statusCode).toBe(403);
    expect(remote.json()).toEqual({ error: BOOTSTRAP_REFUSED });
    expect((await fromAddress("::1")).statusCode).toBe(200);
    expect((await get(OPERATOR_BOOTSTRAP_PATH)).statusCode).toBe(404);
  });
});

describe("FLIGHT ledger views", () => {
  it("returns empty views without a FLIGHT session", async () => {
    expect((await get("/api/flight/ledger")).json()).toEqual({
      session: null,
      entries: [],
      more: false,
      nextOffset: null,
    });
    expect((await get("/api/flight/summary")).json()).toMatchObject({
      session: null,
      headline: "",
      now: [],
      next: [],
      incoming: 0,
      watching: { top: [] },
    });
  });

  it("orders now by priority then age, orders next by due time, and caps each list at five", async () => {
    withCrew();
    config.crew?.sessions[0]?.seats.push({
      id: "flight-1",
      role: "FLIGHT",
      accountId: "claude-main",
      model: "opus",
      area: [],
    });
    const entry = (key: string, over: Partial<FlightLedgerEntry> = {}): FlightLedgerEntry => ({
      key,
      kind: "work",
      title: key,
      status: "active",
      next: null,
      owner: null,
      waitsOn: null,
      due: null,
      refs: [],
      priority: null,
      createdAt: 0,
      updatedAt: NOW,
      outcome: null,
      basis: "ticket",
      ...over,
    });
    const put = (e: FlightLedgerEntry) => store.putFlightLedgerEntry("s1", e, 0);
    for (const [priority, createdAt] of [
      ["P2", 1],
      [null, 0],
      ["P0", 5],
      ["P0", 2],
      ["P1", 3],
      ["P2", 4],
      ["P2", 6],
    ] as const) {
      put(entry(`w${createdAt}`, { priority, createdAt }));
    }
    for (const due of [60, 10, 50, 20, 40, 30]) put(entry(`c${due}`, { kind: "commitment", due }));
    for (let n = 0; n < 7; n++)
      put(entry(`watch${n}`, { kind: "watch", status: n === 6 ? "blocked" : "active" }));
    put(entry("watch-done", { kind: "watch", status: "done" }));
    put(entry("incoming", { kind: "incoming" }));
    put(entry("incoming-done", { kind: "incoming", status: "done" }));
    put(entry("waiting-work", { status: "waiting", priority: "P0" }));
    store.setFlightBriefSection({
      sessionId: "s1",
      section: FLIGHT_HEADLINE,
      text: "H",
      updatedAt: NOW,
      updatedBy: "flight-1",
    });
    const summary = (await get("/api/flight/summary")).json<FlightSummaryView>();
    expect(summary.session).toBe("s1");
    expect(summary.headline).toBe("H");
    expect(summary.now.map((e) => e.key)).toEqual(["w2", "w5", "w3", "w1", "w4"]);
    expect(summary.next.map((e) => e.due)).toEqual([10, 20, 30, 40, 50]);
    expect(summary.watching.top).toHaveLength(5);
    expect(summary.watching.top[0]?.key).toBe("watch6");
    expect(summary.watching.counts).toEqual({
      active: 6,
      waiting: 0,
      blocked: 1,
      done: 1,
      dropped: 0,
    });
    expect(summary.incoming).toBe(1);
    expect((await get("/api/flight/ledger")).json().entries).toHaveLength(22);
    const first = (await get("/api/flight/ledger?limit=2")).json();
    expect(first.entries.map((e: FlightLedgerEntry) => e.key)).toEqual(["waiting-work", "w2"]);
    expect(first).toMatchObject({ more: true, nextOffset: 2 });
    expect(
      (await get(`/api/flight/ledger?limit=2&offset=${first.nextOffset}`))
        .json()
        .entries.map((e: FlightLedgerEntry) => e.key),
    ).toEqual(["w5", "w3"]);
    expect((await get("/api/flight/ledger?status=all")).json().entries).toHaveLength(24);
    expect((await get("/api/flight/ledger?kind=watch&status=done")).json().entries[0]?.key).toBe(
      "watch-done",
    );
    for (const query of [`limit=${FLIGHT_LIST_MAX + 1}`, "offset=-1", "offset=nope", "status=bad"])
      expect((await get(`/api/flight/ledger?${query}`)).statusCode).toBe(400);
  });
});

describe("overview", () => {
  it("limits the All pipeline to repos with crew sessions", async () => {
    for (const repoId of ["shop-app", "site-builder"])
      store.upsertRun(run({ id: repoId, repoId, ticket: `${repoId}#1`, loop: { ...NEW_LOOP } }));
    expect((await get("/api/overview")).json().kpis.inFlight.count).toBe(0);
    withCrew();
    const result = (await get("/api/overview")).json();
    expect(result.kpis.inFlight.count).toBe(1);
    expect(
      result.pipeline
        .flatMap((p: { cards: { repoId: string }[] }) => p.cards)
        .map((c: { repoId: string }) => c.repoId),
    ).toEqual(["shop-app"]);
  });

  it("shares crew across crew, attention and Overview, expiring at the next two-second bucket", async () => {
    const reads = vi.spyOn(store, "asideRuns");
    clock = Math.floor(clock / 2_000) * 2_000;
    await get("/api/crew");
    expect(reads).toHaveBeenCalledTimes(1);
    await get("/api/attention");
    await get("/api/overview");
    expect(reads).toHaveBeenCalledTimes(1);
    clock += 1_999;
    bus.emit("machine");
    await get("/api/crew");
    expect(reads).toHaveBeenCalledTimes(1);
    clock++;
    await get("/api/crew");
    expect(reads).toHaveBeenCalledTimes(2);
    reads.mockRestore();
  });

  it.each(TOPICS.filter((topic) => topic !== "machine"))(
    "invalidates shared crew on %s",
    async (topic) => {
      const reads = vi.spyOn(store, "asideRuns");
      await get("/api/crew");
      bus.emit(topic);
      await get("/api/overview");
      await get("/api/crew");
      expect(reads).toHaveBeenCalledTimes(2);
      reads.mockRestore();
    },
  );

  it("rebuilds shared crew when the configured selection changes", async () => {
    await get("/api/crew");
    withCrew();
    expect((await get("/api/crew")).json<Crew>().rows.some((row) => row.id === "guido-1")).toBe(
      true,
    );
  });

  it("shares attention for two seconds and invalidates on non-machine topics", async () => {
    const reads = vi.spyOn(store, "acks");
    await get("/api/overview");
    const initial = reads.mock.calls.length;
    expect(initial).toBeGreaterThan(0);
    clock += 1_999;
    await get("/api/attention");
    bus.emit("machine");
    await get("/api/overview");
    expect(reads).toHaveBeenCalledTimes(initial);
    clock++;
    await get("/api/overview");
    expect(reads).toHaveBeenCalledTimes(initial + 1);
    bus.emit("boards");
    await get("/api/overview");
    expect(reads).toHaveBeenCalledTimes(initial + 2);
    reads.mockRestore();
  });

  it("scopes seats by session even when sessions share a repo", async () => {
    withCrew();
    const first = config.crew?.sessions[0];
    const seat = first?.seats[0];
    if (!first || !seat) throw new Error("missing crew fixture");
    config.crew?.sessions.push({
      ...first,
      id: "s2",
      seats: [{ ...seat, id: "guido-2" }],
    });
    store.addAgentEvent({ agentId: "guido-2", at: NOW, from: "idle", to: "running", text: "turn" });
    expect((await get("/api/overview?session=s1")).json().kpis.working).toMatchObject({
      now: 0,
      of: 1,
    });
    expect((await get("/api/overview?session=s2")).json().kpis.working).toMatchObject({
      now: 1,
      of: 1,
    });
    expect((await get("/api/overview")).json().kpis.working).toMatchObject({ now: 1, of: 2 });
  });

  it("serves live figures and validates the selected session", async () => {
    withCrew();
    store.raiseNote({
      key: "overview-question",
      kind: "question",
      runId: null,
      seatId: "guido-1",
      repoId: "shop-app",
      text: "Choose",
      at: NOW - 2 * HOUR,
    });
    const first = await get("/api/overview?session=s1");
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      at: NOW,
      kpis: { working: { now: 0, of: 1 }, needsYou: { count: 1, overHour: 1 } },
    });
    store.addAgentEvent({ agentId: "guido-1", at: NOW, from: "idle", to: "running", text: "turn" });
    expect((await get("/api/overview?session=s1")).json().kpis.working.now).toBe(1);
    expect((await get("/api/overview?session=missing")).statusCode).toBe(404);
    expect((await get("/api/overview")).statusCode).toBe(200);
  });
});

it("bounds tag text in attention and reads the whole message on open", async () => {
  const text = `@CAPCOM ${"x".repeat(1000)}`;
  store.addComms({ at: NOW, from: "shop-app-ta", to: "CAPCOM", ticket: null, text });
  const items = (await get("/api/attention")).json<AttentionItem[]>();
  const tag = items.find((i) => i.kind === "tag");
  expect(tag).toBeDefined();
  expect(tag?.text.length).toBeLessThanOrEqual(170);
  const full = await get(`/api/attention/${encodeURIComponent(tag?.key ?? "")}`);
  expect(full.statusCode).toBe(200);
  expect(full.json().text).toBe(text);
  expect((await get("/api/attention/unknown")).statusCode).toBe(404);
});
it("labels the test lock route's holder and waiting entries", async () => {
  const state = {
    holder: { runId: "h", seatId: "a", command: "make check", since: NOW },
    waiting: [{ runId: "w", seatId: "b", command: "make verify", since: NOW }],
  };
  const a = buildApp({ config, store, bus, now: () => NOW, lock: { state: () => state } as never });
  try {
    const view = (await a.inject("/api/test-lock")).json();
    expect(view.holder.label).toBe("make check");
    expect(view.waiting[0].label).toBe("make verify");
  } finally {
    await a.close();
  }
});
