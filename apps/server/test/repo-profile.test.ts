import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoardItem } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectGithub, type Gql, GqlError } from "../src/collectors/github.ts";
import type { CcConfig } from "../src/config.ts";
import { PreviewError, repoPreview, repoProfiles } from "../src/repo-profile.ts";
import { Store } from "../src/store.ts";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-profile-"));
  store = new Store(join(dir, "mc.sqlite"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const config = (): CcConfig => ({
  operator: { id: "operator", timezone: "Europe/London" },
  accounts: [{ id: "claude-main", vendor: "claude", alertAt: 85, stopAt: 95 }],
  repos: [
    {
      id: "shop-app",
      github: "o/shop-app",
      project: 2,
      statusMap: { Todo: "planned", "In Progress": "in progress", Done: "done" },
      autonomy: "draft",
      needsYouLabels: ["needs-design", "needs-human"],
    },
    { id: "ae", github: "o/ae", project: 3, statusMap: { Done: "done" }, autonomy: "draft" },
  ],
  loops: [
    {
      id: "shop-app-ta",
      repoId: "shop-app",
      kind: "ta-loop",
      accountId: "claude-main",
      stateDir: join(dir, "s"),
      worktree: join(dir, "w"),
      launchdLabel: "x",
    },
  ],
  poll: { usageMinutes: 30, githubSeconds: 60 },
});

const item = (n: number, over: Partial<BoardItem> = {}): BoardItem => ({
  repoId: "shop-app",
  issueNumber: n,
  title: `t${n}`,
  status: "Todo",
  state: "planned",
  labels: [],
  priority: null,
  updatedAt: 0,
  url: "",
  stage: null,
  owner: null,
  parent: null,
  subIssues: null,
  blockedBy: [],
  milestone: null,
  size: null,
  closed: false,
  prioritySource: null,
  createdAt: 1,
  itemId: null,
  projectId: null,
  ...over,
});

describe("repoProfiles", () => {
  it("counts statuses and priority sources from stored rows and lists the repo's loops", () => {
    store.replaceBoard("shop-app", [
      item(1),
      item(2, { priority: "P1", prioritySource: "field" }),
      item(3, {
        status: "In Progress",
        state: "in progress",
        priority: "P2",
        prioritySource: "label",
      }),
      item(4, { status: "" }),
    ]);
    const [shopApp, ae] = repoProfiles(config(), store);
    expect(shopApp?.id).toBe("shop-app");
    expect(shopApp?.statuses).toEqual([
      { status: "Todo", state: "planned", column: "Ready", items: 2 },
      { status: "In Progress", state: "in progress", column: "In progress", items: 1 },
      { status: "Done", state: "done", column: "Done", items: 0 },
    ]);
    expect(shopApp?.missingColumns).toEqual(["Refinement", "Blocked", "In review", "Ready for QA"]);
    expect(shopApp?.priority).toEqual({ field: 1, label: 1, none: 2 });
    expect(shopApp?.loops).toEqual(["shop-app-ta"]);
    // 4 items, 2 labels: 60 polls * (1 + 3 + 2 + 1 + 1) = 480; flow 2 * ceil(4/20) + 4 * 4 extra timeline pages = 18.
    expect(shopApp?.budget).toEqual({
      boardPerHour: 480,
      sweepPerHour: 10,
      flowPerHour: 18,
      totalPerHour: 508,
    });
    expect(ae?.loops).toEqual([]);
    // No needsYouLabels configured: the collector's default is one label.
    expect(ae?.budget.boardPerHour).toBe(60 * (0 + 3 + 1 + 1 + 1));
  });

  it("carries projectUrl: null before a board read, the read's url after", async () => {
    expect(repoProfiles(config(), store).map((r) => r.projectUrl)).toEqual([null, null]);
    const gql: Gql = async (query) => {
      if (!query.includes("projectV2")) throw new Error("not a board read");
      return {
        repositoryOwner: {
          __typename: "User",
          projectV2: {
            id: "PVT_1",
            url: "https://github.com/users/o/projects/2",
            items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          },
        },
      };
    };
    await collectGithub(config().repos[0] as CcConfig["repos"][number], store, gql, Date.now());
    expect(repoProfiles(config(), store).map((r) => r.projectUrl)).toEqual([
      "https://github.com/users/o/projects/2",
      null,
    ]);
  });
});

type Call = { query: string; vars: Record<string, unknown> };
const project = () => ({
  title: "shop-app board",
  items: { totalCount: 250 },
  fields: {
    pageInfo: { hasNextPage: false },
    nodes: [
      { name: "Title" },
      { name: "Status", options: [{ name: "Todo" }, { name: "In Progress" }, { name: "Done" }] },
    ],
  },
});
const answer = (p: unknown, labels: string[] = [], type = "User") => ({
  repositoryOwner: { __typename: type, projectV2: p },
  repository: { labels: { nodes: labels.map((name) => ({ name })) } },
});
const gqlOf =
  (data: unknown, calls: Call[] = []): Gql =>
  async (query, vars) => {
    calls.push({ query, vars });
    return data;
  };
const failing =
  (e: Error): Gql =>
  async () => {
    throw e;
  };
const NEW = { github: "o/new", project: 4 };

describe("repoPreview", () => {
  it("reads fields, proposes a map and takes priority from a p1 label", async () => {
    store.replaceBoard("shop-app", [item(1)]);
    const calls: Call[] = [];
    const p = await repoPreview(
      gqlOf(answer(project(), ["p1", "plan"]), calls),
      NEW,
      config(),
      store,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.vars).toEqual({ owner: "o", number: 4, name: "new" });
    expect(calls[0]?.query).not.toContain("mutation");
    expect(p).toMatchObject({
      github: "o/new",
      project: 4,
      projectTitle: "shop-app board",
      items: 250,
      fields: [
        { name: "Title", options: [] },
        { name: "Status", options: ["Todo", "In Progress", "Done"] },
      ],
      statusOptions: ["Todo", "In Progress", "Done"],
      proposedStatusMap: { Todo: "planned", "In Progress": "in progress", Done: "done" },
      columns: [
        { status: "Todo", column: "Ready" },
        { status: "In Progress", column: "In progress" },
        { status: "Done", column: "Done" },
      ],
      missingColumns: ["Refinement", "Blocked", "In review", "Ready for QA"],
      priority: "labels",
      loops: [],
    });
    // New repo, default labels (1): 60 * (3 + 3 + 1 + 1 + 1) = 540, sweep 10, flow 2 * 13 + 5 * 4.
    expect(p.budget.totalPerHour).toBe(540 + 10 + 26 + 20);
    const now = repoProfiles(config(), store).reduce((n, r) => n + r.budget.totalPerHour, 0);
    expect(p.budgetNow).toBe(now);
  });

  it("prefers a Priority field, else none", async () => {
    const withField = project();
    withField.fields.nodes.push({ name: "Priority", options: [{ name: "P0" }] } as never);
    const a = await repoPreview(gqlOf(answer(withField, ["p1"])), NEW, config(), store);
    expect(a.priority).toBe("field");
    const b = await repoPreview(gqlOf(answer(project(), ["bug"])), NEW, config(), store);
    expect(b.priority).toBe("none");
  });

  it("fails closed when the fields are paged", async () => {
    const paged = { ...project(), fields: { pageInfo: { hasNextPage: true }, nodes: [] } };
    await expect(repoPreview(gqlOf(answer(paged)), NEW, config(), store)).rejects.toMatchObject({
      status: 502,
    });
  });

  it("previews an organisation's project", async () => {
    const calls: Call[] = [];
    const p = await repoPreview(
      gqlOf(answer(project(), [], "Organization"), calls),
      NEW,
      config(),
      store,
    );
    expect(p).toMatchObject({ projectTitle: "shop-app board", items: 250 });
    expect(calls[0]?.query).toContain("repositoryOwner(login:");
  });

  it("answers 404 for an unknown owner, a missing project and a missing repo", async () => {
    const loc = { github: "acme/new", project: 4 };
    const org = new GqlError(
      "github: Could not resolve to a RepositoryOwner with the login of 'acme'.",
      [{ type: "NOT_FOUND", path: ["repositoryOwner"] }],
      { repositoryOwner: null, repository: { labels: { nodes: [] } } },
    );
    const orgErr = await repoPreview(failing(org), loc, config(), store).catch((e) => e);
    expect(orgErr).toBeInstanceOf(PreviewError);
    expect(orgErr).toMatchObject({ status: 404, message: "owner acme not found" });
    // GitHub's real shape for an unknown owner: null data and no error.
    const nullOwner = await repoPreview(
      gqlOf({ repositoryOwner: null, repository: { labels: { nodes: [] } } }),
      loc,
      config(),
      store,
    ).catch((e) => e);
    expect(nullOwner).toMatchObject({ status: 404, message: "owner acme not found" });
    // GitHub's real shape: an error at repositoryOwner.projectV2 and null data, thrown by makeGql.
    const noProject = new GqlError(
      "github: Could not resolve to a ProjectV2 with the number 4.",
      [{ type: "NOT_FOUND", path: ["repositoryOwner", "projectV2"] }],
      { repositoryOwner: { projectV2: null }, repository: { labels: { nodes: [] } } },
    );
    const projErr = await repoPreview(failing(noProject), loc, config(), store).catch((e) => e);
    expect(projErr).toMatchObject({ status: 404, message: "project 4 not found for acme" });
    // Both halves missing: the project is reported first.
    const both = new GqlError(
      "github: not found",
      [
        { type: "NOT_FOUND", path: ["repositoryOwner", "projectV2"] },
        { type: "NOT_FOUND", path: ["repository"] },
      ],
      { repositoryOwner: { projectV2: null }, repository: null },
    );
    const bothErr = await repoPreview(failing(both), loc, config(), store).catch((e) => e);
    expect(bothErr).toMatchObject({ status: 404, message: "project 4 not found for acme" });
    const noRepo = new GqlError(
      "github: Could not resolve to a Repository with the name 'acme/new'.",
      [{ type: "NOT_FOUND", path: ["repository"] }],
      { repositoryOwner: { projectV2: project() }, repository: null },
    );
    const repoErr = await repoPreview(failing(noRepo), loc, config(), store).catch((e) => e);
    expect(repoErr).toMatchObject({ status: 404, message: "repository acme/new not found" });
  });

  it("answers 502 with GitHub's message for anything else", async () => {
    const err = await repoPreview(
      failing(new Error("github: HTTP 502")),
      NEW,
      config(),
      store,
    ).catch((e) => e);
    expect(err).toMatchObject({ status: 502, message: "github: HTTP 502" });
  });
});
