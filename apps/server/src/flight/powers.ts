/**
 * FLIGHT's controller powers (#1015): `edit_issue` (a whole body or title) and `set_fields` (board
 * and issue fields). Each is a superuser-gated tool (`superTool`) that logs a decision, and stops at
 * the safety floor: `always_ask` and other lanes' tickets, the Controller check section, a ticket
 * with a live run, and promote's rules for Ready and Backlog. Guard, sandbox, hard-rule paths, CI
 * workflows and the CLAUDE.md block still need the operator.
 */
import {
  AWAY_WRITES_REFUSED,
  type BoardItem,
  FLIGHT_HOUR_MS,
  FLIGHT_PROMOTES_PER_HOUR,
  type FlightDecision,
  type FlightDecisionKind,
  LANE_LABEL_PREFIX,
  MC_TOOL_NAMES,
  PRIORITIES,
  type RepoRules,
  TICKET_SIZES,
  ticketControllerCheck,
} from "@mc/core";
import { z } from "zod";
import { activeAway } from "../away.ts";
import { TICKET_BODY_MAX } from "../collectors/github.ts";
import type { CcConfig } from "../config.ts";
import type { McTool, McToolContext, McToolResult } from "../mcp/server.ts";
import { readKnown } from "../mcp/tools.ts";
import { crewDir } from "../store.ts";
import type { FlightToolsDeps } from "./tools.ts";

type Result = McToolResult;

/** What the power tools take from `createFlightTools`' closure. */
export interface PowerHelpers {
  deps: FlightToolsDeps;
  now: () => number;
  fail: (text: string) => Result;
  repoOf: () => CcConfig["repos"][number] | undefined;
  cardProblem: (card: BoardItem, rules: RepoRules) => string | null;
  labelProblem: (label: string) => string | null;
  textProblem: (
    ctx: McToolContext,
    tool: string,
    github: string,
    issue: number | null,
    texts: readonly { label: string; text: string }[],
    known: readonly string[],
  ) => Promise<string | null>;
  record: (
    at: number,
    d: Pick<FlightDecision, "kind" | "about" | "decision" | "basis"> &
      Partial<Pick<FlightDecision, "seatId" | "targetRunId" | "ref" | "questionId">>,
  ) => unknown;
  superTool: (
    name: McTool["name"],
    description: string,
    schema: z.ZodType<{ basis: string }>,
    kind: FlightDecisionKind,
    act: (args: never, repo: CcConfig["repos"][number], ctx: McToolContext) => Promise<Result>,
    options?: { engine?: boolean; records?: boolean },
  ) => McTool;
}

const basis = z.string().min(1).max(500);
const issueNumber = z.number().int().min(1).max(9_999_999);

