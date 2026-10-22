import {
  type FlightMoveColumn,
  type MoveColumn,
  optionForColumn,
  type RepoId,
  STATUS_FIELD,
} from "@mc/core";
import { type Gql, GqlError, isObj, isTransient } from "./collectors/github.ts";
import type { CcConfig } from "./config.ts";
import { readStatusField } from "./github-setup.ts";
import type { Store } from "./store.ts";

/** Project, field and option ids are read again after this long. */
export const BOARD_IDS_TTL_MS = 60 * 60_000;

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
          status: fieldValueByName(name: "${STATUS_FIELD}") { ... on ProjectV2ItemFieldSingleSelectValue { optionId } }
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
  column: MoveColumn | FlightMoveColumn;
}

export type MoveResult = { ok: true; changed: boolean } | { ok: false; reason: string };

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
