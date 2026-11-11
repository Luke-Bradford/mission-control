# Shell output in a seat's context (#1642)

Large shell results re-enter context on every later call. This page records what bounds them
today, what the installed CLIs support, what was and was not measured, and how a seat should
read. It follows #1503 (concise check output, failure output and exit codes) and does not
duplicate #1567 (audit figures).

## What bounds a result today

| Path | Success | Failure |
|---|---|---|
| Claude CLI 2.1.322 | The CLI returns at most `bashOutputMaxChars` (default 30000, clamped to 4000–128000) inline. The rest is saved to a file and the seat gets a short preview and the path. The seat's Read tool opens that file. | Not capped by this setting (it names successful output only). The output and the `Exit code N` line arrive whole. |
| Hub trim hook (#1045, Claude seats) | A result over 32 KB is cut to 8 KB head, 4 KB tail (from the last `FAIL` or `error` line for Bash) and a marker naming `<run temp root>/tool-output/<tool_use_id>.txt`, which holds the whole result. | Not run: it is a `PostToolUse` hook and a failed call fires `PostToolUseFailure`. Failure output is #1503's. |
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

- Search before reading: `rg -n -C 2 '<pattern>' <path>` names the lines; add `-g '<glob>'` or a
  directory to bound it. Do not pipe to `head` when the question is "is there any match or
  error": `head` hides what comes after. Count first (`rg -c`), then read.
- Read a file in ranges: the Read tool with `offset` and `limit`, or `sed -n 'START,ENDp'`, for
  the lines the search found. Read the whole file only when it is short or the whole is the task.
- Make a command print a summary, not a dump: `python3` that prints a count, the keys and the
  few rows that matter; not the whole structure.
- A result with `[mc: N bytes cut; the full output is at <path>]` or the CLI's saved-file path
  is complete there: Read the path with `offset` and `limit`, or `rg` it. Do not re-run the
  command to see more.
- A failure's output arrives whole. Read it from the top; the `Exit code` line is first.

The role briefs (`roles/*.md`) are outside the server and docs area; carrying this section into
them needs FLIGHT's clearance.
