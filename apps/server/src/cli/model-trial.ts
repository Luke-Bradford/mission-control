/**
 * Read-only model trials for Audit's "what can we prove" question (#1428). It replays recorded work
 * on another model and writes a markdown result with the cost and an empty `Decision:` line for
 * FLIGHT to fill. The database opens read-only, git runs only in the given clone (merge-base, then
 * diff, no fetch), `claude` runs with every tool off in a temp dir, `gh` is never called, and the
 * one file written is `--out`.
 *
 *   node --experimental-strip-types apps/server/src/cli/model-trial.ts <review|wake|summary>
 *     --db <copy> --repo <id> --clone <path> --model <m> [--effort <e>] [--baseline <substring>]
 *     [--count 20] --out <file.md>
 */
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { parseArgs, promisify } from "node:util";
import { BLOCKING_SEVERITIES, FINDING_SEVERITIES } from "@mc/core";

const exec = promisify(execFile);
type Row = Record<string, SQLInputValue>;

export const TRIAL_MODES = ["review", "wake", "summary"] as const;
export type TrialMode = (typeof TRIAL_MODES)[number];
/** A trial finding on the same file within this many lines catches a recorded one. */
export const CATCH_LINES = 10;
export const TRIAL_DEFAULT_COUNT = 20;
/** The wake and summary inputs are cut to this many characters. */
const INPUT_MAX = 4000;

export interface TrialOptions {
  mode: TrialMode;
  db: string;
  repo: string;
  clone: string;
  model: string;
  effort?: string | undefined;
  baseline?: string | undefined;
  count: number;
  /** The PATH `claude` is found on; defaults to the process's. */
  path?: string | undefined;
}

interface Answer {
  text: string;
  cost: number;
}

