# Spike: mc tools over MCP HTTP, the guard hook, a sandbox without git writes

Date: run 2026-10-20. CLI 2.1.302, model `haiku`, the operator's Max login, node 25.9.0 at
`/opt/homebrew/bin/node`. Plan 6, Task 1. Every later task in phase 2b rests on these facts.

## Setup

- **Seats.** Each seat ran with the hub's own `crewCliArgs` from this branch (writer mode,
  `--restricted --strict-mcp-config --disable-slash-commands`, anchored rules, the hub's sandbox
  JSON). It had the supervisor's `crewEnv` (the launchd PATH plus `CREW_CLI_ENV`) and was driven over
  stream-json.
- **Repos.** Two scratch repos under `/private/tmp/claude-501/mc-plan6-build/`:
  - `probe/`, a one-file repo whose `pnpm -s test <arg>` prints a marker that the command text does
    not contain (the arg reversed);
  - `mc/`, a `--no-hardlinks` clone of this branch with a linked worktree and `pnpm install --offline`.
- **What the spike added to the argv**, and nothing else:
  - the `hooks` key merged into the `--settings` JSON;
  - `--mcp-config`;
  - a few extra `--allowedTools` entries, named in each row;
  - for Step 3, the sandbox's `allowWrite`/`denyWrite` replaced as described there.

  The exact flags of each run are in `runs/<name>/argv.json` under the scratch dir (`runs/*/argv.json`).
- **MCP server.** A ~100-line Node server answered JSON-RPC over HTTP (JSON responses, no SSE) with
  the tools `echo` and `slow`. It logged every request.
- **Hook.** A Node script logged its stdin, env and pid. It answered from a per-run table keyed on the
  command text.
- **Token.** A fake token, `mc-test-token-0000`. No real credential was used.

## Step 1: MCP over HTTP

Config: `{"mcpServers":{"mc":{"type":"http","url":"http://127.0.0.1:7462/mcp","headers":{"Authorization":"Bearer mc-test-token-0000"}}}}`,
with `mcp__mc__echo` added to `--allowedTools`.

| Question | Result | Evidence |
|---|---|---|
| `--restricted` honours `--mcp-config` | Yes, both inline JSON and a file path work. The file was mode 0600 in the data dir, which the sandbox read-denies; the CLI reads it outside the sandbox. | `system/init`: `mcp_servers: [{"name":"mc","status":"connected","source":"dynamic"}]`, tools include `mcp__mc__echo`, `mcp__mc__slow`. |
| Tool name the model sees | `mcp__<server>__<tool>`, here `mcp__mc__echo`. Hooks get the same `tool_name`, plus `mcp_server: {"name":"mc","source":"dynamic"}`. | Hook stdin: `"tool_name":"mcp__mc__echo"` … `"mcp_server":{"name":"mc","source":"dynamic"}`. |
| Header arriving | Every request carries it: `authorization: Bearer mc-test-token-0000`, `user-agent: claude-code/2.1.302 (sdk-cli)`, `accept: application/json, text/event-stream`. | Server log, on all of `server/discover`, `initialize`, `notifications/initialized`, `GET /mcp`, `tools/list` and `tools/call`. |
| Handshake order | (1) `POST server/discover` (id `"server-discover-probe-1"`, `mcp-protocol-version: 2026-07-28`); answered `-32601`, so the CLI falls back. (2) `POST initialize` with `"protocolVersion":"2025-11-25"`. (3) `notifications/initialized`, answered 202. (4) `GET /mcp` (SSE), answered 405; that is fine. (5) `tools/list`. | MCP log: `"protocolEra":"legacy","negotiatedProtocolVersion":"2025-11-25"`. |
| `protocolVersion` sent | `2025-11-25` in `initialize`, then sent as the `mcp-protocol-version` header on every later request. | Server log. |
| `protocolVersion` accepted back | `2025-11-25` (echoed): connected. `2025-06-18`: connected, and later requests carry `mcp-protocol-version: 2025-06-18`. `1999-01-01`: `status: "failed"`. | MCP log: `Server's protocol version is not supported: 1999-01-01`. |
| A tool call's `_meta` | The call carries the model's tool-use id. It was seen on all 4 logged `tools/call` requests (`echo` twice, `slow` twice); one is quoted. | `"_meta":{"claudecode/toolUseId":"toolu_014A8BLLBUqAFhE68CBLov26","progressToken":2}` |
| What a 401 does | The server shows `status: "failed"` in `system/init`, and no `mcp__mc__*` tools are loaded. There is no OAuth discovery (no `/.well-known` requests) and no retry. The seat keeps running without the tools. The model is told why: "failed to connect (HTTP 401, the Authorization header was rejected)". | MCP log: `Server rejected the configured Authorization header (HTTP 401) … OAuth fallback is disabled when headers.Authorization is set.` The 401 body (`{"error":"unauthorised"}`) is copied into the MCP log. |
| MCP tool-call timeout | **60 s by default.** `slow` (90 s) failed after 60.005 s with `"The operation timed out."`, and the CLI closed the socket at 60.001 s. A per-server `"timeout": 150000` (ms) in the server's config entry let the 90 s call finish. A heartbeat `tool_progress` arrives every 30 s while a call runs. | 60 s run: PostToolUseFailure `{"error":"The operation timed out.","duration_ms":60005}`. 150 s run: PostToolUse `duration_ms: 90009`, result `slept 90s`. |
| Token exposure | **Inline `--mcp-config` JSON puts the token in argv.** With the file path it appeared in none of these places: `system/init` or any stream-json line; the seat's `~/.claude/projects/<cwd>/` transcripts and tool-results; the MCP logs under `~/Library/Caches/claude-cli-nodejs/<cwd>/mcp-logs-mc/`, which write `"Authorization":"[REDACTED]"`; the hook's stdin or env; `~/.claude.json`; and the rest of `~/.claude`. | `grep -rl mc-test-token-0000` over those paths: the only hit is `runs/a-basics/argv.json`, the inline run. |

