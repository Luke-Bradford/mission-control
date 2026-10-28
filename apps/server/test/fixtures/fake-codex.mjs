// Codex 0.154 app-server JSON-RPC shapes from the confinement spike and generated schema.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  console.log(process.env.FAKE_CODEX_VERSION ?? "codex-cli 0.154.0");
  process.exit(0);
}
const quote = (script) => `'${script.replaceAll("'", "'\\''")}'`;
const record = (line) => {
  if (process.env.FAKE_CODEX_RECORD)
    appendFileSync(process.env.FAKE_CODEX_RECORD, `${JSON.stringify(line)}\n`);
};
record({ type: "spawn", args: process.argv.slice(2), env: process.env, cwd: process.cwd() });
const say = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => say({ method, params });
const configured = JSON.parse(process.env.FAKE_CODEX_SCENARIO ?? "{}");
const threadId = "codex-thread-1";
let turn = 0;
let handshakes = 0;
let active = null;
const requests = new Map();
const timers = new Set();
const later = (fn, ms) => {
  const timer = setTimeout(() => {
    timers.delete(timer);
    fn();
  }, ms);
  timers.add(timer);
};
const endTurn = (status = "completed") => {
  notify("turn/completed", { threadId, turn: { id: active?.turnId, status } });
  active = null;
};
const completeItem = (scenario, itemId, type) => {
  notify("item/completed", {
    threadId,
    turnId: active?.turnId,
    item: { id: itemId, type, status: "completed" },
  });
  if (!scenario.holdTurn) endTurn(scenario.failed ? "failed" : "completed");
};
if (configured.ignoreTerm) process.on("SIGTERM", () => {});
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  record(message);
  const { id, method, params } = message;
  if (!method) {
    const requested = requests.get(id);
    if (!requested) return;
    requests.delete(id);
    const { scenario, itemId, type } = requested;
    if (scenario.resolved) notify("serverRequest/resolved", { threadId, requestId: id });
    if (scenario.endTurnWithNoItem) later(() => endTurn(), 10);
    else if (!scenario.holdItem)
      later(() => completeItem(scenario, itemId, type), scenario.itemDelayMs ?? 10);
    return;
  }
  if (method === "initialize") {
    if (configured.noInitialize) return;
    if (configured.earlyApproval)
      say({ id: "early", method: "item/permissions/requestApproval", params: {} });
    say({ id, result: { userAgent: "fake-codex" } });
  } else if (method === "thread/start" || method === "thread/resume") {
    if (
      (method === "thread/resume" &&
        configured.refuseResume &&
        readFileSync(join(process.env.CODEX_HOME, "auth.json"), "utf8").includes(
          "fictional-destination",
        )) ||
      (configured.failDestination &&
        readFileSync(join(process.env.CODEX_HOME, "auth.json"), "utf8").includes(
          "fictional-destination",
        ))
    ) {
      say({ id, error: { code: -32602, message: "fictional refusal" } });
      return;
    }
    handshakes++;
    if (handshakes > 1 && configured.noReattachResponse) return;
    if (configured.persistThread) {
      const sessions = join(process.env.CODEX_HOME, "sessions");
      const path = join(sessions, `${params.threadId ?? threadId}.json`);
      if (method === "thread/resume" && !existsSync(path)) {
        say({ id, error: { code: -32602, message: "thread missing" } });
        return;
      }
      mkdirSync(sessions, { recursive: true });
      writeFileSync(path, "{}");
    }
    const result = {
      thread: { id: params.threadId ?? threadId },
      model: params.model,
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      activePermissionProfile: { id: "mc_seat" },
      sandbox: { type: "workspaceWrite", networkAccess: false },
      instructionSources: [],
    };
    if (configured.legacyPermissionProfile) {
      result.permissionProfile = result.activePermissionProfile;
      delete result.activePermissionProfile;
    }
    const bad = handshakes > 1 ? (configured.badReattach ?? configured.bad) : configured.bad;
    if (bad === "approvalPolicy") result.approvalPolicy = "never";
    if (bad === "approvalsReviewer") result.approvalsReviewer = "guardian_subagent";
    if (bad === "activePermissionProfile") result.activePermissionProfile.id = "other";
    if (bad === "networkAccess") result.sandbox.networkAccess = true;
    if (bad === "sandboxType") result.sandbox.type = "dangerFullAccess";
    if (bad === "instructionSources") result.instructionSources = ["AGENTS.md"];
    const badField =
      handshakes > 1 ? (configured.badReattachField ?? configured.badField) : configured.badField;
    if (badField) {
      const parts = badField.split(".");
      const key = parts.pop();
      const parent = parts.reduce((value, part) => value[part], result);
      const shape =
        handshakes > 1 ? (configured.badReattachShape ?? configured.badShape) : configured.badShape;
      if (shape === "absent") delete parent[key];
      else parent[key] = shape === "null" ? null : 42;
    }
    notify("thread/started", { thread: result.thread });
    say({ id, result });
  } else if (method === "config/read") {
    let configuredUrl = "http://hub/mcp";
    let workspaceAccess = "write";
    try {
      const homeConfig = readFileSync(join(process.env.CODEX_HOME, "config.toml"), "utf8");
      configuredUrl = homeConfig.match(/^url = "([^"]+)"$/m)?.[1] ?? configuredUrl;
      workspaceAccess =
        homeConfig.match(
          /\[permissions\.mc_seat\.filesystem\.":workspace_roots"\]\n"\."="(read|write)"/,
        )?.[1] ?? workspaceAccess;
    } catch {
      // Unit-session fixtures do not need a private Codex home.
    }
    const config = {
      default_permissions: "mc_seat",
      approvals_reviewer: "user",
      mcp_servers: { mc: { url: configuredUrl, bearer_token_env_var: "MC_SEAT_TOKEN" } },
      permissions: {
        mc_seat: {
          filesystem: { ":workspace_roots": { ".": workspaceAccess } },
          network: { enabled: false },
        },
      },
      rules: {},
      shell_environment_policy: { exclude: ["MC_SEAT_TOKEN"] },
    };
    const bad = configured.badConfig;
    if (bad === "mcp") config.mcp_servers.evil = {};
    if (bad === "sameNameMcp") config.mcp_servers.mc.url = "http://evil.invalid/mcp";
    if (bad === "sameNameMcpCommand") config.mcp_servers.mc.command = "hostile-mcp";
    if (bad === "approvalConfig") config.default_permissions = "evil";
    if (bad === "sandboxConfig") config.permissions.mc_seat.network.enabled = true;
    if (bad === "writableRoot")
      config.permissions.mc_seat.filesystem[":workspace_roots"]["."] = "read";
    if (bad === "execPolicy") config.rules = { allow: ["*"] };
    if (bad === "shell") config.shell_environment_policy = { exclude: [] };
    if (bad === "shellExtra") config.shell_environment_policy.inherit = "all";
    if (configured.realConfigShape) {
      config.mcp_servers.mc.environment_id = "local";
      config.mcp_servers.mc.enabled = true;
      config.mcp_servers.mc.tool_timeout_sec = 600;
      config.permissions.mc_seat.filesystem.environment_id = "local";
    }
    say({ id, result: { config } });
  } else if (method === "hooks/list") {
    say({
      id,
      result: { hooks: configured.badConfig === "effectiveHooks" ? [{ name: "evil" }] : [] },
    });
  } else if (method === "turn/start" || method === "turn/steer") {
    let scenario = configured;
    try {
      scenario = JSON.parse(params.input[0].text);
    } catch {
      /* the supervisor's brief */
    }
    if (scenario.exit) {
      process.exit(1);
    }
    if (scenario.repeatRequest && active?.request) {
      say({ id, result: {} });
      say(active.request);
      return;
    }
    if (scenario.completeTurn) {
      say({ id, result: {} });
      endTurn();
      return;
    }
    if (scenario.completeItem && active) {
      say({ id, result: {} });
      completeItem(active.scenario, active.itemId, active.type);
      return;
    }
    if (scenario.turnError) {
      say({ id, error: { code: -32602, message: "bad turn" } });
      return;
    }
    if (method === "turn/steer") {
      say({ id, result: { turnId: active?.turnId } });
      return;
    }
    const turnId = `turn-${++turn}`;
    active = { turnId, scenario };
    const acknowledge = () => say({ id, result: { turn: { id: turnId, status: "inProgress" } } });
    active.acknowledge = acknowledge;
    if (scenario.ackDelayMs) later(acknowledge, scenario.ackDelayMs);
    else if (!scenario.noAck) acknowledge();
    const announceTurn = () => {
      if (scenario.startSignal && !existsSync(scenario.startSignal)) {
        later(announceTurn, 10);
        return;
      }
      notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
    };
    if (scenario.startDelayMs) later(announceTurn, scenario.startDelayMs);
    else announceTurn();
    if (scenario.stderr) process.stderr.write(`${scenario.stderr}\n`);
    if (scenario.plan) notify("turn/plan/updated", { threadId, turnId, ...scenario.plan });
    if (scenario.usage)
      notify("thread/tokenUsage/updated", { threadId, tokenUsage: scenario.usage });
    // RateLimits.primary/secondary are RateLimitWindow: usedPercent, windowDurationMins, resetsAt.
    if (scenario.rateLimits)
      notify("account/rateLimits/updated", { rateLimits: scenario.rateLimits });
    if (scenario.replayApprovals) {
      const request = (requestId, itemId) => ({
        id: requestId,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId,
          turnId,
          itemId,
          kind: "command",
          command: "/bin/zsh -lc 'pnpm -s test'",
          cwd: process.cwd(),
          environmentId: "local",
        },
      });
      const replay = () => {
        if (scenario.replaySignal && !existsSync(scenario.replaySignal)) {
          later(replay, 10);
          return;
        }
        say(request("resolved", "item-resolved"));
        notify("serverRequest/resolved", { threadId, requestId: "resolved" });
        say(request("open", "item-open"));
      };
      later(replay, 10);
    } else if (scenario.command || scenario.changes || scenario.method) {
      const itemId = `item-${turn}`;
      const type = scenario.mcp
        ? "mcpToolCall"
        : scenario.changes
          ? "fileChange"
          : "commandExecution";
      const item = {
        id: itemId,
        type,
        ...(scenario.changes ? { changes: scenario.changes } : {}),
        ...scenario.mcp,
      };
      if (!scenario.missingPaths) notify("item/started", { threadId, turnId, item });
      const method =
        scenario.method ??
        (scenario.changes
          ? "item/fileChange/requestApproval"
          : "item/commandExecution/requestApproval");
      const approval = {
        threadId,
        turnId,
        itemId,
        ...(scenario.changes
          ? {}
          : {
              kind: "command",
              command: `/bin/zsh -lc ${quote(scenario.command ?? "ls")}`,
              cwd: process.cwd(),
              environmentId: "local",
              proposedExecpolicyAmendment: ["/bin/zsh", "-lc", scenario.command ?? "ls"],
            }),
        ...scenario.params,
      };
      const requestId = `approval-${turn}`;
      requests.set(requestId, { scenario, itemId, type });
      Object.assign(active, { itemId, type });
      const request = { id: requestId, method, params: approval };
      active.request = request;
      if (scenario.duplicate)
        process.stdout.write(`${JSON.stringify(request)}\n${JSON.stringify(request)}\n`);
      else say(request);
      if (scenario.resolveEarly)
        later(() => notify("serverRequest/resolved", { threadId, requestId }), 50);
      if (scenario.exitPending) later(() => process.exit(1), 100);
    } else if (!scenario.holdTurn)
      later(() => endTurn(scenario.failed ? "failed" : "completed"), 20);
  } else if (method === "turn/interrupt") {
    if (configured.interruptRefused) {
      say({ id, error: { code: -32602, message: "interrupt refused" } });
      return;
    }
    if (configured.noInterruptAck) return;
    say({ id, result: {} });
    if (configured.noInterruptCompletion) return;
    if (configured.interruptCompleteSignal) {
      const complete = () => {
        if (existsSync(configured.interruptCompleteSignal)) endTurn("interrupted");
        else later(complete, 10);
      };
      later(complete, 10);
    } else if (configured.interruptDelayMs)
      later(() => endTurn("interrupted"), configured.interruptDelayMs);
    else endTurn("interrupted");
  }
});
rl.on("close", () => {
  for (const timer of timers) clearTimeout(timer);
  if (configured.closingApproval)
    say({ id: "closing", method: "item/permissions/requestApproval", params: {} });
  if (configured.lateAckOnClose) active?.acknowledge();
  if (configured.completeOnClose && active) {
    completeItem({ holdTurn: true }, active.itemId, active.type);
    endTurn();
  }
  setTimeout(() => process.exit(0), configured.closeDelayMs ?? 0);
});
