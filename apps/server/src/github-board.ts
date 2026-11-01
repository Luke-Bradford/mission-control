import {
  type FlightMoveColumn,
  type HudColumn,
  hudColumnOf,
  type MoveColumn,
  optionForColumn,
  type PullRequestView,
  type RepoId,
  STATUS_FIELD,
  seatDef,
} from "@mc/core";
import { type Gql, GqlError, isObj, isTransient } from "./collectors/github.ts";
import type { CcConfig } from "./config.ts";
import { singleSelectField } from "./github-fields.ts";
import { readStatusField } from "./github-setup.ts";
import type { Store } from "./store.ts";

/** Project, field and option ids are read again after this long. */
export const BOARD_IDS_TTL_MS = 60 * 60_000;

/** A failed PR card move waits this long before another attempt. */
const PR_MOVE_BACKOFF_MS = 5 * 60_000;

type StatusIds = Awaited<ReturnType<typeof readStatusField>>;
const ids = new Map<string, { at: number; field: StatusIds }>();

/** Forgets every cached id (tests; a new project's ids are found by the key anyway). */
export function clearBoardIds(): void {
  ids.clear();
}

// The one mutation this module sends.
const SET_STATUS = `mutation($input: UpdateProjectV2ItemFieldValueInput!) {
  updateProjectV2ItemFieldValue(input: $input) { projectV2Item { id } }
}`;

const CARD_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      projectItems(first: 20) {
        nodes {
          id
          project { id }
          ${singleSelectField("status", STATUS_FIELD, "optionId")}
        }
      }
    }
  }
}`;

export interface MoveDeps {
  gql: Gql;
  store: Store;
  config: CcConfig;
  now?: () => number;
}

export interface Move {
  runId: string;
  repoId: RepoId;
  issue: number;
  /** Any board column: the hub moves a run's card, FLIGHT promotes it or puts it back. */
  column: HudColumn;
}

export type MoveResult = { ok: true; changed: boolean } | { ok: false; reason: string };

/** The columns a card is earlier than In review in. */
const BEFORE_REVIEW: readonly HudColumn[] = [
  "Backlog",
  "Refinement",
  "Ready",
  "In progress",
  "Blocked",
];

/**
 * Moves each ticket's card to follow its closing PRs, falling back to the PR's branch-first ticket.
 * All hubs follow PRs for every lane: there is one hub per repo today.
 * An open, ready PR puts an earlier card In review; a merged closing PR puts it Done.
 * A branch-only match needs the issue itself closed. PRs all closed
 * unmerged send an In review card back to Ready. Live runs belong to the engine; planner cards
 * stay put. A successful move to a column happens once per PR, leaving later hand moves alone.
 * Each attempt is a `board_moves` row under `pr:<repo>#<number>`; failures wait five minutes.
 * True when a card moved. `moveCard` skips a card already in the target column.
 */
