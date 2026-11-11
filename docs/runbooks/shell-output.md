# Shell output in a seat's context (#1642)

Large shell results re-enter context on every later call. This page records what bounds them
today, what the installed CLIs support, what was and was not measured, and how a seat should
read. It follows #1503 (concise check output, failure output and exit codes) and does not
duplicate #1567 (audit figures).

## What bounds a result today

| Path | Success | Failure |
|---|---|---|
| Claude CLI 2.1.322 | The CLI returns at most `bashOutputMaxChars` (default 30000, clamped to 4000–128000) inline. The rest is saved to a file and the seat gets a short preview and the path. The seat's Read tool opens that file. | Not covered by this setting, and not saved. The CLI cuts a large failure to about 30000 characters with a middle cut, so the end (a build's or test's final summary) can be lost and there is no path to get it back. The `Exit code N` line stays first. (Observed in a seat: a 49 KB failing command lost its last 2,700 lines and its last line.) |
| Hub trim hook (#1045, Claude seats) | A result over 32 KB is cut to 8 KB head, 4 KB tail (from the last `FAIL` or `error` line for Bash) and a marker naming `<run temp root>/tool-output/<tool_use_id>.txt`, which holds the whole result. | Not run: it is a `PostToolUse` hook and a failed call fires `PostToolUseFailure`. Retention for failures is by seat guidance (below); check output is #1503's. |
| Codex seats | No hub trim hook (the folder is not made for Codex). The Codex CLI (0.154.0) has its own `tool_output_token_limit` setting; the hub does not set it. | Not evidenced. |

`BASH_MAX_OUTPUT_LENGTH` is not the cap. In 2.1.322 it only sizes the read-back window; the cap
is the `bashOutputMaxChars` setting, and when that is set it replaces the variable. (Source: the
setting's description in the installed binary, 2026-11-11.) The hub sets neither, so seats run
with the 30000 default.

The default is already active: in this ticket's own run a 309 KB `strings` result came back as
a 2 KB preview, the file's path, and the file was readable with Read. So truncation and
retrieval are confirmed for the installed version, not assumed from the documentation.

The hub's 32 KB trim sits just above the CLI's 30000, so for a successful Bash result the CLI's
cap normally acts first; the trim hook still covers other tools (MCP results, Read) and any
Bash result the CLI let through.

## Decision

Keep the CLI default of 30000. No change to `CREW_CLI_ENV` or the seat settings.

Why: the p90 of output length by command class could not be measured from this seat (below), so
there is no data to say a lower cap would cut re-reads without hiding matches. Lowering it also
clamps at 4000, and a seat that has to re-run a command to read the saved file spends more than
it saves. The trial is: set `bashOutputMaxChars` to 16000 in `crewSandboxSettings`, run for
seven days, and compare Bash re-reads and the count of Read calls on `tool-results` paths with
the 8 November baseline. That belongs to #1431's Controller check, which starts at this change's
deployment.

Codex needs its own trial: set `tool_output_token_limit` in the Codex seat's config and confirm
with a real Codex run that a large result is cut and where the full text goes. Do not assume the
Claude setting reaches it.

## Measurements

- **Output-length p90 by command: not measured.** The per-run transcripts that hold the results
  are in the hub's data directory, which seats cannot read, and #1567 owns the audit figures.
  The audit's per-call `incoming` characters by `commandClass` (`token-audit/audit.ts`) give the
  figure once run on the hub's data: take the 90th percentile of `chars` per class.
- **What the large python3 commands print: not classified** for the same reason. The 8 November
  baseline gives python3 as 10.5% of daily Bash re-reads (8.1M). The likely classes, to confirm
  against retained transcripts, are JSON or YAML dumps, `json.tool` pretty-printing and file
  listings. Re-run the classification on the hub's data and record it here.
- 8 November baseline (from `docs/reviews/2026-11-08/token-efficiency.md`): sed 26.6M, grep 17.2M,
  cat 5.7M daily; 49.5M together; a 20% cut is 9.9M. These are estimates, not results of this change.

## How a seat reads

The file tools (Read, Grep) are confined to the worktree in every seat but FLIGHT's
(`--restricted`), and a Claude seat's `$TMPDIR` is outside it. So read by where the file is:

- **Worktree files:** the Grep tool (not shell `rg`, which is not installed in the seat shell):
  `pattern`, `path` or `glob`, `-C 2` for context, `output_mode: count` first, `head_limit` to
  bound it. Then the Read tool with `offset` and `limit` for the lines found. Read a whole file
  only when it is short or the whole is the task. `sed -n 'START,ENDp'` also works.
- **Files under `$TMPDIR`** (the log-file form below, and the hub's
  `[mc: N bytes cut; the full output is at <path>]` marker in Claude seats): shell commands only.
  `grep -c '<pattern>' <file>` first, then `grep -n -C 2 '<pattern>' <file>`, then
  `tail -n 80 <file>` for a failure's final summary, then `sed -n 'START,ENDp' <file>` for a
  range. Codex seats keep their temp folder inside the worktree, where the file tools work too.
- **The CLI's own saved-output file** (the preview's path, under the CLI's projects folder): only
  the Read and Grep tools open it. Shell commands cannot (the sandbox refuses that folder).
- Do not cut a shell search short with `head` when the question is "is there any match or
  error": it hides what comes after.
- Make a command print a summary, not a dump: `python3` that prints a count, the keys and the
  few rows that matter; not the whole structure.
- A command that might print a lot and fail (a build, a long grep, a python3 script): send the
  output to a file and keep the status, then read the file with the shell commands above.
  `cmd > "$TMPDIR/<name>.log" 2>&1; echo "exit=$?"`. That keeps all of the output and the exit
  status and returns a line. Do this rather than hoping the end of a failure survives the CLI's cut.
- A cut or saved result is complete at its path. Do not re-run the command to see more.
- A large failure is cut to about 30000 characters in the middle and is not saved. The `Exit
  code` line stays first but the end may be missing. Use the log-file form for any command that
  might fail loudly.

Follow-up, outside this change: the role briefs (`roles/*.md`) do not yet point here. They are
hard-rule files, so FLIGHT decided the one-line pointer ("Reading files and output: follow
`docs/runbooks/shell-output.md#how-a-seat-reads`") is a separate change, not part of this PR.