## Step 2: hooks

Hooks were registered in the `--settings` JSON as `{"type":"command","command":"/opt/homebrew/bin/node …/hook.mjs …","timeout":N}`:
- `PreToolUse` with matcher `*`;
- `PostToolUse` and `PostToolUseFailure` with matcher `Bash` (or `*` to observe other tools);
- `PermissionDenied` with matcher `*`.

| Question | Result | Evidence |
|---|---|---|
| Fire under `--restricted` | Yes. PreToolUse fires for Bash, Read, Edit, Write and `mcp__mc__echo`. PostToolUse fires for each on success. The matcher `Bash` limits Post to Bash. | Run A hook log: `PreToolUse mcp__mc__echo`, `PostToolUse mcp__mc__echo`, `PreToolUse Bash`, … `PostToolUse Write`. |
| Event names | `PreToolUse`, `PostToolUse` and `PostToolUseFailure` exist and fire. `PermissionDenied` is accepted in settings but **never fired** in any run, for rule denials or hook denials. | Run A: two rule denials and no PermissionDenied record. Run B: four hook denials, likewise. |
| stdin, PreToolUse | `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode` (`"default"`), `effort` (`{"level":"medium"}`), `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`, plus `mcp_server` for MCP tools. Size is about 510 bytes plus the `tool_input` JSON. | `{"command":"pnpm -s test case-reach","description":"…"}`, `"tool_use_id":"toolu_01TX9EmyPRvDrStT71n4bkib"`. The Bash `tool_input` also carries `timeout` and `run_in_background` when the model sets them. |
| stdin, PostToolUse | The PreToolUse fields plus `tool_response` and `duration_ms`. Bash `tool_response`: `stdout`, `stderr`, `interrupted`, `isImage`, `noOutputExpected`, plus `backgroundTaskId` / `timedOutAfterMs` / `persistedOutputPath` when they apply. MCP `tool_response`: the content array. | `tool_use_id` matches the PreToolUse one in every pair. |
| stdin, PostToolUseFailure | The PreToolUse fields plus `error` (text), `is_interrupt` (bool) and `duration_ms`. There is no `tool_response`. | `{"error":"Exit code 3\nPROBE-RAN fail -> exit 3","is_interrupt":false,"duration_ms":384}` |
| Sizes, long Bash | Output of 195.3 KB: Post `tool_response.stdout` is capped near 30 000 chars, with `persistedOutputPath` pointing to the full file under `~/.claude/projects/…/tool-results/`. Post stdin: 31 221 bytes. | Run A, `pnpm -s test long`. |
| Sizes, 1 MB Edit/Write | **Post stdin reaches 2 MB.** Edit of a 1.06 MB file: Post stdin 1 070 886 bytes (`originalFile` 1 069 491). Write of `small` over a 1.06 MB file: Post stdin 2 160 891 bytes (`originalFile` 1 069 491 plus `structuredPatch` 1 090 570). Pre stdin for a Write is the content plus about 510 bytes: 1 160 bytes of input gave 1 667. A Write whose content is 1 MB could not be produced, because haiku cannot emit 1 MB in one call. By that arithmetic its Pre stdin is about 1 MB (estimated, not measured). | Run L hook log. |
| Deny forms honoured | Both block, for Bash, Write and MCP. The model sees different text for each. **(a)** stdout `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<r>"}}` with exit 0 gives the tool result `PreToolUse:Bash hook error: <r>`. **(b)** Exit 2 gives `PreToolUse:Bash hook error: [<the full hook command line>]: <stderr>`. So exit 2 shows the model the hook's whole command line. | Run B steps 2, 3, 10, 11. `blocked.txt` was not created. The call is listed in `result.permission_denials`. |
| Failure modes, raw | **All of them allow the tool.** Exit 1; a thrown error (exit 1); `process.abort()` (SIGABRT); invalid stdout `{not json` with exit 0; no stdout with exit 0; the command not found (`/opt/homebrew/bin/node-missing`, sh exit 127); the CLI's own timeout. In each case the tool ran and PostToolUse fired. | Run B: `PROBE-RAN 1tixe-esac`, `…worht…`, `…troba…`, `…dilavni…`, `…tnelis…`, `…tuoemit…`. Run C: the Write with the missing node created `notes3.txt`. |
| Failure modes, wrapped `<cmd> \|\| exit 2` | The CLI runs the command through `/bin/sh` (`/bin/sh: /opt/homebrew/bin/node-missing: No such file or directory`). With the wrapper, these **block**: exit 1, a thrown error, abort, and command not found. These **still allow**: invalid stdout with exit 0 (the wrapper sees 0), and the CLI's timeout. | Run C: the tool results quote `… \|\| exit 2]: mc-guard: spike exit 1`, the stack trace, and the abort's native trace. The Edit with the missing node was refused, and `README.md` is unchanged. `case-invalid` and `case-timeout` ran. |
| The CLI's hook timeout | The CLI sends SIGTERM to the hook at the timeout (9 926 ms for `timeout: 10`), ignores its output, and **runs the tool**. | Hook log: `{'phase': 'SIGTERM', 'afterMs': 9926}`, then `PROBE-RAN tuoemit-esac`. |
| Largest hook `timeout` honoured: no cap found up to 660 s waited | `86400` (s) is accepted, and the CLI waited the hook out: 301 s for the fetch test, and 660 s for the `node:http` test (the hook answered at 660 022 ms and the tool then ran). No clamp was seen. The command-hook path is `timeout*1000` with no `Math.min` (CLI source, by `strings`). | Run F. |
| `fetch` on a 6-minute hold | **Cut off at 300 s.** `fetch` fails with `TypeError: fetch failed`, `cause: UND_ERR_HEADERS_TIMEOUT`, after 301 378 ms; the server saw the socket close at 301 365 ms. `node:http` `request()` has no such limit: a 660 s hold got its `200 {}` at 660 019 ms. | Run F hook log and server log. |
| Ordering against the rules | **For Bash, PreToolUse runs before the allow and deny rules, and `{}` leaves them in force.** These all reached the hook, which answered `{}`, and the CLI then refused them: a `--disallowedTools` hit (`curl …`: "Permission to use Bash with command curl … has been denied."), a command with no allow rule (`pnpm test`: "This command requires approval"), and a Write outside the area ("… but you haven't granted it yet."). A Write to a **denied** path (`sub2/package.json`) is refused before PreToolUse ("File is in a directory that is denied by your permission settings."); the hook never saw it. | Runs A, D, N. |
| Hook `"permissionDecision":"allow"` | It **overrides a missing allow rule** (`pnpm test case-allow` ran; a Write outside the area was written). It **does not override `--disallowedTools`** (`curl` was still denied) and does not lift the sandbox. With **no** allow rule for a call, a failed hook leaves the CLI to fall back to the rules. Three failure modes were tested this way, and each gave "This command requires approval": exit 1, invalid stdout, and the CLI's timeout. A crash, a signal and the command not found were not tested under this setup. | Runs D, N. `outside-area.txt` exists, `outside-area-2.txt` does not. |
| Post on a failing command | `PostToolUseFailure` fires with `error` and `is_interrupt: false`. | Run A, `pnpm -s test fail`. |
| Post on an interrupt during the command | **No Post event of either kind.** The command is killed (no process left). The stream gives a `tool_result` with `is_error: true` ("The user doesn't want to proceed…") for that `tool_use_id`, then `[Request interrupted by user for tool use]`, then a `result` with `error_during_execution`. Background tasks were on in one run (the stream also had `system/task_notification {status:"stopped", tool_use_id}`) and off in the other. | Runs E and E3: no Post record for `sleep60`. |
| Post on a Bash timeout | Background tasks on (the default): the command is **moved to the background, not killed**. PostToolUse (success) fires at the timeout with `backgroundTaskId` and `timedOutAfterMs: 5000` while the command keeps running. It finished 25 s later (`system/task_notification {status:"completed", tool_use_id}`), and no hook fired then. With `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` the command is killed. `PostToolUseFailure` then fires with `"Exit code 143\nCommand timed out after 5s"`. | Runs E and E2. |
| Post on `run_in_background: true` | Background tasks on: PreToolUse shows `"run_in_background": true`. PostToolUse fires at once (`duration_ms: 8`, `backgroundTaskId`) while the command runs on, and no hook fires when it ends. With `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` the parameter is gone from the schema. The call fails `InputValidationError: … unexpected parameter run_in_background` before PreToolUse. | Runs E and E2. |
| An interrupt while the hook waits | The hook **is killed**: SIGTERM 4.9 s after it started. The tool does not run, and no Post fires. | Run E: `{'phase': 'SIGTERM', 'afterMs': 4925, 'action': 'sleep:60'}`. |
| A call the hook allowed (`{}`) that the CLI refuses | **No event follows.** There is no PermissionDenied (although registered) and no Post. Only the stream says so: `system/permission_denied {tool_name, tool_use_id, decision_reason}`, then the tool result. | Run A: `pnpm test`, `curl`. |
| Reach | **The hook runs outside the sandbox.** Its `fetch('http://127.0.0.1:7462/health')` returned 200, and it read the 0600 file in the data dir (which the sandbox read-denies). The same two from sandboxed Bash (`pnpm -s test reach`) failed: `SANDBOX-NET-ERR fetch failed EPERM` and `SANDBOX-FILE-ERR EPERM`. | Run A hook log: `{'net': {'status': 200, 'body': 'mcp-spike-ok'}, 'file': {'ok': True}}`. Run B step 12. |
| The hook's env and process | The hook gets the CLI's env (the crew env) plus these: `CLAUDECODE=1`, `CLAUDE_PROJECT_DIR=<worktree>`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`, `CLAUDE_CODE_ENTRYPOINT=sdk-cli`, `CLAUDE_EFFORT`, `AI_AGENT`, `CLAUDE_CODE_CHILD_SESSION=1`, `CLAUDE_CODE_SESSION_ATTENDED=0`, `COREPACK_ENABLE_AUTO_PIN=0`, `PWD`, `SHLVL`. There is no token or `ANTHROPIC_*`. The cwd is the worktree. The ppid is the CLI's pid: sh execs a simple command. | Run A hook log `env`. |

## Step 3: the sandbox without git writes

The hub's sandbox JSON was changed in two ways:
- `allowWrite: []`;
- `denyWrite: [<worktree>/.git, <clone>/.git, <clone>/.git/worktrees/guido-1]`.

The worktree is a linked worktree of the `mc/` clone. `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` was set. These extra allow rules were added, so that the sandbox (not the CLI) is what refuses: `Bash(git update-ref:*)`, and `Bash(node <scratch>/probe-git.mjs:*)`, a script that opens git-dir files with `a` (no bytes written) and creates new ones with `wx`.

| Check | Result |
|---|---|
| `git status`, `git diff`, `git diff --stat`, `git log` | Work, clean or dirty. After an Edit, `git status` shows `modified: README.md`, `git diff --stat` shows `README.md \| 1 +`, and `git diff` shows the hunk. There is no index.lock warning. |
| Full `pnpm -s test` (this repo's suite, sandboxed) | `Test Files 78 passed (78)`, `Tests 1700 passed (1700)`, 25.5 s; the unsandboxed baseline took 28 s. |
| `git commit --allow-empty -m probe-commit` | Refused: `fatal: Unable to create '…/.git/worktrees/guido-1/index.lock': Operation not permitted`. |
| `git add README.md` | Refused, with the same `index.lock` error. |
| `git update-ref refs/heads/probe-ref HEAD` | Refused: `cannot lock ref 'refs/heads/probe-ref': Unable to create '…/.git/refs/heads/probe-ref.lock': Operation not permitted`. |
| Writes under `.git/objects` | Refused: `DENIED EPERM` for `objects/probe-new-file` and `objects/pack/probe-new-file`, and EPERM for opening an existing loose object for write. |
| Creating `<worktree git dir>/config.worktree` (#31) | Refused: `DENIED EPERM …/.git/worktrees/guido-1/config.worktree`, for a file that did not exist. |
| Everything else probed | `DENIED EPERM` for each of the following. Clone: `HEAD`, `index`, `packed-refs`, `config`, `logs/HEAD`, `refs/heads/feature/1-probe`, a new `refs/heads/…` and `refs/heads/feature/…`, `hooks/…`, `info/…`. Worktree git dir: `HEAD`, `index`, `commondir`, `gitdir`, a new file. Also the worktree's `.git` file. `git log` afterwards: still `602a9d4`. |
| Same probe under the hub's current sandbox, for comparison | `git commit` and `git update-ref` succeeded. These were writable: `logs/HEAD`, `refs/heads/feature/1-probe`, the worktree's `HEAD` and `index`. These could be created: new files in `objects/` and `objects/pack/`, `refs/heads/probe-new-ref`, `refs/heads/feature/probe-new-ref`, a new file in the worktree's git dir. The CLI's own opening of the clone's git dir to a linked worktree (Plan 5's note) does **not** survive an explicit `denyWrite` on the whole git dir. |

## Gate (Step 4)

| Item | Result |
|---|---|
| Hooks fire under `--restricted` | **Pass.** |
| Some deny form blocks the tool | **Pass.** Both the JSON `permissionDecision: "deny"` and exit 2 block it. |
| Every hook failure mode blocks, or there is a recorded way to make it block | **Pass, conditional.** Run raw, every mode lets the tool run. **(1)** `<cmd> \|\| exit 2` makes a crash, a signal, a non-2 exit and the command not found block. **With `\|\| exit 2` alone, two modes still let the tool run: the CLI's own hook timeout, and exit 0 with invalid stdout.** **(2)** Answering `allow` with no allow rule for the call: tested for exit 1, invalid stdout and the CLI timeout, all denied; the other modes are untested under (2). The controller's ruling for Task 5 is in Consequences: way (1), plus the hook's own deadline and its fixed stdout. Way (2) is rejected. The residual is accepted. |
| The hook runs outside the sandbox | **Pass.** |
| `--mcp-config` works with a header | **Pass**, from a 0600 file. |
| Git reads work without git-dir writes | **Pass**, and the full suite too. |

## Consequences for Tasks 3–11

- **Deny output.** Exit 0 with stdout exactly `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<text>"}}`. The model sees `PreToolUse:<Tool> hook error: <text>`.
  - Exit 2 also blocks: it is the code for the hook's own failures. The model then sees the hook's whole command line and its stderr. So the command line must hold nothing secret: no token, only paths. Stderr should be one fixed line.
  - Never answer `"permissionDecision":"allow"` while the guard relies on the allow rules. It overrides a missing allow rule (a Write outside the area went through). `{}` (exit 0) is the "no objection" answer, and the CLI's rules still apply after it.
