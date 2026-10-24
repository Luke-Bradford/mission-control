# Spike: can a Codex crew seat be confined and guarded like a Claude seat?

Date: 2026-10-24. Setup:

- codex-cli 0.154.0 (Homebrew), macOS 27.0.1, `main` at `0f1e650`;
- the protocol comes from `codex app-server generate-json-schema`;
- each behaviour comes from a real `codex exec` or `codex app-server` turn in a throwaway git repo, with a fake secret file next to it.

No product code changed. This answers the open question behind #426 and #427.

**Decision.** A Codex seat runs `codex app-server` under the existing keeper. The hub's floor is enforced like this:

| Control | Mechanism |
|---|---|
| Reads, writes and network | A Codex *permission profile* passed with `-c` |
| Command and file-edit approvals | Approval requests, answered by the hub's guard |

Nothing on the floor is weaker than for a Claude seat. A seat whose Codex cannot apply the profile, or whose thread does not report the `untrusted` approval policy, refuses to start.

## Findings

**1. An outer macOS sandbox does not work.**
`sandbox-exec -f deny.sb codex exec -s workspace-write …` stops every command, with `sandbox-exec: sandbox_apply: Operation not permitted`. Codex's own Seatbelt cannot nest inside another. So read confinement has to come from Codex's own sandbox.

**2. Codex permission profiles confine reads, writes and network, and the OS enforces them.**
The profile used:

```
-c 'default_permissions="mc"'
-c 'permissions.mc.filesystem={":root"="read", "<dir>/secret"="deny", ":workspace_roots"={"."="write"}}'
```

The results:

- **Reads:** a script the model could not see printed `cat: <dir>/secret/token.txt: Operation not permitted`.
- **Writes:** the same script's write outside the workspace gave `Operation not permitted`. A write inside the workspace succeeded.
- **Network:** `curl https://example.com` failed with `Could not resolve host`, because no `features.network_proxy` was set.

A direct `cat` of the denied path was declined by the model itself, since the policy is visible to it. That is why the script test, not the direct `cat`, is the evidence.

Docs: [Codex permissions](https://learn.chatgpt.com/docs/permissions). The feature is in beta.

- Deny beats write, and write beats read.
- Narrower entries beat broader ones.
- `deny` globs are supported.
- Profiles and `--sandbox`/`sandbox_mode` are mutually exclusive.

**3. With `approvalPolicy: "untrusted"`, every command and every file edit comes to the client to decide.**

A Node client drove one `turn/start` through `codex app-server`. It answered `accept`, except for `git commit` and `curl`, which it answered `decline`.

- `git status --short`, `touch`, `./check.sh` and `curl …` each arrived as `item/commandExecution/requestApproval`, with `params.command = "/bin/zsh -lc '<cmd>'"`.
  - Declined commands completed with status `declined`, and the model was told "rejected by user".
  - Nothing was committed.
- The model's file edit arrived as `item/fileChange/requestApproval`, with `itemId` only. The paths come from the preceding `item/started` (`item.changes[].path`).
- `turn/started` and `turn/completed` bracket the turn.
- `thread/tokenUsage/updated` carries `total.{inputTokens, cachedInputTokens, outputTokens, totalTokens}` after each step.

**4. `codex app-server` accepts an unknown `-c` key.**
`-c 'mc_run="<runId>"'` was accepted, and `initialize` answered normally. The keeper can use it as the process marker that `--session-id <id>` gives a Claude CLI.

**5. Protocol surface used.** Framing is newline-delimited JSON with no `"jsonrpc"` field, the same as `collectors/usage-sources.ts`.

- **Client requests:**
  - `initialize`, then the `initialized` notification;
  - `thread/start`: `cwd`, `model`, `approvalPolicy`, `developerInstructions`, `config`, `ephemeral`;
  - `thread/resume`: `threadId` and the same overrides;
  - `turn/start`: `threadId`, `input: [{type:"text", text}]`, `effort`;
  - `turn/steer`;
  - `turn/interrupt`.
- **Server requests:**
  - `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`;
  - `item/permissions/requestApproval`;
  - `item/tool/requestUserInput`;
  - `mcpServer/elicitation/request`.

  The approval decision is `{decision: "accept" | "decline" | …}`.
- **Notifications:**
  - `turn/started`, `turn/completed` (`turn.status`, `turn.error`);
  - `item/started`, `item/completed` (types `commandExecution`, `fileChange`, `agentMessage`, `mcpToolCall`, …);
  - `thread/tokenUsage/updated`, `account/rateLimits/updated`, `error`.

## Not tested

- **MCP grants:** a Codex seat calling the hub's MCP server. Docs: `[mcp_servers.<name>] url = …` with `bearer_token_env_var`. Step B's first test confirms this against a real `codex app-server`.
- **`thread/resume` after the app-server process is gone** (the no-keeper case). Threads are persisted under `~/.codex/sessions` unless `ephemeral`.
- **Approval requests replayed after a hub restart.** The keeper replays stdout lines, so a request the old hub never answered is replayed to the new one, which must answer it.

## Follow-up (same day, after the plan's review)

This was a second `codex app-server` turn with the following setup:

- a per-run `CODEX_HOME` holding only a copy of `auth.json` and a `config.toml` with `approvals_reviewer = "user"` and `project_doc_max_bytes = 0`;
- the `mc` profile, with the run's own `CODEX_HOME` denied;
- `-c 'shell_environment_policy.exclude=["MC_SEAT_TOKEN"]'`, with `MC_SEAT_TOKEN` set in the app-server's env;
- `thread/start` with `approvalPolicy:"untrusted"` and `approvalsReviewer:"user"`.

Every approval was answered `accept`, to see what runs.

| Question | Result |
|---|---|
| Does Codex auto-run "trusted" reads under `untrusted`? | **No.** `ls`, `cat a.txt`, `rg hi`, `sed -n 1p a.txt`, `git log --oneline` and `head -c 5 a.txt` each raised `item/commandExecution/requestApproval` first. Every command reaches the hub. |
| What does `thread/start` report? | `approvalPolicy:"untrusted"`, `approvalsReviewer:"user"`, `sandbox:{type:"workspaceWrite", networkAccess:false, …}`, `instructionSources:[]` and `permissionProfile:{id:"mc"}`. The hub can verify all of these before the seat runs. |
| Command text | `params.command` is `/bin/zsh -lc <one shell word>`. The word is bare (`ls`), single-quoted (`'cat a.txt'`), or a mixed run of quoted segments (`"echo 'it'\"'\"'s' …"`). `params.proposedExecpolicyAmendment` carries the parsed argv: `["cat","a.txt"]` for simple commands, and `["/bin/zsh","-lc","<the exact inner script>"]` for anything with quoting, a heredoc or `&`. |
| Approval fields | `kind:"command"`, `cwd` (the workspace), `environmentId:"local"`, `networkApprovalContext` absent, `reason` absent. |
| Network | `curl http://127.0.0.1:7420/` (the hub) and `curl https://1.1.1.1` both fail with `Couldn't connect` (exit 7). |
| Token in command env | `env \| grep -c MC_SEAT_TOKEN` prints `0` with the exclude set. |
| Background | `sleep 20 &` was approved and ran. The guard must refuse `&` (see the plan). |
| Denied read | Unchanged from the first run: denied. |

The run folder, including the copied `auth.json`, was deleted after the turn.
