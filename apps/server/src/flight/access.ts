/**
 * FLIGHT's full-access tools (#1214), the controller's reach without a shell: `operator` calls the
 * hub's operator routes in process, `gh_write` runs a fixed set of `gh` verbs on FLIGHT's own repo,
 * and `crew_tidy` removes an ended run's clean worktree and prunes local branches. Each call that
 * lands is a FLIGHT decision with the route or verb, the body and the basis. The repo's rules
 * still bound them: the card floor (`always_ask`, another lane), secrets and @mentions in text,
 * protected branches, and the routes the allow-list leaves out.
 */
import {
  FLIGHT_GH_WRITE_ACTIONS,
  FLIGHT_OPERATOR_BODY_MAX,
  FLIGHT_OPERATOR_RESPONSE_MAX,
  flightOperatorAllowed,
  flightOperatorRefusedText,
  MC_TOOL_NAMES,
} from "@mc/core";
import { z } from "zod";
import { isKept, SAFE_BRANCH } from "../branch-tidy.ts";
import type { McToolContext, McToolResult } from "../mcp/server.ts";
import { readKnown } from "../mcp/tools.ts";
import { crewDir } from "../store.ts";
import type { PowerHelpers } from "./powers.ts";
import { cut } from "./tools.ts";

const basis = z.string().min(1).max(500);
const number = z.number().int().min(1).max(9_999_999);
const text = z.string().min(1).max(60_000);
const RUN_PATH = /^\/api\/runs\/([^/]+)\//;

