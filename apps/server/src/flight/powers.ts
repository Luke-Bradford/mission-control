/**
 * FLIGHT's controller powers (#1015): the crew pause, seat resumes, withdrawing a decision, the
 * issue and board-field writes, and the hub's engine and Update. Each is a superuser-gated tool
 * (`superTool`), a visible decision in the log, and stops at the safety floor: guard, sandbox,
 * hard-rule paths, `always_ask`, CI workflows and the CLAUDE.md block still need the operator.
 */
import {
  AWAY_WRITES_REFUSED,
  type BoardItem,
  ENGINE_TICK_MS,
  FLIGHT_MOVE_COLUMNS,
  FLIGHT_SILENT_TICKS,
  type FlightDecisionKind,
  MC_TOOL_NAMES,
  MOVE_COLUMNS,
  PRIORITIES,
  type RepoRules,
  TICKET_SIZES,
} from "@mc/core";
import { z } from "zod";
import { activeAway } from "../away.ts";
import { type CcConfig, configuredAgents } from "../config.ts";
import { readCrewPause, writeCrewPause } from "../crew-pause.ts";
import type { McTool, McToolContext, McToolResult } from "../mcp/server.ts";
import { readKnown } from "../mcp/tools.ts";
import { crewDir } from "../store.ts";
import type { Updater } from "../update.ts";
import { loopHeartbeat } from "./signals.ts";
import type { FlightToolsDeps } from "./tools.ts";

type Result = McToolResult;

/** What the power tools take from `createFlightTools`' closure. */
export interface PowerHelpers {
  deps: FlightToolsDeps;
  now: () => number;
  fail: (text: string) => Result;
  repoOf: () => CcConfig["repos"][number] | undefined;
  cardProblem: (card: BoardItem, rules: RepoRules) => string | null;
  textProblem: (
    ctx: McToolContext,
    tool: string,
    github: string,
    issue: number | null,
    texts: readonly { label: string; text: string }[],
    known: readonly string[],
  ) => Promise<string | null>;
  superTool: (
    name: McTool["name"],
    description: string,
    schema: z.ZodType<{ basis: string }>,
    kind: FlightDecisionKind,
    act: (args: never, repo: CcConfig["repos"][number], ctx: McToolContext) => Promise<Result>,
    options?: { engine?: boolean },
  ) => McTool;
}

const RESTARTED_ENGINE_TEXT = "Restarted the loop engine.";
const RESTART_ENGINE_GAP_MS = 10 * 60_000;
const basis = z.string().min(1).max(500);
const issueNumber = z.number().int().min(1).max(9_999_999);
const PauseSeats = z.union([z.literal("all"), z.array(z.string().min(1).max(40)).min(1).max(50)]);

/** The tools' names, for the Away allowlist (none of them is a GitHub write from an Away stance). */
export const POWER_LOCAL_TOOLS: readonly string[] = [
  MC_TOOL_NAMES.setCrewPause,
  MC_TOOL_NAMES.liftCrewPause,
  MC_TOOL_NAMES.resumeSeat,
  MC_TOOL_NAMES.withdrawDecision,
  MC_TOOL_NAMES.restartEngine,
];

