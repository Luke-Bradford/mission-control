# Spike: driving `claude -p` over stream-json both ways

Date: 2026-10-20. CLI 2.1.302 on this Mac, the operator's Max login, model `haiku`, run in a scratch directory. This answers spec §5's check-first list ("mid-turn message, interrupt, context-usage report, rate-limit events, and that it bills to the subscription") and §9's "CLI stream-json mid-turn messages, interrupt, context-usage breakdown". Decision: **the agent runtime drives the CLI directly; the Agent SDK is not needed for any capability.**

## Command

```
claude -p --input-format stream-json --output-format stream-json --verbose --model haiku \
  [--setting-sources project,local --strict-mcp-config] [--allowedTools …]
```

Input lines: `{"type":"user","message":{"role":"user","content":"…"}}` and `{"type":"control_request","request_id":"<id>","request":{"subtype":"<name>"}}`. Output is the stream-json the loops already write (Plan 3 §Task 2 shapes), plus `{"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":{…}}}`.

## Results

| Check | Result |
|---|---|
| Plain turn | `system/init` → `assistant` → `result` (`is_error: false`); the process stays up and reads the next line. |
| Mid-turn message | A second user line written while the first turn's `Bash sleep 8` was running was folded into **the same turn**: one `result`, reply "done\n\nbanana". No second turn started. |
| Interrupt | `control_request {subtype:"interrupt"}` during a tool call → `control_response success {still_queued: []}`, then a `user` line `[Request interrupted by user]`, then a `result` (`stop_reason: "tool_use"`). The next user line starts a normal turn ("again"). |
| Context usage | `get_context_usage` → `categories: [{name, tokens, kind}]` (System prompt, System tools, System tools (deferred), MCP tools, Skills, Messages, Autocompact buffer, Free space) and `memoryFiles`. |
| Usage / billing | `get_usage` → `subscription_type: "max"`, `rate_limits_available: true`, `rate_limits.five_hour {utilization, resets_at}` (and the session's `model_usage`). `system/init` has `apiKeySource: "none"`. `rate_limit_event` lines arrive as in the loops' transcripts. Together: the run bills to the Max subscription. |
| Other control requests present in the CLI | `set_model`, `stop_task`, `set_permission_mode`, `get_status`, `get_session_cost`, `mcp_status`, `rewind_files` (not exercised). |
| Isolation from the operator's setup | Without flags the session ran the operator's SessionStart hooks, loaded their MCP servers (56k tokens of deferred tools), and a personal PreToolUse hook blocked `sleep 30`. With `--setting-sources project,local --strict-mcp-config`: no hooks fired, `mcp_servers: []`, `memoryFiles: []` (no user CLAUDE.md), auth unchanged (`apiKeySource: "none"`). Built-in plugins and skills remain (`--disable-slash-commands` removes skills). |
| `--bare` | Not usable: it reads only `ANTHROPIC_API_KEY` / `apiKeyHelper` ("OAuth and keychain are never read"), so it cannot use the subscription. |
| Tool allowlist | With `--allowedTools Read`, a `Bash` call is refused: `system/permission_denied {tool_name:"Bash"}`, the tool result says it needs approval, and `result.permission_denials` lists it. Nothing was written. |

## Consequences for phase 2

- One long-lived `claude -p` process per running seat, stdin kept open: Send = write a user line (reaches the agent mid-turn); Interrupt and send = `interrupt` then the user line; the context tile reads `get_context_usage`.
- Crew sessions run with `--restricted --strict-mcp-config --disable-slash-commands` plus `--tools <the mode's built-in set>`, on the default (`~/.claude`) login. `--restricted` ignores user, project and local settings (so the operator's hooks and CLAUDE.md never reach the crew, spec §8b.1), confines the file tools to the working directory, and removes Bash unless `--tools` names it; auth is unchanged (`apiKeySource: "none"`). It replaces the earlier `--setting-sources project,local`, which left the file tools unconfined. A separate config folder per account is only needed for a second account (phase 5).
- Until the guard (phase 2b), the hard stop is the CLI's allowlist (anything not on a seat's `--allowedTools` is denied in `-p` mode) plus an OS sandbox around every Bash (`--settings` `sandbox`, with `autoAllowBashIfSandboxed` off: it defaults to true, which would auto-allow any Bash the sandbox does not forbid and bypass the allowlist).
- The hub's children die with it under launchd, so a restart reattaches with `--resume <session id>` (spec §8b.2), not by re-adopting processes.

## Follow-up probes (2026-10-20, CLI 2.1.302, haiku)

Each ran one writer seat with the hub's own `crewCliArgs` in a scratch clone and worktree under
`/private/tmp/claude-501/mc-plan5-build/i4/`. Code the seat wrote ran through the allowed
`pnpm -s test`, which is how agent code reaches the OS sandbox.

| Check | Result |
|---|---|
| Hub API from sandboxed code | `fetch('http://127.0.0.1:7420/api/health')` → EPERM; curl → could not connect. The hub answered 200 outside the sandbox before and after. |
| Login keychain from sandboxed code | Before `Library/Keychains` was read-denied: `security list-keychains` listed `login.keychain-db` and `show-keychain-info` read it. After: the folder gives EPERM, only `/Library/Keychains/System.keychain` is listed, opening the login keychain gives "Operation not permitted", and the seat still runs (its own login is outside the sandbox). No real item was read: a canary write was refused. A lookup of a made-up item exits 44 either way, so it proves nothing. |
| File tools outside the worktree | Read, Grep and Glob on a scratch folder outside the worktree are refused ("… is outside … ; --restricted confines the file tools to the working directory"), and so are a symlinked file and a symlinked folder inside the worktree ("resolves through a symlink to …, which is outside …"). A Grep of the worktree does not follow the symlinked folder. Inside the worktree, Read returns the file. |
| Hard link out of a denied folder | From sandboxed code, `link(<read-denied dir>/canary.txt, ./canary-link)` fails EPERM; no link is made, so the Read tool has nothing to return. |
| Typed `security` and `curl` | `curl …` is refused by the deny list. `/usr/bin/security …; echo $?` was refused by the CLI's own check of compound commands, which says nothing about a plain `security …`; `Bash(security:*)` and `Bash(/usr/bin/security:*)` are now denied for that case. |
| `cd` in Bash (#41) | A `cd` outside the worktree is blocked by the CLI ("may only change directories to …"). A `cd` into a subfolder moves the CLI's working directory, and relative Edit/Write rules follow it: after `cd sub`, every edit in area `sub/**` was refused. Both of these fix it, while a write outside the area stays refused: `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` (Bash returns to the worktree after each command), or rules anchored as `Edit(//<worktree>/<glob>)`. |
| Anchored deny depth (#42) | A relative deny with no slash (`Edit(biome.json)`) matches at any depth: main's argv refused `sub/biome.json`. Anchored at the top only (`Edit(//<worktree>/biome.json)`), it did not, and the file was written. With a `**/` twin (`Edit(//<worktree>/**/biome.json)`) it is refused again, and so is `sub/.claude/x`; a plain file in the area still writes. |
