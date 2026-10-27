/**
 * How the configured repos' boards differ (from config and stored rows only) and what adding one
 * would mean (#26 A8). The preview reads GitHub with one query and never writes to it.
 */
import {
  githubBudget,
  hudColumnOf,
  labelPriority,
  missingColumns,
  PRIORITY_FIELD,
  proposeStatusMap,
  type RepoPreview,
  type RepoProfile,
  STATUS_FIELD,
  statusColumns,
} from "@mc/core";
import type { z } from "zod";
import {
  DEFAULT_NEEDS_YOU_LABELS,
  type Gql,
  GqlError,
  isObj,
  projectUrlOf,
} from "./collectors/github.ts";
import type { CcConfig } from "./config.ts";
import type { RepoLocation } from "./config-write.ts";
import { projectFields } from "./github-fields.ts";
import type { Store } from "./store.ts";

export function repoProfiles(config: CcConfig, store: Store): RepoProfile[] {
  return config.repos.map((repo) => {
    const items = store.board(repo.id);
    const statuses = Object.entries(repo.statusMap).map(([status, state]) => ({
      status,
      state,
      column: hudColumnOf({ status, state, closed: false }),
      items: items.filter((i) => i.status === status).length,
    }));
    return {
      id: repo.id,
      github: repo.github,
      project: repo.project,
      projectUrl: projectUrlOf(store, repo.id),
      statuses,
      missingColumns: missingColumns(repo.statusMap),
      priority: {
        field: items.filter((i) => i.prioritySource === "field").length,
        label: items.filter((i) => i.prioritySource === "label").length,
        none: items.filter((i) => i.prioritySource === null).length,
      },
      budget: githubBudget({
        items: items.length,
        needsYouLabels: (repo.needsYouLabels ?? DEFAULT_NEEDS_YOU_LABELS).length,
        githubSeconds: config.poll.githubSeconds,
      }),
      loops: config.loops.filter((l) => l.repoId === repo.id).map((l) => l.id),
    };
  });
}

/** A preview that cannot be answered: `status` is the HTTP status the route sends. */
export class PreviewError extends Error {
  readonly status: 404 | 502;
  constructor(status: 404 | 502, message: string) {
    super(message);
    this.name = "PreviewError";
    this.status = status;
  }
}

// Projects are read through repositoryOwner(login:), as the collector does, so a user's and an
// organisation's both answer: the project, its fields (single selects with their options) and the
// repo's priority-looking labels, in one request.
const PREVIEW_QUERY = `query($owner: String!, $number: Int!, $name: String!) {
  repositoryOwner(login: $owner) {
    __typename
    ... on ProjectV2Owner {
      projectV2(number: $number) {
        title
        items { totalCount }
        fields(first: 50) {
          pageInfo { hasNextPage }
          nodes {
            ${projectFields(false)}
          }
        }
      }
    }
  }
  repository(owner: $owner, name: $name) {
    labels(first: 20, query: "p") { nodes { name } }
    defaultBranchRef { name }
    workflows: object(expression: "HEAD:.github/workflows") { __typename }
  }
}`;

/** Every error's path joined by "."; null unless each one is a NOT_FOUND with a path. */
function notFoundPaths(e: GqlError): Set<string> | null {
  if (e.errors.length === 0) return null;
  const paths = new Set<string>();
  for (const err of e.errors) {
    const p = isObj(err) ? err.path : undefined;
    if (!isObj(err) || err.type !== "NOT_FOUND" || !Array.isArray(p) || p.length === 0) return null;
    paths.add(p.map(String).join("."));
  }
  return paths;
}

