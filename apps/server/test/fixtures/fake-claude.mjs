// A stand-in for `claude -p --input-format stream-json --output-format stream-json`, copying the
// sequence the real CLI (2.1.302) printed in Plan 5 Task 2's check and the shapes in
// docs/spikes/2026-10-20-runtime-stream-json.md. Tests run it as
// `node fake-claude.mjs --session-id <id>` (or `--resume <id>`). With `--record <file>` it appends
// `{"argv", "cwd", "env"}` on start and then every stdin line, as received, to that file. With
// `--boot-delay <ms>` blocks startup that long before it reads stdin (a slow boot with no signal
// handler yet, so a SIGTERM during it ends the process by signal). With
// `--fail-resume` it exits 1 at once when started with `--resume` (an unknown session, say). With
// `--record-exit` it also records `{"exited":<pid>}` when it exits, and SIGTERM becomes exit 143.
//
// Nothing is printed until the first user line. Each user line starts a turn: `system/init`, a
// `rate_limit_event` (allowed), an assistant reply `echo: <text>` and a `result`. A user line that
// arrives while a SLOW turn waits folds into that turn, as in the real CLI. Words in the text:
//   SLOW       a Bash tool_use first, then a 2 s wait (an `interrupt` cuts it short)
//   PROGRESS   a heartbeat `tool_progress`, then 50 ms later a plain one, before the reply
//   TOOLGAP    a Bash tool_use `toolu_g`; the next user line is a cue for its tool_result, and the
//              one after that a cue for the reply and the result (so a test decides when the call
//              ends and when the turn does, with no timing window)
//   DIE        exit 3 mid-turn, after a line with no newline (valid JSON, so a test can show the
//              driver does not parse it)
//   REFUSEINT  refuse later interrupts with an error
//   NOCONTROL  ignore every later control request
//   RATELIMIT  a rate_limit_event with status "rejected"
//   TURNERROR  the turn's result is an error that no interrupt caused (`error_max_turns`)
//   STDERR     a long stderr line with a terminal escape
//   NONJSON    a stdout line that is not JSON
//   HANG       keep running after stdin closes (until a signal)
//   IGNORETERM as HANG, and ignore SIGTERM too (only SIGKILL ends it)
//   QUIET      print nothing until `<--record file>.go` exists, then run the turn (its reply
//              says QUIETED)
//   ORPHAN     exit 0 at once, leaving a child that holds stdout and stderr open for 3 s
import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const sessionId =
  flag("--session-id") ?? flag("--resume") ?? "00000000-0000-4000-8000-000000000000";
const MODEL = "claude-haiku-5-5";
const recordTo = flag("--record");
const record = (line) => {
  if (recordTo) appendFileSync(recordTo, `${line}\n`);
};
const bootDelay = Number(flag("--boot-delay") ?? 0);
if (bootDelay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, bootDelay);
// `--record-exit`: a SIGTERM ends it with exit 143 (not by the signal), and every exit leaves
// `{"exited":<pid>}` in the record, so a test can order it against the starts around it.
if (argv.includes("--record-exit")) {
  process.on("SIGTERM", () => process.exit(143));
  process.on("exit", () => record(JSON.stringify({ exited: process.pid })));
}
record(JSON.stringify({ argv, cwd: process.cwd(), env: process.env }));
if (argv.includes("--fail-resume") && argv.includes("--resume")) {
  process.stderr.write("No conversation found with session ID\n");
  process.exit(1);
}

let ignoreControl = false;
let refuseInterrupt = false;
let batchInterrupt = false;
let hang = false;
/** The SLOW turn while it waits: its timer and the texts folded into it. */
let slow = null;
/** A TOOLGAP turn's remaining steps, each run by the next user line. */
const cues = [];
let msg = 0;

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const assistant = (content, stopReason) =>
  out({
    type: "assistant",
    message: {
      model: MODEL,
      id: `msg_${++msg}`,
      type: "message",
      role: "assistant",
      content,
      stop_reason: stopReason,
      usage: { input_tokens: 5, output_tokens: 7 },
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  });
/**
 * A `result` with the fields the fold reads, as the real CLI writes them: in its key order, which
 * does not put `type` first (#798).
 */
const result = (text, stopReason, interrupted = false, failed = false) =>
  out({
    duration_api_ms: 800,
    stop_reason: stopReason,
    session_id: sessionId,
    total_cost_usd: 0.0013,
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 5741,
      cache_read_input_tokens: 5652,
      output_tokens: 4,
    },
    modelUsage: {
      [MODEL]: {
        inputTokens: 1178,
        outputTokens: 16,
        cacheReadInputTokens: 5652,
        cacheCreationInputTokens: 5741,
        costUSD: 0.0013,
        contextWindow: 1000000,
        maxOutputTokens: 128000,
      },
    },
    permission_denials: [],
    terminal_reason: interrupted ? "aborted_tools" : "completed",
    is_error: interrupted || failed,
    num_turns: 1,
    subtype: interrupted ? "error_during_execution" : failed ? "error_max_turns" : "success",
    result: interrupted ? null : text,
    type: "result",
    duration_ms: 900,
  });
const user = (content) =>
  out({
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: sessionId,
  });