export async function followPrs(deps: MoveDeps, repoId: RepoId): Promise<boolean> {
  const { store, config } = deps;
  const repo = config.repos.find((r) => r.id === repoId);
  if (repo?.autonomy !== "merge") return false;
  let moved = false;
  const now = deps.now ?? Date.now;
  // The engine only gives build seats a card-moving loop; planners have no build loop.
  const nonBuilders = new Set(
    (config.crew?.sessions ?? [])
      .filter((s) => s.repoId === repoId)
      .flatMap((s) => s.seats)
      .filter((s) => seatDef(s).loop !== "build")
      .map((s) => s.id),
  );

  const byTicket = new Map<number, PullRequestView[]>();
  for (const pr of store.pullRequests(repoId)) {
    const ticket = /^(.+)#(\d+)$/.exec(pr.ticket ?? "");
    const issues = pr.closingIssues?.length
      ? pr.closingIssues
      : ticket?.[1] === repoId
        ? [Number(ticket[2])]
        : [];
    for (const issue of issues) {
      const list = byTicket.get(issue) ?? [];
      list.push(pr);
      byTicket.set(issue, list);
    }
  }
  for (const item of store.board(repoId)) {
    const prs = byTicket.get(item.issueNumber);
    const ticket = `${repoId}#${item.issueNumber}`;
    if (
      !prs ||
      store.hasLiveRunOnTicket(repoId, ticket) ||
      store.runsOnTicket(repoId, ticket).some((r) => nonBuilders.has(r.agentId))
    )
      continue;
    // Compare the project field itself; the HUD already presents a closed issue as Done.
    const column = hudColumnOf({ ...item, closed: false });
    const open =
      prs.find((p) => p.state === "open" && !p.isDraft) ?? prs.find((p) => p.state === "open");
    const merged = prs.find((p) => p.state === "merged");
    // A branch names the work it contributes to, not necessarily the whole outcome (research
    // stages and performance slices share a parent). A closing relation or a closed issue is
    // the evidence that a merged contribution completes its parent.
    const completed = item.closed
      ? (merged ?? prs[0])
      : open
        ? undefined
        : prs.find((p) => p.state === "merged" && p.closingIssues?.includes(item.issueNumber));
    let target: MoveColumn | FlightMoveColumn | null = null;
    const by = completed ?? open ?? merged ?? prs[0];
    if (completed) {
      if (column !== "Done") target = "Done";
    } else if (open) {
      if (!open.isDraft && BEFORE_REVIEW.includes(column)) target = "In review";
    } else if (!merged && column === "In review") {
      target = "Ready";
    }
    if (!target || !by) continue;
    const runId = `pr:${repoId}#${by.number}`;
    if (
      store
        .boardMovesOfRun(runId)
        .some(
          (m) =>
            m.issue === item.issueNumber &&
            m.column === target &&
            (m.state === "done" || m.state === "pending" || now() - m.at < PR_MOVE_BACKOFF_MS),
        )
    )
      continue;
    const r = await moveCard(deps, {
      runId,
      repoId,
      issue: item.issueNumber,
      column: target,
    });
    if (r.ok && r.changed) moved = true;
  }
  return moved;
}

/** The card of `issue` on project `projectId`: its item id and Status option id, or null off the project. */
async function findCard(
  gql: Gql,
  repo: CcConfig["repos"][number],
  issue: number,
  projectId: string,
): Promise<{ itemId: string; optionId: string | null } | null> {
  const [owner = "", name = ""] = repo.github.split("/");
  const data = await gql(CARD_QUERY, { owner, name, number: issue });
  const repository = isObj(data) ? data.repository : null;
  const issueNode = isObj(repository) ? repository.issue : null;
  const items =
    isObj(issueNode) && isObj(issueNode.projectItems) ? issueNode.projectItems.nodes : null;
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    if (!isObj(item) || !isObj(item.project) || item.project.id !== projectId) continue;
    if (typeof item.id !== "string") continue;
    const optionId =
      isObj(item.status) && typeof item.status.optionId === "string" ? item.status.optionId : null;
    return { itemId: item.id, optionId };
  }
  return null;
}

/**
 * Moves a run's card to a Status column. Only a `merge` repo's board is written; a `draft` repo is
 * left alone. Idempotent: a card already in the column is not touched. The attempt is recorded as
 * a `board_moves` row (pending, then done or failed); a card already there leaves no row.
 */
