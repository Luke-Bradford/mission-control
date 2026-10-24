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