/** Reads the project and repo from GitHub and describes what adding them would mean. */
export async function repoPreview(
  gql: Gql,
  loc: z.infer<typeof RepoLocation>,
  config: CcConfig,
  store: Store,
): Promise<RepoPreview> {
  const [owner = "", name = ""] = loc.github.split("/");
  let data: unknown;
  try {
    data = await gql(PREVIEW_QUERY, { owner, number: loc.project, name });
  } catch (e) {
    // `repositoryOwner` alone is no such user or organisation; `repositoryOwner.projectV2` is an
    // owner without that project; `repository` is no such repo.
    const paths = e instanceof GqlError ? notFoundPaths(e) : null;
    if (paths?.has("repositoryOwner")) throw new PreviewError(404, `owner ${owner} not found`);
    if (paths?.has("repositoryOwner.projectV2")) {
      throw new PreviewError(404, `project ${loc.project} not found for ${owner}`);
    }
    if (paths?.has("repository")) throw new PreviewError(404, `repository ${loc.github} not found`);
    throw new PreviewError(502, e instanceof Error ? e.message : String(e));
  }
  if (!isObj(data)) throw new PreviewError(502, "github: unexpected response");
  if (!isObj(data.repositoryOwner)) throw new PreviewError(404, `owner ${owner} not found`);
  const p = data.repositoryOwner.projectV2;
  if (!isObj(p)) throw new PreviewError(404, `project ${loc.project} not found for ${owner}`);
  if (!isObj(data.repository)) {
    throw new PreviewError(404, `repository ${loc.github} not found`);
  }
  const defaultBranch = data.repository.defaultBranchRef;
  if (!isObj(defaultBranch) || typeof defaultBranch.name !== "string") {
    throw new PreviewError(502, `github: could not read the default branch of ${loc.github}`);
  }
  const workflows = data.repository.workflows;
  if (!isObj(workflows) || workflows.__typename !== "Tree") {
    throw new PreviewError(502, `github: no CI workflow directory on ${loc.github}`);
  }

  // Fail closed: a field this read could not see must never be mistaken for a missing one.
  const f = p.fields;
  if (
    !isObj(f) ||
    !Array.isArray(f.nodes) ||
    !isObj(f.pageInfo) ||
    f.pageInfo.hasNextPage !== false
  ) {
    throw new PreviewError(502, `github: could not read all fields of project ${loc.project}`);
  }
  const fields: { name: string; options: string[] }[] = [];
  let hasPriorityField = false;
  for (const n of f.nodes as unknown[]) {
    if (!isObj(n) || typeof n.name !== "string") continue;
    const single = Array.isArray(n.options);
    const options = single
      ? (n.options as unknown[]).flatMap((o) =>
          isObj(o) && typeof o.name === "string" ? [o.name] : [],
        )
      : [];
    fields.push({ name: n.name, options });
    if (single && n.name === PRIORITY_FIELD) hasPriorityField = true;
  }
  const statusOptions = fields.find((x) => x.name === STATUS_FIELD)?.options ?? [];
  const proposedStatusMap = proposeStatusMap(statusOptions);

  const labelNodes = isObj(data.repository.labels) ? data.repository.labels.nodes : null;
  const labels = Array.isArray(labelNodes)
    ? labelNodes.flatMap((l) => (isObj(l) && typeof l.name === "string" ? [l.name] : []))
    : [];
  const totalCount = isObj(p.items) ? p.items.totalCount : null;
  const items = typeof totalCount === "number" ? totalCount : 0;

  const githubSeconds = config.poll.githubSeconds;
  const budgetNow = repoProfiles(config, store).reduce((n, r) => n + r.budget.totalPerHour, 0);
  return {
    github: loc.github,
    project: loc.project,
    projectTitle: typeof p.title === "string" ? p.title : "",
    items,
    fields,
    statusOptions,
    proposedStatusMap,
    columns: statusColumns(proposedStatusMap),
    missingColumns: missingColumns(proposedStatusMap),
    priority: hasPriorityField ? "field" : labelPriority(labels) !== null ? "labels" : "none",
    budget: githubBudget({
      items,
      needsYouLabels: DEFAULT_NEEDS_YOU_LABELS.length,
      githubSeconds,
    }),
    budgetNow,
    loops: [],
  };
}