export function createPowerTools(h: PowerHelpers): McTool[] {
  const { deps, now, fail } = h;
  const { config, store, bus } = deps;
  const away = () => activeAway(store, now(), config.operator.timezone);

  const tools: McTool[] = [];
  const add = (
    name: string,
    description: string,
    schema: z.ZodType<{ basis: string }>,
    kind: FlightDecisionKind,
    act: (a: never, repo: CcConfig["repos"][number], ctx: McToolContext) => Promise<Result>,
    options?: { engine?: boolean },
  ) => tools.push(h.superTool(name, description, schema, kind, act, options));

  // ---- issues and board fields ----
  /** The card as the project holds it now; never the cache, which may predate a protective label. */
  const liveCard = async (repoId: string, issue: number): Promise<BoardItem | undefined> =>
    (await deps.board.read?.(repoId, issue).catch(() => null)) ?? undefined;
  /** The card's floor refusals (always_ask, another lane), or null. */
  const floor = async (repoId: string, issue: number): Promise<BoardItem | Result> => {
    const card = await liveCard(repoId, issue);
    if (!card)
      return fail("Refused: the card could not be read live, so its labels are unchecked.");
    const rules = await deps.rules(repoId);
    if (rules instanceof Error) return fail("Cannot read repo rules.");
    const problem = h.cardProblem(card, rules);
    return problem === null ? card : fail(`Refused: ${problem}.`);
  };
  const isRefusal = (x: BoardItem | Result): x is Result => "text" in x;
  const ghWrite = async (
    args: string[],
    input?: string,
  ): Promise<{ ok: boolean; stdout: string }> => {
    const r = await deps.gh(args, {
      cwd: crewDir(deps.dbPath),
      ...(input === undefined ? {} : { input }),
    });
    return { ok: r.code === 0, stdout: r.stdout };
  };
  const stateOf = async (repo: CcConfig["repos"][number], issue: number) => {
    try {
      return await deps.fetchTicket(repo, issue);
    } catch {
      return null;
    }
  };

  const EditIssueArgs = z.strictObject({
    issue: issueNumber,
    body: z.string().min(1).max(TICKET_BODY_MAX).optional(),
    title: z.string().min(1).max(200).optional(),
    basis,
  });
  add(
    MC_TOOL_NAMES.editIssue,
    "Replace an issue's whole body and/or title. Read the ticket first and send the full new body. always_ask and other lanes' tickets are refused. It is posted to GitHub: no @mentions, no secrets.",
    EditIssueArgs,
    "issue",
    async (a: z.output<typeof EditIssueArgs>, repo, ctx) => {
      if (a.body === undefined && a.title === undefined) return fail("Give a body or a title.");
      const ref = `${repo.id}#${a.issue}`;
      const found = await floor(repo.id, a.issue);
      if (isRefusal(found)) return found;
      if (store.activeTickets().has(ref)) return fail(`${ref} has a live run: end it first.`);
      const known = await readKnown(deps, "edit_issue");
      const unfit = await h.textProblem(
        ctx,
        "edit_issue",
        repo.github,
        a.issue,
        [
          ...(a.body === undefined ? [] : [{ label: "body", text: a.body }]),
          ...(a.title === undefined ? [] : [{ label: "title", text: a.title }]),
        ],
        known,
      );
      if (unfit !== null) return fail(unfit);
      if (a.body !== undefined) {
        // the Controller check section is the controller's: FLIGHT may add an item (add_controller_check)
        // but a whole-body edit may not drop or change it, and an unreadable ticket is not edited
        const current = await stateOf(repo, a.issue);
        if (current === null || current.bodyTruncated)
          return fail("Refused: the ticket's current body could not be read whole.");
        if (
          ticketControllerCheck(current) !==
          ticketControllerCheck({ body: a.body, bodyTruncated: false })
        )
          return fail(
            "The Controller check section is the controller's; use add_controller_check to add an item.",
          );
      }
      if (away()) return fail(AWAY_WRITES_REFUSED);
      // the body goes in on stdin: an argument has a size limit and shows in process lists
      const r = await ghWrite(
        [
          "issue",
          "edit",
          String(a.issue),
          `--repo=${repo.github}`,
          ...(a.body === undefined ? [] : ["--body-file=-"]),
          ...(a.title === undefined ? [] : [`--title=${a.title}`]),
        ],
        a.body,
      );
      if (!r.ok) return fail("GitHub refused the edit; read the ticket before retrying.");
      const after = await stateOf(repo, a.issue);
      // exit 0 is not proof: the live ticket must show every part that was asked for
      if (
        after === null ||
        (a.body !== undefined && after.body !== a.body) ||
        (a.title !== undefined && after.title !== a.title)
      )
        return fail("The edit could not be confirmed on GitHub; read the ticket.");
      bus.emit("boards");
      return { text: `Edited ${ref}.` };
    },
  );

  const SetFieldsArgs = z.strictObject({
    issue: issueNumber,
    status: z.literal("Blocked").optional(),
    priority: z.enum(PRIORITIES).optional(),
    size: z.enum(TICKET_SIZES).optional(),
    labels: z.array(z.string().min(1).max(100)).max(100).optional(),
    milestone: z.string().min(1).max(200).nullable().optional(),
    basis,
  });
  add(
    MC_TOOL_NAMES.setFields,
    "Set an issue's board and issue fields in one call: status (a board column), priority, size, labels (the whole list) and milestone (a title, or null to clear). always_ask and other lanes' tickets are refused.",
    SetFieldsArgs,
    "card",
    async (a: z.output<typeof SetFieldsArgs>, repo, ctx) => {
      if (repo.autonomy !== "merge")
        return fail(`${repo.id} is a draft workspace, where Mission Control moves no cards.`);
      const found = await floor(repo.id, a.issue);
      if (isRefusal(found)) return found;
      if (found.closed) return fail("The ticket is closed.");
      const ref = `${repo.id}#${a.issue}`;
      if (store.activeTickets().has(ref)) return fail(`${ref} has a live run: end it first.`);
      // a lane label moves with edit_card's lane, which checks the crew's lane; not here
      const lanes = (labels: readonly string[]) =>
        labels
          .filter((l) => l.startsWith(LANE_LABEL_PREFIX))
          .sort()
          .join(",");
      if (a.labels !== undefined && lanes(a.labels) !== lanes(found.labels))
        return fail("Lane labels change with edit_card's lane, not set_fields.");
      // only labels being added are judged: a ticket's older labels are not this call's to refuse
      if (a.labels !== undefined) {
        const had = new Set(found.labels);
        for (const l of a.labels.filter((x) => !had.has(x))) {
          const bad = h.labelProblem(l);
          if (bad !== null) return fail(bad);
        }
        const areas = (ls: readonly string[]) => ls.filter((l) => l.startsWith("area:"));
        if (
          areas(a.labels).sort().join() !== areas(found.labels).sort().join() &&
          areas(a.labels).length !== 1
        )
          return fail("A ticket carries exactly one area:* label.");
      }
      if (
        a.status !== undefined &&
        store.countFlightDecisions({
          kinds: ["promote", "reorder", "status"],
          since: now() - FLIGHT_HOUR_MS,
        }) >= FLIGHT_PROMOTES_PER_HOUR
      )
        return fail("You have moved the most tickets allowed in the last hour.");
      if (away()) return fail(AWAY_WRITES_REFUSED);
      const done: string[] = [];
      // a field that fails after others landed says which landed
      const stop = (why: string): Result =>
        fail(done.length === 0 ? why : `Set ${done.join(", ")} on ${ref}, then stopped: ${why}`);
      if (a.size !== undefined || a.priority !== undefined) {
        if (!deps.board.edit) return fail("Board edits unavailable.");
        const r = await deps.board.edit(repo.id, a.issue, {
          ...(a.size === undefined ? {} : { size: a.size }),
          ...(a.priority === undefined ? {} : { priority: a.priority }),
        });
        if (!r.ok) return stop(r.reason);
        done.push("size/priority");
      }
      if (a.status !== undefined) {
        const r = await deps.board.move({
          runId: ctx.runId,
          repoId: repo.id,
          issue: a.issue,
          column: a.status,
        });
        if (!r.ok) return stop(r.reason);
        // its own kind, counted with promote's moves against the hourly cap
        store.addFlightDecision({
          at: now(),
          kind: "status",
          seatId: null,
          targetRunId: null,
          ref,
          questionId: null,
          about: `${ref}: ${found.title}`,
          decision: `Set status to ${a.status}`,
          basis: a.basis,
        });
        done.push("status");
      }
      if (a.labels !== undefined || a.milestone !== undefined) {
        let milestone: number | null | undefined;
        if (a.milestone === null) milestone = null;
        else if (a.milestone !== undefined) {
          const list = await ghWrite([
            "api",
            `repos/${repo.github}/milestones?state=all&per_page=100`,
          ]);
          try {
            const milestones = JSON.parse(list.stdout) as { number: number; title: string }[];
            const match = milestones.find((m) => m.title === a.milestone);
            if (!list.ok || match === undefined)
              return stop(`No milestone titled "${a.milestone}".`);
            milestone = match.number;
          } catch {
            return stop("Could not read the repo's milestones.");
          }
        }
        const r = await ghWrite(
          ["api", "--method=PATCH", `repos/${repo.github}/issues/${a.issue}`, "--input=-"],
          JSON.stringify({
            ...(a.labels === undefined ? {} : { labels: a.labels }),
            ...(milestone === undefined ? {} : { milestone }),
          }),
        );
        if (!r.ok) return stop("GitHub refused the label or milestone edit.");
        done.push(a.labels !== undefined ? "labels" : "milestone");
      }
      if (done.length === 0) return fail("Give at least one field to set.");
      bus.emit("boards");
      return { text: `Set ${done.join(", ")} on ${ref}.` };
    },
  );

  return tools;
}