export async function moveCard(deps: MoveDeps, m: Move): Promise<MoveResult> {
  const { gql, store, config } = deps;
  const now = deps.now ?? Date.now;
  const repo = config.repos.find((r) => r.id === m.repoId);
  if (!repo) return { ok: false, reason: "unknown repo" };
  if (repo.autonomy !== "merge") return { ok: true, changed: false };

  const row = { runId: m.runId, repoId: m.repoId, issue: m.issue, column: m.column };
  const fail = (reason: string): MoveResult => {
    store.addBoardMove({ ...row, state: "failed", detail: reason, at: now() });
    return { ok: false, reason };
  };

  try {
    const [owner = ""] = repo.github.split("/");
    const key = `${repo.github}#${repo.project}`;
    const read = async (): Promise<StatusIds> => {
      const field = await readStatusField(gql, owner, repo.project);
      ids.set(key, { at: now(), field });
      return field;
    };
    const cached = ids.get(key);
    const fresh = cached !== undefined && now() - cached.at < BOARD_IDS_TTL_MS;
    let field = fresh ? cached.field : await read();
    const optionFor = (f: StatusIds) => {
      const name = optionForColumn(
        f.options.map((o) => o.name),
        repo.statusMap,
        m.column,
      );
      return f.options.find((o) => o.name === name) ?? null;
    };
    let option = optionFor(field);
    if (option === null && fresh) {
      // Cached ids may predate the option.
      field = await read();
      option = optionFor(field);
    }
    if (option === null) return fail(`no Status option for ${m.column}`);

    const card = await findCard(gql, repo, m.issue, field.projectId);
    if (card === null) return fail("card not on the project");
    if (card.optionId === option.id) return { ok: true, changed: false };

    const id = store.addBoardMove({ ...row, state: "pending", detail: null, at: now() });
    const inputOf = (f: StatusIds, o: { id: string }) => ({
      projectId: f.projectId,
      itemId: card.itemId,
      fieldId: f.fieldId,
      value: { singleSelectOptionId: o.id },
    });
    const send = (input: ReturnType<typeof inputOf>) => gql(SET_STATUS, { input });
    const input = inputOf(field, option);
    try {
      try {
        await send(input);
      } catch (e) {
        if (isTransient(e)) {
          // A lost request or a 5xx: once more. A 401/403/429 is final.
          await send(input);
        } else if (e instanceof GqlError) {
          // GitHub refused the ids: the field or an option may have been recreated. Read them
          // again, and send once more if they changed.
          ids.delete(key);
          field = await read();
          option = optionFor(field);
          if (option === null) throw new Error(`no Status option for ${m.column}`);
          const next = inputOf(field, option);
          if (JSON.stringify(next) === JSON.stringify(input)) throw e;
          await send(next);
        } else {
          throw e;
        }
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      store.finishBoardMove(id, "failed", reason, now());
      return { ok: false, reason };
    }
    store.finishBoardMove(id, "done", null, now());
    return { ok: true, changed: true };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/** Read-only: whether the project has each Size and Priority option asked for. Writes nothing. */
export async function checkCardFieldOptions(
  deps: Pick<MoveDeps, "gql" | "config">,
  repoId: string,
  fields: { size?: string; priority?: string },
): Promise<MoveResult> {
  const repo = deps.config.repos.find((r) => r.id === repoId);
  if (repo?.flightPowers !== "superuser") return { ok: false, reason: "Superuser required." };
  try {
    for (const [name, value] of [
      ["Size", fields.size],
      ["Priority", fields.priority],
    ] as const) {
      if (value === undefined) continue;
      const field = await readStatusField(
        deps.gql,
        repo.github.split("/")[0] ?? "",
        repo.project,
        name,
      );
      if (!field.options.some((o) => o.name === value))
        return { ok: false, reason: `No ${name} option ${value}.` };
    }
    return { ok: true, changed: false };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Size and Priority use the same project-field read and mutation as Status. */
export async function editCardFields(
  deps: MoveDeps,
  repoId: string,
  issue: number,
  fields: { size?: string; priority?: string },
): Promise<MoveResult> {
  const repo = deps.config.repos.find((r) => r.id === repoId);
  if (repo?.flightPowers !== "superuser") return { ok: false, reason: "Superuser required." };
  try {
    const edits = [];
    for (const [name, value] of [
      ["Size", fields.size],
      ["Priority", fields.priority],
    ] as const) {
      if (value === undefined) continue;
      const field = await readStatusField(
        deps.gql,
        repo.github.split("/")[0] ?? "",
        repo.project,
        name,
      );
      const option = field.options.find((o) => o.name === value);
      if (!option) return { ok: false, reason: `No ${name} option ${value}.` };
      const card = await findCard(deps.gql, repo, issue, field.projectId);
      if (!card) return { ok: false, reason: "Card not on project." };
      edits.push({
        projectId: field.projectId,
        itemId: card.itemId,
        fieldId: field.fieldId,
        value: { singleSelectOptionId: option.id },
      });
    }
    for (const input of edits) await deps.gql(SET_STATUS, { input });
    return { ok: true, changed: edits.length > 0 };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