export function createPowerTools(h: PowerHelpers): McTool[] {
  const { deps, now, fail } = h;
  const { config, store, bus } = deps;
  const away = () => activeAway(store, now(), config.operator.timezone);

  const crewIds = () =>
    configuredAgents(config)
      .filter((a) => a.kind === "crew")
      .map((a) => a.id);

  const tools: McTool[] = [];
  const add = (
    name: string,
    description: string,
    schema: z.ZodType<{ basis: string }>,
    kind: FlightDecisionKind,
    act: (a: never, repo: CcConfig["repos"][number], ctx: McToolContext) => Promise<Result>,
    options?: { engine?: boolean },
  ) => tools.push(h.superTool(name, description, schema, kind, act, options));

  // ---- the crew pause and seats ----
  const SetPauseArgs = z.strictObject({ seats: PauseSeats, reason: basis, basis });
  add(
    MC_TOOL_NAMES.setCrewPause,
    'Pause the crew (seats: "all") or named seats: no new starts or messages reach them until you lift it. The pause record names FLIGHT.',
    SetPauseArgs,
    "pause",
    async (a: z.output<typeof SetPauseArgs>) => {
      const known = crewIds();
      if (Array.isArray(a.seats) && a.seats.some((id) => !known.includes(id)))
        return fail("Unknown seat in the pause.");
      writeCrewPause(store, { seats: a.seats, reason: a.reason, at: now(), by: "FLIGHT" }, now());
      bus.emit("settings");
      bus.emit("agents");
      return {
        text: `Paused ${a.seats === "all" ? "the crew" : a.seats.join(", ")}: ${a.reason}.`,
      };
    },
    { engine: false },
  );
  const LiftPauseArgs = z.strictObject({ basis });
  add(
    MC_TOOL_NAMES.liftCrewPause,
    "Lift the crew pause, whoever set it.",
    LiftPauseArgs,
    "pause",
    async () => {
      const pause = readCrewPause(store);
      if (pause === null) return fail("The crew is not paused.");
      writeCrewPause(store, null, now());
      bus.emit("settings");
      bus.emit("agents");
      return { text: `Lifted the crew pause set by ${pause.by} (${pause.reason}).` };
    },
    { engine: false },
  );

  const ResumeSeatArgs = z.strictObject({ seat: z.string().min(1).max(40), basis });
  add(
    MC_TOOL_NAMES.resumeSeat,
    "Resume a seat the operator stopped or a crew pause holds: it goes back in rotation, is let out of the pause, and its unfinished run is resumed. basis says why.",
    ResumeSeatArgs,
    "pause",
    async (a: z.output<typeof ResumeSeatArgs>) => {
      const cfg = configuredAgents(config).find((x) => x.kind === "crew" && x.id === a.seat);
      if (cfg === undefined) return fail(`${a.seat} is not a crew seat.`);
      const at = now();
      const done: string[] = [];
      const pause = readCrewPause(store);
      if (pause !== null && (pause.seats === "all" || pause.seats.includes(a.seat))) {
        const rest = (pause.seats === "all" ? crewIds() : pause.seats).filter(
          (id) => id !== a.seat,
        );
        writeCrewPause(
          store,
          rest.length === 0 ? null : { seats: rest, reason: pause.reason, at, by: "FLIGHT" },
          at,
        );
        done.push("lifted its pause");
      }
      const row = store.seatSession(a.seat);
      if (row?.state === "stopped" && row.runId === null) {
        store.setSeatSession({ ...row, state: "idle", reason: null, updatedAt: at });
        done.push("took it off the operator's stop");
      }
      const run = row?.runId == null ? null : store.run(row.runId);
      if (
        run !== null &&
        run.endedAt === null &&
        row !== null &&
        !deps.supervisor.busy().some((b) => b.seatId === a.seat) &&
        row.state !== "running" &&
        deps.supervisor.resumeRun !== undefined
      ) {
        try {
          await deps.supervisor.resumeRun(run.id);
          done.push("resumed its run");
        } catch (e) {
          return fail(
            `Could not resume ${a.seat}'s run: ${e instanceof Error ? e.message : "failed"}`,
          );
        }
      }
      if (done.length === 0)
        return fail(`${a.seat} is neither stopped, paused nor waiting to resume.`);
      bus.emit("settings");
      bus.emit("agents");
      return { text: `Resumed ${a.seat}: ${done.join(", ")}.` };
    },
    { engine: false },
  );

  // ---- the decision log ----
  const WithdrawArgs = z.strictObject({ id: z.number().int().min(1), basis });
  add(
    MC_TOOL_NAMES.withdrawDecision,
    "Withdraw one of your own logged decisions that was a mistake (by its id from flight_state's recent list); the log keeps a line saying so.",
    WithdrawArgs,
    "withdraw",
    async (a: z.output<typeof WithdrawArgs>) => {
      const gone = store.withdrawFlightDecision(a.id);
      if (gone === null) return fail("No such decision.");
      bus.emit("flight");
      return { text: `Withdrew decision ${a.id} (${gone.kind}: ${gone.about}).` };
    },
    { engine: false },
  );

  // ---- issues and board fields ----
  const liveCard = async (repoId: string, issue: number): Promise<BoardItem | undefined> =>
    (await deps.board.read?.(repoId, issue).catch(() => null)) ??
    store.board(repoId).find((c) => c.issueNumber === issue);
  /** The card's floor refusals (always_ask, another lane), or null. */
  const floor = async (repoId: string, issue: number): Promise<string | Result> => {
    const card = await liveCard(repoId, issue);
    if (!card) return fail("The issue is not on this repo's board.");
    const rules = await deps.rules(repoId);
    if (rules instanceof Error) return fail("Cannot read repo rules.");
    const problem = h.cardProblem(card, rules);
    return problem === null ? card.title : fail(`Refused: ${problem}.`);
  };
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

  const CloseIssueArgs = z.strictObject({
    issue: issueNumber,
    reason: z.enum(["completed", "not-planned"]).default("completed"),
    comment: z.string().min(1).max(2000).optional(),
    basis,
  });
  add(
    MC_TOOL_NAMES.closeIssue,
    "Close any issue of your repo (completed or not planned), with an optional comment. always_ask and other lanes' tickets are refused. It is posted to GitHub: no @mentions, no secrets.",
    CloseIssueArgs,
    "issue",
    async (a: z.output<typeof CloseIssueArgs>, repo, ctx) => {
      const ref = `${repo.id}#${a.issue}`;
      const title = await floor(repo.id, a.issue);
      if (typeof title !== "string") return title;
      if (store.activeTickets().has(ref)) return fail(`${ref} has a live run: end it first.`);
      const known = await readKnown(deps, "close_issue");
      const unfit = await h.textProblem(
        ctx,
        "close_issue",
        repo.github,
        a.issue,
        [{ label: "comment", text: a.comment ?? "" }].filter((t) => t.text !== ""),
        known,
      );
      if (unfit !== null) return fail(unfit);
      if (away()) return fail(AWAY_WRITES_REFUSED);
      const r = await ghWrite([
        "issue",
        "close",
        String(a.issue),
        `--repo=${repo.github}`,
        `--reason=${a.reason === "completed" ? "completed" : "not planned"}`,
        ...(a.comment === undefined ? [] : [`--comment=${a.comment}`]),
      ]);
      const after = await stateOf(repo, a.issue);
      if (after?.state !== "closed")
        return fail(
          r.ok ? "GitHub did not confirm the close; read the ticket." : "GitHub refused the close.",
        );
      bus.emit("boards");
      return { text: `Closed ${ref}: ${title} (${a.reason}).` };
    },
  );

  const ReopenIssueArgs = z.strictObject({
    issue: issueNumber,
    comment: z.string().min(1).max(2000).optional(),
    basis,
  });
  add(
    MC_TOOL_NAMES.reopenIssue,
    "Reopen a closed issue of your repo, with an optional comment. always_ask and other lanes' tickets are refused.",
    ReopenIssueArgs,
    "issue",
    async (a: z.output<typeof ReopenIssueArgs>, repo, ctx) => {
      const ref = `${repo.id}#${a.issue}`;
      const title = await floor(repo.id, a.issue);
      if (typeof title !== "string") return title;
      const known = await readKnown(deps, "reopen_issue");
      const unfit = await h.textProblem(
        ctx,
        "reopen_issue",
        repo.github,
        a.issue,
        [{ label: "comment", text: a.comment ?? "" }].filter((t) => t.text !== ""),
        known,
      );
      if (unfit !== null) return fail(unfit);
      if (away()) return fail(AWAY_WRITES_REFUSED);
      const r = await ghWrite([
        "issue",
        "reopen",
        String(a.issue),
        `--repo=${repo.github}`,
        ...(a.comment === undefined ? [] : [`--comment=${a.comment}`]),
      ]);
      const after = await stateOf(repo, a.issue);
      if (after?.state !== "open")
        return fail(
          r.ok
            ? "GitHub did not confirm the reopen; read the ticket."
            : "GitHub refused the reopen.",
        );
      bus.emit("boards");
      return { text: `Reopened ${ref}: ${title}.` };
    },
  );

  const EditIssueArgs = z.strictObject({
    issue: issueNumber,
    body: z.string().min(1).max(60_000).optional(),
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
      const title = await floor(repo.id, a.issue);
      if (typeof title !== "string") return title;
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
      if (away()) return fail(AWAY_WRITES_REFUSED);
      const r = await ghWrite([
        "issue",
        "edit",
        String(a.issue),
        `--repo=${repo.github}`,
        ...(a.body === undefined ? [] : [`--body=${a.body}`]),
        ...(a.title === undefined ? [] : [`--title=${a.title}`]),
      ]);
      if (!r.ok) return fail("GitHub refused the edit; read the ticket before retrying.");
      const after = await stateOf(repo, a.issue);
      if (a.body !== undefined && after !== null && after.body !== a.body)
        return fail("The edit could not be confirmed on GitHub; read the ticket.");
      bus.emit("boards");
      return { text: `Edited ${ref}.` };
    },
  );

  const SetFieldsArgs = z.strictObject({
    issue: issueNumber,
    status: z.enum([...FLIGHT_MOVE_COLUMNS, ...MOVE_COLUMNS]).optional(),
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
    async (a: z.output<typeof SetFieldsArgs>, repo) => {
      const title = await floor(repo.id, a.issue);
      if (typeof title !== "string") return title;
      if (away()) return fail(AWAY_WRITES_REFUSED);
      const done: string[] = [];
      if (a.size !== undefined || a.priority !== undefined) {
        if (!deps.board.edit) return fail("Board edits unavailable.");
        const r = await deps.board.edit(repo.id, a.issue, {
          ...(a.size === undefined ? {} : { size: a.size }),
          ...(a.priority === undefined ? {} : { priority: a.priority }),
        });
        if (!r.ok) return fail(r.reason);
        done.push("size/priority");
      }
      if (a.status !== undefined) {
        const r = await deps.board.move({
          runId: "flight",
          repoId: repo.id,
          issue: a.issue,
          column: a.status,
        });
        if (!r.ok) return fail(r.reason);
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
            const found = (JSON.parse(list.stdout) as { number: number; title: string }[]).find(
              (m) => m.title === a.milestone,
            );
            if (!list.ok || found === undefined)
              return fail(`No milestone titled "${a.milestone}".`);
            milestone = found.number;
          } catch {
            return fail("Could not read the repo's milestones.");
          }
        }
        const r = await ghWrite(
          ["api", "--method=PATCH", `repos/${repo.github}/issues/${a.issue}`, "--input=-"],
          JSON.stringify({
            ...(a.labels === undefined ? {} : { labels: a.labels }),
            ...(milestone === undefined ? {} : { milestone }),
          }),
        );
        if (!r.ok) return fail("GitHub refused the label or milestone edit.");
        done.push(a.labels !== undefined ? "labels" : "milestone");
      }
      if (done.length === 0) return fail("Give at least one field to set.");
      bus.emit("boards");
      return { text: `Set ${done.join(", ")} on ${repo.id}#${a.issue}.` };
    },
  );

  // ---- the hub ----
  const RestartEngineArgs = z.strictObject({ basis });
  add(
    MC_TOOL_NAMES.restartEngine,
    `Restart the loop engine when it has been silent for more than ${FLIGHT_SILENT_TICKS} of its ticks (no tick completed). Refused while it is ticking; once per ${RESTART_ENGINE_GAP_MS / 60_000} minutes.`,
    RestartEngineArgs,
    "hub",
    async () => {
      if (deps.restartEngine === undefined) return fail("The engine cannot be restarted here.");
      const beat = loopHeartbeat(store, "engine");
      const at = now();
      if (
        beat === null ||
        at - beat.at < FLIGHT_SILENT_TICKS * Math.max(beat.interval, ENGINE_TICK_MS)
      )
        return fail("The engine is not silent: a tick completed within its last two intervals.");
      const recent = store
        .flightDecisions(at - RESTART_ENGINE_GAP_MS, 1000)
        .filter(
          (d) =>
            d.kind === "hub" &&
            d.about === MC_TOOL_NAMES.restartEngine &&
            d.decision === RESTARTED_ENGINE_TEXT,
        );
      if (recent.length > 0) return fail("The engine was restarted in the last ten minutes.");
      await deps.restartEngine();
      return { text: RESTARTED_ENGINE_TEXT };
    },
    { engine: false },
  );

  const UpdateHubArgs = z.strictObject({ basis });
  add(
    MC_TOOL_NAMES.updateHub,
    "Run Update after merges you cleared: every commit between the running code and main must be a PR you cleared with merge_pr. The existing Update checks (on main, clean checkout, no seat starting, build) apply, and the hub restarts when it succeeds.",
    UpdateHubArgs,
    "hub",
    async () => {
      const updater: Pick<Updater, "changes" | "update" | "restart"> | undefined = deps.updater?.();
      if (updater === undefined) return fail("Update is unavailable on this hub.");
      const range = await updater.changes();
      if (range === null) return fail("Could not read what Update would apply.");
      if (range.commits.length === 0) return fail("Nothing to update: the hub runs main.");
      const cleared = new Set<number>();
      for (const d of store.flightDecisions(0, 100_000))
        if (d.kind === "merge")
          for (const m of d.decision.matchAll(/Cleared PR #(\d+)/g)) cleared.add(Number(m[1]));
      const foreign = range.commits.filter((line) => {
        const pr = /#(\d+)/.exec(line.replace(/^[0-9a-f]+ /, ""));
        return pr === null || !cleared.has(Number(pr[1]));
      });
      if (foreign.length > 0)
        return fail(
          `Update waits for the operator: ${foreign.length} commit(s) are not PRs you cleared (${foreign.slice(0, 3).join("; ")}).`,
        );
      let out: Awaited<ReturnType<Updater["update"]>>;
      try {
        out = await updater.update();
      } catch (e) {
        return fail(`Update refused: ${e instanceof Error ? e.message : "failed"}.`);
      }
      if ("upToDate" in out) return { text: "The hub already runs main." };
      store.addHubEvent("Updated by FLIGHT", now());
      const shas = range.commits.map((l) => l.split(" ")[0]).join(", ");
      if ("restarting" in out) setImmediate(() => updater.restart());
      return {
        text: `Updated the hub to ${shas}${"restarting" in out ? "; it restarts now" : ""}.`,
      };
    },
    { engine: false },
  );

  return tools;
}