- **Hook command (the controller's ruling for Task 5).**
  - The command is wrapped: `<crew.node> <hook script> <args> || exit 2`. The CLI runs it through `/bin/sh`, so a crash, a signal, a non-2 exit and a missing node all become exit 2.
  - With `|| exit 2` alone, two modes still let the tool run: the CLI's own hook timeout, and exit 0 with invalid stdout. The ruling closes both in the hook:
    - **A hard internal deadline** (`HOOK_DEADLINE_MS`), well inside the CLI's hook `timeout`. On expiry the hook exits 2.
    - **Its stdout is built in code** and is only ever one of the two fixed forms: `{}` or the deny shape. Text is never relayed.
  - **Way (2) is rejected**, because answering `allow` bypasses the anchored area rules (run N wrote a file outside the area).
  - **Residual, accepted:** a hook process wedged past the CLI's timeout lets that one call run. The allowlist, the area rules and the OS sandbox remain underneath it.
- **Events.**
  - `PreToolUse` (matcher `*`).
  - `PostToolUse` and `PostToolUseFailure` (matcher `Bash`, or the tools whose calls hold the lock).
  - `PermissionDenied` never fires in `-p` default mode.
  - **There is no Post at all for an interrupted call, a hook-denied call, or a call the CLI refuses after `{}`.** A lock released only on Post therefore leaks on interrupt and on refusal. Task 5 needs another release path, keyed by `tool_use_id`. Candidates, each seen in the stream but not yet tried as a release mechanism: the `tool_result` for that `tool_use_id`, `system/permission_denied {tool_use_id}`, and the turn's `result`. A turn end and a process exit are further candidates.
- **Background Bash.** Set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` in `CREW_CLI_ENV`.
  - Without it, a Bash timeout moves the command to the background and fires a successful PostToolUse while the suite keeps running. That would release the lock early.
  - `run_in_background: true` returns at once. With the variable set, a timeout kills the command (PostToolUseFailure, exit 143), and `run_in_background` is rejected by schema before any hook.
  - Without it, the guard must deny `tool_input.run_in_background === true`. That field is in Pre stdin.
- **stdin field names.**
  - Pre: `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `effort`, `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`, and `mcp_server` for MCP tools.
  - Post adds `tool_response` and `duration_ms`.
  - PostToolUseFailure adds `error`, `is_interrupt` and `duration_ms`, with no `tool_response`.
  - Bash `tool_input`: `command`, `description`, and optionally `timeout` and `run_in_background`.
- **Sizes.**
  - Pre stdin is about 510 bytes plus `tool_input`. A Write's content is all in it, so 1 MB of content is about 1 MB of stdin (estimated; no 1 MB Write was produced).
  - Post stdin can exceed 2 MB (`originalFile`, `structuredPatch`).
  - Against `/api/guard/check`'s 64 KiB limit, the hook must send only what the guard needs: tool name, `tool_use_id`, `command`, `file_path`. It must not forward the raw stdin, and it must read all of stdin before answering.
- **Largest honoured hook timeout: no cap found up to 660 s waited.** `86400` was accepted and honoured for the 660 s that was waited. Pick the CLI timeout from how long the lock may make a seat wait, with the hook's own deadline below it.
- **Holding the request.** Do **not** use `fetch` for a hold longer than 300 s: undici's headers timeout cuts it at 300 s (`UND_ERR_HEADERS_TIMEOUT`). Use `node:http` `request()`, which held for 660 s and got its answer. Or keep each hold under 300 s and re-ask.
- **The hook's reach.** It runs outside the sandbox, with the crew env plus the `CLAUDE_*` variables. It can reach `127.0.0.1:<hub port>` and read the 0600 token file in `{DB dir}/crew/`. Sandboxed Bash can do neither.
- **MCP tool names.** `mcp__mc__<tool>` (server key `mc`). Put each one in `--allowedTools` under that name, and match the guard on `tool_name` starting `mcp__mc__`.
- **`protocolVersion`.** Answer `initialize` with the client's `2025-11-25`; `2025-06-18` is also accepted.
  - The hub should answer `server/discover` (sent first, with `2026-07-28`) with a JSON-RPC error, `-32601`, so the CLI falls back to `initialize`.
  - Answer `notifications/initialized` with 202, and `GET /mcp` with 405.
  - An unknown version fails the server (`status: "failed"`).
- **MCP auth and timeout.**
  - A 401 fails the server for the session: no tools, no retry, no OAuth. Keep 401 bodies free of anything sensitive, because the MCP log stores them.
  - The default tool-call timeout is 60 s. Set a per-server `"timeout"` (ms) in the config for long calls (push, draft PR); 150 000 was honoured.
  - Tool calls carry `_meta["claudecode/toolUseId"]`, seen on the 4 calls logged here, which can tie an mcp call to its guard check.
- **Token in config.** Pass `--mcp-config <0600 file path>`, never inline JSON, which puts the token in argv. Nothing else seen leaks the token: the init event, the transcripts, `~/.claude`, the MCP logs (which redact `Authorization`), and the hook's stdin and env.
- **The sandbox without git writes.**
  - Use `allowWrite: []` and `denyWrite: [<worktree>/.git, <gitCommonDir>, <worktreeGitDir>]` for every seat.
  - Git reads and the full suite still work. Commit, add, update-ref, objects writes and `config.worktree` all fail.
  - For sandboxed code, this also closes the R19 and R24 paths probed here (other seats' refs, new and existing objects).
  - `Bash(git add:*)` and `Bash(git commit:*)` can leave `WRITER_TOOLS`, because they can only fail now.

## Sandbox escape probe (run 2026-10-20, Plan 6 Task 2)

Question: can code a crew seat writes and runs **inside** the CLI's OS sandbox start a process
**outside** it? Tested the three channels in the brief: `launchctl submit`, `osascript do shell
script`, and `open`.

### Setup

- A real haiku seat, driven the way Task 1 drives (`bin/drive.ts cfg/escape.json`, stream-json), with
  this branch's own `crewCliArgs` and the hub's default writer sandbox (no hook, no MCP needed). The
  seat ran exactly one Bash call: `pnpm -s test escape`, which runs the committed probe
  (`probe/worktrees/guido-1/probe.mjs`, case `escape`) as `node probe.mjs escape` — so the escape code
  runs **inside** the sandbox that wraps every seat Bash. Argv in `runs/escape/argv.json`; stream in
  `runs/escape/stream.jsonl`.
- **Canaries** go in `/private/tmp/claude-501/mc-plan6-build/escape/out/`, which is in no `allowWrite`
  path. To make the control unconditional (the sandbox profile grants temp dirs by default, and this
  path sits under `/private/tmp`), the run also adds `.../escape` to the sandbox `denyWrite`
  (`cfg.denyWriteExtra`). `denyWrite` binds only sandboxed code; a process that genuinely escaped runs
  **unsandboxed**, so `denyWrite` cannot mask an escape — it only guarantees the in-sandbox control
  fails.
- `probe.mjs escape` runs, in order: a direct write to the canary dir (control), `launchctl submit`
  then `launchctl remove` (label `mc.probe.escape` only), `osascript -e 'do shell script "touch …"'`,
  and `open -g escape/x.command` (a `.command` that touches `canary3`).

### Attempts and exact results (all from inside the sandbox)

| # | Channel | Exact result inside the sandbox | Canary | Out-of-sandbox control |
|---|---|---|---|---|
| 0 | direct write to `escape/out/canary0` | **Fails.** `EPERM: operation not permitted, open '…/escape/out/canary0'` | `canary0` absent | n/a — proves the canary dir is not writable from the sandbox, so the probe means something |
| 1 | `launchctl submit -l mc.probe.escape -- /usr/bin/touch …/canary` | **Fails.** exit status 1, no stderr. The follow-up `launchctl remove mc.probe.escape` then exits 3 (no such job — submit created none). | `canary` absent | Outside the sandbox the identical submit exits 0, the job lists as `mc.probe.escape`, `canary_outside` is created, and `remove` exits 0. So the form works; the sandbox is what blocks it. |
| 2 | `osascript -e 'do shell script "touch …/canary2"'` | **Fails.** exit status 1, `0:8: syntax error: A identifier can't go after this identifier. (-2740)` — under the sandbox `osascript` cannot load the Scripting Addition that defines `do shell script`, so the script will not even parse and no shell runs. | `canary2` absent | Outside the sandbox the identical `-e` string exits 0 and creates the canary. So the AppleScript is valid; the sandbox is what blocks it. |
| 3 | `open -g …/escape/x.command` | **Fails.** exit status 1, `sandbox_extension_issue_file failed for …/escape/x.command: 1 (Operation not permitted) The application cannot be opened for an unexpected reason …` — an explicit sandbox denial; Terminal never launched (0 Terminal windows after the run). | `canary3` absent | No outside run (it would open a Terminal window); the in-sandbox failure is an explicit sandbox denial (`sandbox_extension_issue_file … Operation not permitted`). |

The outside controls for rows 1 and 2 were run unsandboxed, from scratch only, and their output is
saved in `runs/escape/controls.log`:

```
$ launchctl list | grep mc.probe   # baseline
(none)
$ launchctl submit -l mc.probe.escape -- /usr/bin/touch /private/tmp/claude-501/mc-plan6-build/escape/out/canary_outside
exit=0
$ launchctl list | grep mc.probe
-	0	mc.probe.escape
$ ls escape/out
canary_outside
$ launchctl remove mc.probe.escape
exit=0
$ launchctl list | grep mc.probe   # after remove
(none)
$ osascript -e 'do shell script "touch /private/tmp/claude-501/mc-plan6-build/escape/out/canary2_outside"'

exit=0
$ ls escape/out
canary2_outside
canary_outside
$ rm escape/out/canary_outside escape/out/canary2_outside
$ ls -A escape/out   # after cleanup
```

After the run: `escape/out/` empty (no `canary0/canary/canary2/canary3`); `launchctl list | grep
mc.probe` → gone; Terminal window count → 0 (the blocked `open` spawned nothing to close).

### Verdict — escape possible? **No, for the three forms tested.**

- **launchctl** (`submit`): **no escape.** Blocked (exit 1, no job, no canary); works unsandboxed.
- **osascript** (`do shell script`): **no escape.** Blocked (parse error -2740, no canary); works unsandboxed.
- **open** (`open -g` a `.command`): **no escape.** Blocked by an explicit sandbox denial; Terminal never launched; no canary.

No canary appeared, so there is nothing to escalate. `launchctl submit`, `osascript -e 'do shell
script …'` and `open -g <file>.command` were blocked from sandboxed seat code. Other forms
(launchctl bootstrap/load/kickstart, AppleEvents to other apps, open -a/-b/URL schemes) were not
tested. A typed `launchctl` is already refused by the allowlist; for these three forms run from
seat-written code, the OS sandbox is what stops them, so a deny-list entry alone would not be the fix.

## Confined reads and the data-protection keychain (run 2026-10-20, Plan 6 Task 7)

CLI 2.1.302 (init reported `claude-haiku-5-5` for `--model haiku`), node 25.9.0, the operator's Max login.
Swift 6.4 (`swiftc` from the Xcode CLT).

### Setup

- Scratch only, under `/private/tmp/claude-501/mc-task7/`: a one-commit repo `clone/` with a linked
  worktree `worktrees/guido-1` (branch `feature/1-probe`), a data dir `data/`, and a folder
  `denied/` holding one dummy file, `secret.txt`, whose content is a random canary.
- One real haiku seat, driven over stream-json by `bin/drive.ts`, with this branch's own
  `crewCliArgs` (writer mode, the hub's sandbox, `CREW_CLI_ENV`, the launchd PATH). The new
  `sandbox.denyRead` input was `[<this worktree>, <scratch>/denied]`: the first stands in for the
  hub's checkout, the second for a `crew.deny_read` folder. The hook was `/usr/bin/true` and the MCP
  config listed no servers. No live hub, DB, loop or `~/code/mc-crew` path was used.
- The seat ran exactly two Bash calls, each the allowed `pnpm -s test <case>`, which runs the
  committed `probe.mjs <case>` inside the sandbox. Argv in `runs/confine/argv.json`, stream in
  `runs/confine/stream.jsonl`.
- The keychain probe `bin/kc` (`kc.swift`) calls `SecItemCopyMatching` with
  `kSecClass = kSecClassGenericPassword`, `kSecAttrService = "mc-probe-nonexistent-<12 random hex>"`,
  `kSecUseDataProtectionKeychain = true`, `kSecMatchLimitOne`, and no `kSecReturn*` key, so nothing
  would be returned even on a match. It prints only the OSStatus. No real item was queried, listed or
  read.

### Results

| Check | Unsandboxed (control) | Inside the seat's sandbox |
|---|---|---|
| read `ok.txt` in the worktree | OK, the canary | **OK**, `WT-CANARY` |
| read `denied/secret.txt` (node) | OK, the canary | **Refused:** `EPERM: operation not permitted, open '…/mc-task7/denied/secret.txt'` |
| list `denied/` | OK, `secret.txt` | **Refused:** `EPERM: operation not permitted, scandir '…/mc-task7/denied'` |
| `/bin/cat denied/secret.txt` (a child process) | OK, the canary | **Refused:** `Command failed`, nothing printed |
| read `package.json` in the "hub" path | OK | **Refused:** `EPERM: operation not permitted, open '…/phase-2b/package.json'` |
| keychain probe (#31) | `OSStatus -25300` | **`OSStatus -25300`** |

### Verdict

- **`denyRead` confines agent-run code** to what it is granted. A listed folder can be neither read
  nor listed, by the probe's own node process or by a child process. The worktree stays readable,
  and the allowed `pnpm -s test` still runs.
- **The data-protection keychain is reachable from inside the sandbox** (#31). `-25300` is
  `errSecItemNotFound`: securityd answered the query rather than refusing it (`-34018`, no
  entitlement) or the sandbox denying it. The `Library/Keychains` `denyRead` blocks the login
  keychain *file*. Data-protection items are served over XPC by securityd, so a file rule doesn't
  apply to them. Whether an unsigned, unentitled binary could read a real item depends on that item's
  access group. That was not tested, since it would mean querying a real item. Typed `security` is
  already refused by name. Code a seat writes can still reach securityd, so this stays open on #31,
  with the push-time secret scan as the backstop.

## End to end on the real CLI (run 2026-10-21, Plan 6 Task 11)

CLI 2.1.302 (init reported `claude-haiku-5-5` for `--model haiku`), node 25.9.0, pnpm 11.0.6, the operator's
Max login. This branch at `0510a52`, built, run through the real supervisor: no harness, no argv
added.

### Setup

- **The preview.** Run from this branch's checkout with
  `node --experimental-strip-types apps/server/src/main.ts` and `MC_PORT=7431`,
  `MC_DB=<scratch>/data/mc.sqlite` (a `sqlite3 ".backup"` copy of the live DB),
  `MC_CONFIG=<scratch>/config.yaml`, `MC_NO_LOOP_WRITES=1`, `MC_CREW=1` and
  `MC_GH_COMMAND=<scratch>/fake-gh`. Scratch was `/private/tmp/mc-t11/`, deleted afterwards. The
  preview was started in the background and stopped with `kill <pid>` once
  `ps -o command= -p <pid>` showed it.
  - Its `PATH` began with a shim `gh` that logged each call. It passed only `gh auth token` to the
    real gh: that is the read the collectors and the push scan's known-secret list make. Anything
    else it refused. Over the run it logged 6 calls, all `auth token`. Nothing else reached the
    real gh.
  - The fake gh logged argv, cwd, env keys and the body file. It answered `pr list` with `[]` (or
    the PR it had made) and `pr create` with a `https://github.com/…/pull/900n` URL. GitHub was
    only read: the issue reads for the two starts, and one board poll.
- **The config.** No loops. One repo, `mission-control` (`octo-org/mission-control`, so the
  two starts read real issues #52 and #31), with `full_suite: ["pnpm -s test"]`. A `crew` section
  with `worktrees` under scratch, `node: /opt/homebrew/bin/node`, `deny_read: []`, and one session.
  Its checkout was a scratch clone whose origin was a local bare repo in scratch. It had two writer
  seats, both GUIDO on haiku: `t11-a` (area `a/**`, issue #52) and `t11-b` (area `b/**`,
  issue #31).
- **The repo.** `package.json` (`"test": "node test.mjs"`), a committed `pnpm-lock.yaml`, and
  `.gitignore` holding `node_modules/`. `test.mjs` takes a path argument and runs only that file.
  With no argument it is the full suite: it checks `a/hello.txt` and `b/hello.txt`, then sleeps
  60 s, printing timestamps at its start and end. `probes/git-commit.mjs` runs `git add -A` and
  `git commit --allow-empty` and prints how each ended. Run unsandboxed in the seed repo, both
  succeeded.
- **Driving.** `POST /api/seats/<id>/start`, then `POST /api/seats/<id>/message` with
  `interrupt: true` and the steps. The ticket was set aside. Results were read from the run
  transcripts, `/api/test-lock`, `/api/guard/hits`, `/api/attention`, the bare origin, the fake
  gh's log, and the preview HUD (Comms and the header).

### Results

| Check | What was done | What happened | Result |
|---|---|---|---|
| Seat start | Started `t11-a` on #52 and `t11-b` on #31. | `system/init` showed `mcp_servers: [{"name":"mc","status":"connected"}]` for both. Their worktrees were `worktrees/t11-a-52` and `worktrees/t11-b-31`, on `feature/52-…` and `feature/31-…`. | Pass |
| Change one line | `t11-a`: Edit `a/hello.txt`. | Written. | Pass |
| `mc commit` | `t11-a`: `mcp__mc__commit`, `chore: edit the greeting in area a`. The seat added a `Co-Authored-By` trailer on its own. | `Committed 9d8cb62 on feature/52-…: chore: edit the greeting in area a`. Author `T11-A (Mission Control) <t11@example.invalid>`, committer name `T11-A (Mission Control)`. | Pass |
| Full suite | `t11-a`: Bash `pnpm -s test`. | `/api/test-lock` holder: `t11-a`, `pnpm -s test`. The suite ran 03:07:28–03:08:28Z and passed. | Pass |
| `mc push` | `t11-a`: `mcp__mc__push`. | `Pushed 9d8cb62 to feature/52-….` The bare origin got `refs/heads/feature/52-…` at `9d8cb62`, and `main` did not move. | Pass |
| `mc draft_pr` | `t11-a`: `mcp__mc__draft_pr`, title `chore: edit the greeting in area a`, a one-line body. | It answered `https://github.com/octo-org/mission-control/pull/9001`. The fake gh got two calls, both in `{DB dir}/crew/` with env `PATH`, `HOME` and `GH_PROMPT_DISABLED` (plus macOS's `__CF_USER_TEXT_ENCODING`). First `pr list --repo=octo-org/mission-control --head=feature/52-… --state=open --json=url`, then `pr create --repo=… --draft --head=feature/52-… --base=main --title=… --body-file=…/pr-<uuid>.md`. The body file held the seat's line, `Closes #52.` and `Opened by T11-A (Mission Control).`, and was gone afterwards. | Pass |
| Typed `git commit` | `t11-b`: Bash `git commit --allow-empty -m "guard probe"`. | `PreToolUse:Bash hook error: git writes only through the mc commit, push and draft-PR tools: git commit`. Guard hit 1: `t11-b`, rule `git-write`. | Pass |
| Typed `git push` | `t11-b`: Bash `git push origin HEAD`. | `PreToolUse:Bash hook error: git writes only through the mc commit, push and draft-PR tools: git push`. Guard hit 2: `t11-b`, rule `git-write`. | Pass |
| Sandboxed `git commit` | `t11-b`: Bash `pnpm -s test probes/git-commit.mjs`. The probe runs in the seat's sandbox; a path argument keeps it from being a full suite. | `git add` and `git commit` both failed with exit 128: `fatal: Unable to create '/private/tmp/mc-t11/clone/.git/worktrees/t11-b-31/index.lock': Operation not permitted`. | Pass |
| Fake `ghp_` token | `t11-a` wrote `a/fixture.txt` holding `token = ghp_` plus 36 letters and digits, committed it with `mc commit`, then called `mc push`. | The commit went through (`8e3dcd5`). The push was refused: `Not pushed: a/fixture.txt:1 looks like a GitHub token. Remove it from the branch's history, then push again.` Guard hit 3: `t11-a`, rule `secret`, text `No secrets in a push: mc push` (no token in it). The origin branch stayed at `9d8cb62`. | Pass (but see finding 2) |
| Second seat's suite waits | While `t11-a`'s suite held the lock, `t11-b` was told to run `pnpm -s test`. | `/api/test-lock` listed `t11-b` waiting from 03:07:46Z. It was granted at 03:08:28.3Z, the second `t11-a`'s suite ended. Its suite ran 03:08:29–03:09:29Z. The seat never saw the wait: its Bash call just took longer. | Pass |
| Stop by PID | `kill 94420` after checking its command line. | The log says `SIGTERM: shutting down`. Both seat CLIs (children 52877 and 78223) exited, and both runs' `.token` and `.mcp.json` files were removed. The live hub (pid 25969, port 7420) was untouched. | Pass |

**The HUD (Task 10), on the preview:**
- **Lock box** (while `t11-b` waited): `Full test suite · one at a time`,
  `T11-A holds it: pnpm -s test · 0:52`, `T11-B waiting · 0:33`. The header read
  `Lock: T11-A +1`, and `Lock: free` once both suites were done.
- **Needs you**, after finding 1's refusal: a `Question` item (`T11-A asks: …`, with Open and Ack)
  and a `Stray file` item: `.pnpm-store/v11/index.db changed in s/t11 outside every agent's area`.
  Both were gone after the seat's next commit and message. The copy's two loop escalations were
  listed as well.
- **Guard drawer:** `Guard: nothing blocked this week.` before the checks. After them it read
  `Guard: 3 blocked commands, 3 new (for information)`. Opened, it listed the three hits newest
  first, each with its seat, text, `04:10 · rule: <rule>` and a named `Ack` button.

### Findings

1. **A sandboxed `pnpm` run leaves `.pnpm-store/` in the worktree.** After each seat's first
   `pnpm -s test`, its worktree root held an untracked `.pnpm-store/v11/` (`index.db` and an empty
   `files/` tree). The hub's install did not make it, and neither did unsandboxed runs in the seed
   repo; the global store (`pnpm store path`) is `~/Library/pnpm/store/v11`, outside the seat's
   writable area. The commit tool's `add -A` picked it up:
   - `t11-a`'s next commit was refused (`Not committed: .pnpm-store/v11/index.db is outside your
     area (a/**).`) and recorded a stray;
   - a seat with no `area` would have committed it, and pushed it.

   This repo's `.gitignore` does not list `.pnpm-store/`. To go on, the run added `.pnpm-store/`
   to the scratch clone's `.git/info/exclude`.
2. **The secret refusal asks for something a seat cannot do.** "Remove it from the branch's
   history, then push again" is the plan's text, but a seat has no git writes, and the commit tool
   only adds commits. The seat said so, did not ask the operator (the text doesn't tell it to), and
   stopped. The refusal also makes no Needs-you item, only a guard hit (rule `secret`). Compare the
   message-reference refusal, which tells the seat to use `ask_operator`.