/** Runs `claude -p` once with no tools, in a temp dir, the prompt on stdin. */
async function ask(o: TrialOptions, prompt: string): Promise<Answer> {
  const cwd = mkdtempSync(join(tmpdir(), "mc-trial-run-"));
  try {
    const args = ["-p", "--model", o.model];
    if (o.effort) args.push("--effort", o.effort);
    args.push("--output-format", "json", "--allowedTools=");
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn("claude", args, {
        cwd,
        env: { ...process.env, ...(o.path === undefined ? {} : { PATH: o.path }) },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let data = "";
      child.stdout.on("data", (c) => {
        data += c;
      });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve(data) : reject(new Error(`claude exited ${code}`)),
      );
      child.stdin.end(prompt);
    });
    const parsed = JSON.parse(out) as { result?: string; total_cost_usd?: number };
    return { text: parsed.result ?? "", cost: parsed.total_cost_usd ?? 0 };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** The JSON object in a reply, however it is fenced; null when there is none. */
export function jsonOf(text: string): Record<string, unknown> | null {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  try {
    const v = JSON.parse(text.slice(a, b + 1)) as unknown;
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A reply's findings when every one is well formed; null when the reply is not usable. */
export function parseFindings(
  text: string,
): { severity: string; file: string; line: number }[] | null {
  const list = jsonOf(text)?.findings;
  if (!Array.isArray(list)) return null;
  const out: { severity: string; file: string; line: number }[] = [];
  for (const f of list as unknown[]) {
    if (typeof f !== "object" || f === null) return null;
    const { severity, file, line } = f as Record<string, unknown>;
    if (!FINDING_SEVERITIES.some((s) => s === severity)) return null;
    if (typeof file !== "string" || file === "") return null;
    if (typeof line !== "number" || !Number.isInteger(line) || line < 0) return null;
    out.push({ severity: severity as string, file, line });
  }
  return out;
}

/** `ask`, with a failed call (exit code, unreadable output) as null so it is counted, not scored. */
async function tryAsk(o: TrialOptions, prompt: string): Promise<Answer | null> {
  try {
    return await ask(o, prompt);
  } catch {
    return null;
  }
}

const money = (n: number): string => `$${n.toFixed(2)}`;
const cut = (s: string): string => (s.length > INPUT_MAX ? `${s.slice(0, INPUT_MAX)}…` : s);

interface Recorded {
  file: string;
  line: number;
}

/** True when the trial's finding is blocking, on the file, within CATCH_LINES (line 0: the whole file). */
export function caught(
  recorded: Recorded,
  trial: readonly { severity: string; file: string; line: number }[],
): boolean {
  return trial.some(
    (t) =>
      BLOCKING_SEVERITIES.some((s) => s === t.severity) &&
      t.file === recorded.file &&
      (recorded.line === 0 || t.line === 0 || Math.abs(t.line - recorded.line) <= CATCH_LINES),
  );
}

const SHAPE = `Reply with only JSON: {"findings":[{"severity":"${FINDING_SEVERITIES.join('"|"')}","file":"path","line":1,"summary":"..."}]}. Line 0 means the whole file.`;

async function reviewTrial(o: TrialOptions, db: DatabaseSync): Promise<string[]> {
  const rows = db
    .prepare(
      `SELECT rv.id, rv.pr_number, rv.sha FROM reviews rv
       JOIN runs r ON r.id = rv.run_id
       JOIN pr_history h ON h.repo_id = rv.repo_id AND h.number = rv.pr_number
       WHERE rv.repo_id = ? AND rv.round = 1 AND rv.state = 'reported' AND rv.blocking > 0
         AND instr(r.model, ?) > 0
       ORDER BY COALESCE(rv.ended_at, rv.created_at) DESC, rv.id DESC`,
    )
    .all(o.repo, o.baseline ?? "") as Row[];
  const role = readFileSync(new URL("../../../../roles/RETRO.md", import.meta.url), "utf8");
  const lines: string[] = [];
  let total = 0;
  let found = 0;
  let recordedAll = 0;
  let completed = 0;
  let skipped = 0;
  let failed = 0;
  let next = 0;
  // Older eligible reviews stand in for one whose commit is not in the clone, until `count` complete.
  for (; next < rows.length && completed < o.count; next += 1) {
    const r = rows[next] as Row;
    const recorded = (
      db
        .prepare(
          "SELECT file, line FROM review_findings WHERE review_id = ? AND severity IN (?, ?) ORDER BY pos",
        )
        .all(r.id, ...BLOCKING_SEVERITIES) as Row[]
    ).map((f) => ({ file: f.file as string, line: f.line as number }));
    let diff: string;
    try {
      const sha = r.sha as string;
      let base = (
        await exec("git", ["merge-base", sha, "origin/main"], { cwd: o.clone })
      ).stdout.trim();
      if (base === sha) {
        // Merged with a merge commit: the reviewed base is the first parent of the merge that brought it in, as it stood when the head branched.
        const path = (
          await exec(
            "git",
            ["rev-list", "--first-parent", "--ancestry-path", "--reverse", `${sha}..origin/main`],
            { cwd: o.clone },
          )
        ).stdout.trim();
        const merge = path.split("\n")[0] ?? "";
        if (merge === "") throw new Error("no merge");
        await exec("git", ["rev-parse", "--verify", `${merge}^2`], { cwd: o.clone });
        base = (
          await exec("git", ["merge-base", sha, `${merge}^1`], { cwd: o.clone })
        ).stdout.trim();
      }
      diff = (await exec("git", ["diff", base, sha], { cwd: o.clone, maxBuffer: 64 * 1024 * 1024 }))
        .stdout;
    } catch {
      skipped += 1;
      lines.push(`- PR ${r.pr_number}: skipped, its commit is not in the clone.`);
      continue;
    }
    const answer = await tryAsk(o, `${role}\n\n## The change\n\n${diff}\n\n${SHAPE}\n`);
    if (answer) total += answer.cost;
    const trial = answer ? parseFindings(answer.text) : null;
    if (!answer || !trial) {
      failed += 1;
      lines.push(`- PR ${r.pr_number}: failed, the reply was not usable; not scored.`);
      continue;
    }
    const hit = recorded.filter((f) => caught(f, trial));
    completed += 1;
    found += hit.length;
    recordedAll += recorded.length;
    lines.push(
      `- PR ${r.pr_number}: caught ${hit.length} of ${recorded.length}; ${trial.length} findings; cost ${money(answer.cost)}`,
    );
  }
  const shortfall =
    completed < o.count
      ? ` Shortfall: ${completed} completed of the ${o.count} asked for, as only ${rows.length} eligible reviews exist, ${skipped} were skipped and ${failed} had unusable replies.`
      : "";
  return [
    `Caught ${found} of ${recordedAll} blocking findings over ${completed} completed reviews.`,
    `Reviews: ${completed} completed, ${rows.length} eligible, ${skipped} skipped (commit not in the clone), ${failed} failed (unusable reply).${shortfall}`,
    `Cost ${money(total)} in total.`,
    "",
    ...lines,
  ];
}

async function wakeTrial(o: TrialOptions, db: DatabaseSync): Promise<string[]> {
  const rows = db
    .prepare(
      `SELECT w.wake_id, w.reasons,
         (SELECT COUNT(*) FROM flight_decisions d WHERE d.wake_id = w.wake_id) AS decided,
         (SELECT COUNT(*) FROM flight_decisions d WHERE d.wake_id = w.wake_id AND d.kind != 'wait') AS acted
       FROM flight_wakes w JOIN runs fr ON fr.id = w.run_id
       WHERE w.wake_id IS NOT NULL AND fr.repo_id = ? AND decided > 0
       ORDER BY w.at DESC LIMIT ?`,
    )
    .all(o.repo, o.count) as Row[];
  let agree = 0;
  let falseWaits = 0;
  let failed = 0;
  let scored = 0;
  let total = 0;
  const lines: string[] = [];
  for (const r of rows) {
    const acted = (r.acted as number) > 0;
    const answer = await tryAsk(
      o,
      `FLIGHT was woken for this reason:\n\n${cut(String(r.reasons))}\n\nDoes this need action now? Reply with only JSON: {"action":"act"|"wait"}.\n`,
    );
    if (answer) total += answer.cost;
    const action = answer ? jsonOf(answer.text)?.action : undefined;
    if (!answer || (action !== "act" && action !== "wait")) {
      failed += 1;
      lines.push(`- ${r.wake_id}: failed, the reply was not usable; not scored.`);
      continue;
    }
    scored += 1;
    const said = action;
    if (said === (acted ? "act" : "wait")) agree += 1;
    if (said === "wait" && acted) falseWaits += 1;
    lines.push(
      `- ${r.wake_id}: FLIGHT ${acted ? "acted" : "waited"}; trial said ${said}; cost ${money(answer.cost)}`,
    );
  }
  return [
    `Agreement: ${agree} of ${scored}`,
    `False waits: ${falseWaits}`,
    `Wakes: ${scored} scored, ${failed} failed (unusable reply), ${rows.length} sampled.`,
    `Cost ${money(total)} in total.`,
    "",
    ...lines,
  ];
}

async function summaryTrial(o: TrialOptions, db: DatabaseSync): Promise<string[]> {
  const rows = db
    .prepare(
      `SELECT id, ticket, summary FROM runs WHERE repo_id = ? AND summary IS NOT NULL AND summary != ''
       ORDER BY started_at DESC, id DESC LIMIT ?`,
    )
    .all(o.repo, o.count) as Row[];
  let total = 0;
  let failed = 0;
  const lines: string[] = [];
  for (const r of rows) {
    const answer = await tryAsk(
      o,
      `Write one plain line saying what this run did, from its stored result text:\n\n${cut(String(r.summary))}\n\nReply with only JSON: {"summary":"..."}.\n`,
    );
    if (answer) total += answer.cost;
    const line = answer ? jsonOf(answer.text)?.summary : undefined;
    if (!answer || typeof line !== "string" || line.trim() === "") {
      failed += 1;
      lines.push(`- ${r.ticket ?? r.id}: failed, the reply was not usable; not shown.`);
      continue;
    }
    lines.push(
      `- ${r.ticket ?? r.id}\n  - stored: ${String(r.summary)}\n  - trial: ${line.trim()}\n  - cost ${money(answer.cost)}`,
    );
  }
  return [
    `${rows.length - failed} summaries, ${failed} failed (unusable reply).`,
    `Cost ${money(total)} in total.`,
    "",
    ...lines,
  ];
}

/** Runs a trial and returns its markdown result; nothing is written. */
export async function runTrial(o: TrialOptions): Promise<string> {
  const db = new DatabaseSync(o.db, { readOnly: true });
  try {
    const body =
      o.mode === "review"
        ? await reviewTrial(o, db)
        : o.mode === "wake"
          ? await wakeTrial(o, db)
          : await summaryTrial(o, db);
    const head = `# ${o.mode} trial: ${o.model}${o.effort ? ` ${o.effort}` : ""}`;
    return `${[head, "", ...body, "", "Decision:"].join("\n")}\n`;
  } finally {
    db.close();
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      db: { type: "string" },
      repo: { type: "string" },
      clone: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      baseline: { type: "string" },
      count: { type: "string", default: String(TRIAL_DEFAULT_COUNT) },
      out: { type: "string" },
    },
  });
  const mode = TRIAL_MODES.find((m) => m === positionals[0]);
  if (!mode || !values.db || !values.repo || !values.clone || !values.model || !values.out) {
    console.error(
      "usage: model-trial.ts <review|wake|summary> --db <copy> --repo <id> --clone <path> --model <m> [--effort <e>] [--baseline <substring>] [--count 20] --out <file.md>",
    );
    process.exit(2);
  }
  const result = await runTrial({
    mode,
    db: values.db,
    repo: values.repo,
    clone: values.clone,
    model: values.model,
    effort: values.effort,
    baseline: values.baseline,
    count: Number(values.count) || TRIAL_DEFAULT_COUNT,
  });
  writeFileSync(values.out, result);
}