function userTurn(text) {
  if (text.includes("QUIET") && !text.includes("QUIETED")) {
    // prints nothing until `<record file>.go` exists, as a CLI that has the line but has not
    // started its turn (a file, not a timer: the test says when)
    const gate = `${recordTo}.go`;
    const wait = setInterval(() => {
      if (!existsSync(gate)) return;
      clearInterval(wait);
      userTurn(text.replace("QUIET", "QUIETED"));
    }, 20);
    return;
  }
  const cue = cues.shift();
  if (cue) {
    cue();
    return;
  }
  if (slow) {
    slow.texts.push(text);
    return;
  }
  out({
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    session_id: sessionId,
    tools: ["Bash", "Read"],
    mcp_servers: [],
    model: MODEL,
    permissionMode: "default",
    apiKeySource: "none",
  });
  out({
    type: "rate_limit_event",
    rate_limit_info: {
      status: text.includes("RATELIMIT") ? "rejected" : "allowed",
      resetsAt: 1792310400,
      rateLimitType: "five_hour",
      unifiedWindows: { five_hour: { utilization: 0.13, resetsAt: 1792310400 } },
    },
    session_id: sessionId,
  });
  if (text.includes("BATCHINT")) batchInterrupt = true;
  if (text.includes("REFUSEINT")) refuseInterrupt = true;
  if (text.includes("NOCONTROL")) ignoreControl = true;
  if (text.includes("HANG")) hang = true;
  if (text.includes("IGNORETERM")) {
    hang = true;
    process.on("SIGTERM", () => {});
  }
  if (text.includes("STDERR")) process.stderr.write(`\x1b[31mfake stderr ${"x".repeat(3000)}\n`);
  if (text.includes("NONJSON")) process.stdout.write("this line is not json\n");
  if (text.includes("ORPHAN")) {
    spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], {
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
    }).unref();
    process.exit(0);
  }
  if (text.includes("DIE")) {
    process.stdout.write('{"type":"result","is_error":true,"stop_reason":"half"}', () =>
      process.exit(3),
    );
    return;
  }
  if (text.includes("SLOW")) {
    assistant(
      [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "sleep 2" } }],
      "tool_use",
    );
    const timer = setTimeout(() => {
      const reply = `echo: ${slow.texts.join(" + ")}`;
      slow = null;
      user([{ tool_use_id: "toolu_1", type: "tool_result", content: "", is_error: false }]);
      assistant([{ type: "text", text: reply }], "end_turn");
      result(reply, "end_turn");
    }, 2000);
    slow = { timer, texts: [text] };
    return;
  }
  if (text.includes("TOOLGAP")) {
    assistant(
      [{ type: "tool_use", id: "toolu_g", name: "Bash", input: { command: "pnpm -s test" } }],
      "tool_use",
    );
    cues.push(
      () => user([{ tool_use_id: "toolu_g", type: "tool_result", content: "ok", is_error: false }]),
      () => {
        assistant([{ type: "text", text: `echo: ${text}` }], "end_turn");
        result(`echo: ${text}`, "end_turn", false, text.includes("TURNERROR"));
      },
    );
    return;
  }
  if (text.includes("PROGRESS")) {
    const progress = (heartbeat) =>
      out({
        type: "tool_progress",
        tool_use_id: "toolu_p",
        tool_name: "Bash",
        parent_tool_use_id: null,
        elapsed_time_seconds: 30,
        ...(heartbeat ? { heartbeat: true } : {}),
        session_id: sessionId,
      });
    progress(true);
    setTimeout(() => {
      progress(false);
      assistant([{ type: "text", text: `echo: ${text}` }], "end_turn");
      result(`echo: ${text}`, "end_turn");
    }, 50);
    return;
  }
  assistant([{ type: "text", text: `echo: ${text}` }], "end_turn");
  result(`echo: ${text}`, "end_turn", false, text.includes("TURNERROR"));
}

function control(requestId, subtype) {
  if (ignoreControl) return;
  const ok = (response) =>
    out({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    });
  if (subtype === "interrupt" && refuseInterrupt) {
    out({
      type: "control_response",
      response: { subtype: "error", request_id: requestId, error: "\x1b[31mnot now\x1b[0m" },
    });
    return;
  }
  if (subtype === "interrupt" && batchInterrupt) {
    if (slow) clearTimeout(slow.timer);
    slow = null;
    process.stdout.write(
      `${[
        JSON.stringify({
          type: "control_response",
          response: { subtype: "success", request_id: requestId, response: {} },
        }),
        JSON.stringify({ type: "result", is_error: true, stop_reason: "tool_use" }),
      ].join("\n")}\n`,
    );
    return;
  }
  if (subtype === "interrupt") {
    ok({ still_queued: [] });
    if (slow) {
      clearTimeout(slow.timer);
      slow = null;
      // As the real CLI (2.1.302) ends an interrupted tool call.
      user([
        {
          type: "tool_result",
          content:
            "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
          is_error: true,
          tool_use_id: "toolu_1",
        },
      ]);
      user([{ type: "text", text: "[Request interrupted by user for tool use]" }]);
      result(null, "tool_use", true);
    }
  } else if (subtype === "get_context_usage") {
    ok({
      categories: [
        { name: "System prompt", tokens: 3100, color: "promptBorder", kind: "used" },
        { name: "Messages", tokens: 240, color: "purple", kind: "used" },
      ],
      totalTokens: 3340,
      maxTokens: 200000,
      memoryFiles: [],
    });
  } else if (subtype === "get_usage") {
    ok({
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 0.1, resets_at: 1792310400 } },
    });
  } else {
    out({
      type: "control_response",
      response: { subtype: "error", request_id: requestId, error: `unknown subtype ${subtype}` },
    });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  record(line);
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }
  if (ev.type === "user") userTurn(String(ev.message?.content ?? ""));
  else if (ev.type === "control_request") control(ev.request_id, ev.request?.subtype);
});
rl.on("close", () => {
  if (hang) setInterval(() => {}, 1000);
  else if (!slow) process.exit(0);
  // A SLOW turn finishes, then the process exits on its own once nothing is pending.
});