export function createAccessTools(h: PowerHelpers) {
  const { deps, now, fail } = h;
  const { store, bus } = deps;

  const OperatorArgs = z.strictObject({
    method: z.enum(["GET", "POST"]),
    path: z.string().min(1).max(500),
    body: z.record(z.string(), z.unknown()).optional(),
    basis,
  });
  const operator = h.superTool(
    MC_TOOL_NAMES.operator,
    "Call one of the hub's operator routes in process, as the operator would: POST to a run's resume, end, message, controller-check or merge-hold; a seat's start, message, interrupt or end; crew-pause, away, update, or an attention item's dismiss or hold; or GET any other /api path. The route's own checks still apply. A refused route says what is allowed.",
    OperatorArgs,
    "operator",
    async (a: z.output<typeof OperatorArgs>, _repo, ctx: McToolContext): Promise<McToolResult> => {
      if (!flightOperatorAllowed(a.method, a.path))
        return fail(flightOperatorRefusedText(a.method, a.path));
      if (deps.operator === undefined)
        return fail("The operator routes are unavailable on this hub.");
      const payload = a.body === undefined ? undefined : JSON.stringify(a.body);
      if (payload !== undefined && payload.length > FLIGHT_OPERATOR_BODY_MAX)
        return fail("Refused: the body is too long.");
      const known = await readKnown(deps, MC_TOOL_NAMES.operator);
      if (known.some((k) => `${payload ?? ""}${a.path}`.includes(k)))
        return fail("Refused: the call contains a secret.");
      const answer = await deps.operator({
        method: a.method,
        path: a.path,
        ...(a.body === undefined ? {} : { body: a.body }),
      });
      const shown = cut(answer.body, FLIGHT_OPERATOR_RESPONSE_MAX);
      if (a.method === "POST") {
        h.record(now(), {
          kind: "operator",
          about: `POST ${a.path}`,
          decision: `${payload === undefined ? "No body" : `Body ${payload}`}. Answer ${answer.status}: ${shown}`,
          basis: a.basis,
          seatId: ctx.seatId,
          targetRunId: RUN_PATH.exec(a.path)?.[1] ?? null,
        });
        bus.emit("agents");
      }
      const result = { text: `${answer.status} ${shown}` };
      return answer.status >= 400 ? { ...result, isError: true } : result;
    },
    { engine: false, records: false },
  );

  const Target = z.enum(["issue", "pr"]);
  const GhWriteArgs = z.strictObject({
    action: z.enum(FLIGHT_GH_WRITE_ACTIONS),
    repo: z.string().min(1).max(200).optional(),
    target: Target.optional(),
    number: number.optional(),
    text: text.optional(),
    title: z.string().min(1).max(256).optional(),
    body: text.optional(),
    addLabels: z.array(z.string().min(1).max(100)).max(50).optional(),
    removeLabels: z.array(z.string().min(1).max(100)).max(50).optional(),
    branch: z.string().min(1).max(250).optional(),
    basis,
  });
  const ghWrite = h.superTool(
    MC_TOOL_NAMES.ghWrite,
    "Write to GitHub on your own repo only: comment (target issue|pr, number, text), label (addLabels, removeLabels), edit (title, body), close, reopen, ready (a draft PR), or delete_branch (branch; never main, archive/*, a branch with an open PR or a live run). Text is scanned for secrets and @mentions. Merging is merge_pr; board fields are set_fields.",
    GhWriteArgs,
    "github",
    async (a: z.output<typeof GhWriteArgs>, repo, ctx: McToolContext): Promise<McToolResult> => {
      if (a.repo !== undefined && a.repo !== repo.github && a.repo !== repo.id)
        return fail(`Refused: gh_write works on ${repo.github} only.`);
      const run = async (args: string[], input?: string) => {
        const r = await deps.gh(args, {
          cwd: crewDir(deps.dbPath),
          ...(input === undefined ? {} : { input }),
        });
        return r;
      };
      const done = (what: string, ref: string): McToolResult => {
        h.record(now(), {
          kind: "github",
          about: `gh_write ${a.action} ${ref}`,
          decision: what,
          basis: a.basis,
          seatId: ctx.seatId,
        });
        bus.emit("boards");
        return { text: what };
      };
      const refused = (r: { stderr: string }): McToolResult =>
        fail(`GitHub refused: ${cut(r.stderr.trim().split("\n")[0] ?? "", 200)}`);

      if (a.action === "delete_branch") {
        const branch = a.branch;
        if (branch === undefined) return fail("Give the branch to delete.");
        if (
          !SAFE_BRANCH.test(branch) ||
          branch.split("/").some((p) => p === "" || p.startsWith("."))
        )
          return fail("Refused: that branch name is not plain.");
        if (isKept(branch, "main", repo.keepBranches ?? []))
          return fail(`Refused: ${branch} is protected.`);
        const live = store
          .runsActiveSince(Number.MAX_SAFE_INTEGER)
          .some((r) => r.endedAt === null && r.repoId === repo.id && r.branch === branch);
        if (live) return fail(`Refused: a live run is on ${branch}.`);
        const open = await run([
          "pr",
          "list",
          `--repo=${repo.github}`,
          "--state=open",
          `--head=${branch}`,
          "--json=number",
        ]);
        let openPrs: unknown;
        try {
          openPrs = JSON.parse(open.stdout);
        } catch {
          openPrs = null;
        }
        if (open.code !== 0 || !Array.isArray(openPrs))
          return fail("Refused: could not check for an open PR on that branch.");
        if (openPrs.length > 0) return fail(`Refused: ${branch} has an open PR.`);
        const path = `repos/${repo.github}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`;
        const r = await run(["api", "--method", "DELETE", path]);
        if (r.code !== 0) return refused(r);
        return done(`Deleted branch ${branch}.`, branch);
      }

      const target = a.target;
      const n = a.number;
      if (target === undefined || n === undefined)
        return fail("Give the target (issue or pr) and its number.");
      if (a.action === "ready" && target !== "pr") return fail("Only a PR can be made ready.");
      const ref = `${target === "pr" ? "PR" : "issue"} #${n}`;
      const texts = [
        ...(a.text === undefined ? [] : [{ label: "text", text: a.text }]),
        ...(a.title === undefined ? [] : [{ label: "title", text: a.title }]),
        ...(a.body === undefined ? [] : [{ label: "body", text: a.body }]),
      ];
      const known = await readKnown(deps, MC_TOOL_NAMES.ghWrite);
      const unfit = await h.textProblem(ctx, MC_TOOL_NAMES.ghWrite, repo.github, n, texts, known);
      if (unfit !== null) return fail(unfit);
      // the card floor: an always_ask ticket and another lane's are not edited, labelled or closed
      if (target === "issue" && a.action !== "comment") {
        const card = await deps.board.read?.(repo.id, n).catch(() => null);
        if (card) {
          const rules = await deps.rules(repo.id);
          if (rules instanceof Error) return fail("Cannot read repo rules.");
          const problem = h.cardProblem(card, rules);
          if (problem !== null) return fail(`Refused: ${problem}.`);
        }
      }
      const verb = (v: string, ...rest: string[]) => [
        target,
        v,
        String(n),
        `--repo=${repo.github}`,
        ...rest,
      ];
      switch (a.action) {
        case "comment": {
          if (a.text === undefined) return fail("Give the comment text.");
          const r = await run(verb("comment", "--body-file=-"), a.text);
          return r.code === 0 ? done(`Commented on ${ref}.`, ref) : refused(r);
        }
        case "label": {
          if (!a.addLabels?.length && !a.removeLabels?.length)
            return fail("Give addLabels or removeLabels.");
          const r = await run(
            verb(
              "edit",
              ...(a.addLabels?.length ? [`--add-label=${a.addLabels.join(",")}`] : []),
              ...(a.removeLabels?.length ? [`--remove-label=${a.removeLabels.join(",")}`] : []),
            ),
          );
          return r.code === 0 ? done(`Labelled ${ref}.`, ref) : refused(r);
        }
        case "edit": {
          if (a.title === undefined && a.body === undefined) return fail("Give a title or body.");
          const r = await run(
            verb(
              "edit",
              ...(a.title === undefined ? [] : [`--title=${a.title}`]),
              ...(a.body === undefined ? [] : ["--body-file=-"]),
            ),
            a.body,
          );
          return r.code === 0 ? done(`Edited ${ref}.`, ref) : refused(r);
        }
        case "close":
        case "reopen": {
          const r = await run(verb(a.action));
          return r.code === 0
            ? done(`${a.action === "close" ? "Closed" : "Reopened"} ${ref}.`, ref)
            : refused(r);
        }
        case "ready": {
          const r = await run(verb("ready"));
          return r.code === 0 ? done(`Marked ${ref} ready for review.`, ref) : refused(r);
        }
        default:
          return fail("Unknown action.");
      }
    },
    { engine: true, records: false },
  );

  const CrewTidyArgs = z.strictObject({
    action: z.enum(["remove_worktree", "prune_branches"]),
    runId: z.string().min(1).max(200).optional(),
    basis,
  });
  const crewTidy = h.superTool(
    MC_TOOL_NAMES.crewTidy,
    "Crew housekeeping. remove_worktree { runId }: remove the clean worktree of a run that has ended, keeping its branch (a dirty worktree, a live run's or a seat's is refused), so a seat can start the ticket again. prune_branches: drop the seat clones' local branches that are merged or whose remote is gone.",
    CrewTidyArgs,
    "tidy",
    async (a: z.output<typeof CrewTidyArgs>, _repo, ctx: McToolContext): Promise<McToolResult> => {
      if (deps.tidy === undefined) return fail("Crew housekeeping is unavailable on this hub.");
      let result: { ok: boolean; text: string };
      if (a.action === "remove_worktree") {
        if (a.runId === undefined) return fail("Give the runId.");
        result = await deps.tidy.removeWorktree(a.runId);
      } else result = await deps.tidy.pruneBranches();
      if (!result.ok) return fail(result.text);
      h.record(now(), {
        kind: "tidy",
        about:
          a.action === "remove_worktree"
            ? `crew_tidy ${a.action} ${a.runId}`
            : `crew_tidy ${a.action}`,
        decision: result.text,
        basis: a.basis,
        seatId: ctx.seatId,
        targetRunId: a.runId ?? null,
      });
      bus.emit("agents");
      return { text: result.text };
    },
    { engine: false, records: false },
  );

  return [operator, ghWrite, crewTidy];
}
