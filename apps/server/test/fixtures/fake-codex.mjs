// Codex 0.154 app-server JSON-RPC shapes from the confinement spike and generated schema.
import { appendFileSync } from "node:fs";
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
    const bad = configured.bad;
    if (bad === "approvalPolicy") result.approvalPolicy = "never";
    if (bad === "approvalsReviewer") result.approvalsReviewer = "guardian_subagent";
    if (bad === "activePermissionProfile") result.activePermissionProfile.id = "other";
    if (bad === "networkAccess") result.sandbox.networkAccess = true;
    if (bad === "instructionSources") result.instructionSources = ["AGENTS.md"];
    if (configured.badField) {
      const parts = configured.badField.split(".");
      const key = parts.pop();
      const parent = parts.reduce((value, part) => value[part], result);
      if (configured.badShape === "absent") delete parent[key];
      else parent[key] = configured.badShape === "null" ? null : 42;
    }
    notify("thread/started", { thread: result.thread });
    say({ id, result });
  } else if (method === "turn/start") {
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
    const turnId = `turn-${++turn}`;
    active = { turnId, scenario };
    const acknowledge = () => say({ id, result: { turn: { id: turnId, status: "inProgress" } } });
    active.acknowledge = acknowledge;
    if (scenario.ackDelayMs) later(acknowledge, scenario.ackDelayMs);
    else if (!scenario.noAck) acknowledge();
    notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
    if (scenario.stderr) process.stderr.write(`${scenario.stderr}\n`);
    if (scenario.usage)
      notify("thread/tokenUsage/updated", { threadId, tokenUsage: scenario.usage });
    // RateLimits.primary/secondary are RateLimitWindow: usedPercent, windowDurationMins, resetsAt.
    if (scenario.rateLimits)
      notify("account/rateLimits/updated", { rateLimits: scenario.rateLimits });
    if (scenario.command || scenario.changes || scenario.method) {
      const itemId = `item-${turn}`;
      const type = scenario.changes ? "fileChange" : "commandExecution";
      const item = { id: itemId, type, ...(scenario.changes ? { changes: scenario.changes } : {}) };
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
    say({ id, result: {} });
    endTurn("interrupted");
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
