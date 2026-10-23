import { expect, it } from "vitest";
import { foldTranscript } from "../src/streamjson.ts";

const frame = (type: string, seconds: number, content: unknown[], extra = {}) =>
  JSON.stringify({
    type,
    timestamp: new Date(seconds * 1000).toISOString(),
    message: { id: "reply", content, ...extra },
  });

it("measures first content separately and replays timestamped usage once", () => {
  const lines = [
    frame("user", 1, []),
    frame("assistant", 2, [{ type: "text", text: "Working" }], {
      usage: { input_tokens: 0, output_tokens: 0 },
    }),
    frame("assistant", 5, [{ type: "text", text: "Finished" }], {
      usage: { input_tokens: 0, output_tokens: 20 },
    }),
  ];
  const whole = foldTranscript(null, lines, 0);
  expect(whole.digest.speed).toMatchObject({ firstTokenMs: 1000, turnMs: 4000 });
  expect(whole.digest.attemptUsage).toEqual([{ id: "reply", at: 2000, tokens: 20 }]);
  expect(foldTranscript(foldTranscript(null, lines.slice(0, 2), 0), lines.slice(2), 0)).toEqual(
    whole,
  );
});

it("replays only the agent's task tools with stable identities", () => {
  const create = frame("assistant", 1, [
    {
      type: "tool_use",
      id: "create",
      name: "TaskCreate",
      input: { subject: "Verify measurements" },
    },
  ]);
  const result = frame("user", 2, [
    {
      type: "tool_result",
      tool_use_id: "create",
      content: "Task #7 created successfully: Verify measurements",
    },
  ]);
  const update = frame("assistant", 3, [
    {
      type: "tool_use",
      id: "update",
      name: "TaskUpdate",
      input: { taskId: "7", status: "completed" },
    },
  ]);
  const lines = [
    create,
    result,
    update,
    frame("user", 4, [{ type: "tool_result", tool_use_id: "update", content: "Updated" }]),
  ];
  const whole = foldTranscript(null, lines, 0);
  expect(whole.digest.tasks).toEqual([{ id: "7", text: "Verify measurements", status: "done" }]);
  expect(foldTranscript(whole, lines, 0).digest.tasks).toEqual(whole.digest.tasks);
  expect(foldTranscript(foldTranscript(null, lines.slice(0, 1), 0), lines.slice(1), 0)).toEqual(
    whole,
  );
  expect(foldTranscript(null, [], 0).digest.tasks).toEqual([]);
});

it("times content without a usage frame and leaves missing timestamps unknown", () => {
  const lines = [
    frame("user", 1, []),
    frame("assistant", 2, [{ type: "text", text: "First" }]),
    frame("assistant", 5, [], { usage: { output_tokens: 20 } }),
  ];
  expect(foldTranscript(null, lines, 0).digest.speed?.firstTokenMs).toBe(1000);
  const missing = JSON.stringify({
    type: "assistant",
    message: {
      id: "reply",
      content: [{ type: "text", text: "No clock" }],
      usage: { output_tokens: 0 },
    },
  });
  expect(
    foldTranscript(null, [frame("user", 1, []), missing], 0).digest.speed?.firstTokenMs,
  ).toBeNull();
});

it("keeps an update arriving before the create result, ignores malformed replacements and deletes", () => {
  const create = frame("assistant", 1, [
    { type: "tool_use", id: "c", name: "TaskCreate", input: { subject: "Check boundaries" } },
  ]);
  const update = frame("assistant", 2, [
    {
      type: "tool_use",
      id: "u",
      name: "TaskUpdate",
      input: { taskId: "8", status: "in_progress" },
    },
  ]);
  const result = frame("user", 3, [
    { type: "tool_result", tool_use_id: "c", content: "Task #8 created successfully" },
  ]);
  const malformed = frame("assistant", 4, [
    {
      type: "tool_use",
      id: "bad",
      name: "TodoWrite",
      input: { todos: [{ content: 4, status: "pending" }] },
    },
  ]);
  const lines = [
    create,
    update,
    frame("user", 2, [{ type: "tool_result", tool_use_id: "u", content: "Updated" }]),
    result,
    malformed,
  ];
  const whole = foldTranscript(null, lines, 0);
  expect(whole.digest.tasks).toEqual([
    { id: "8", text: "Check boundaries", status: "in_progress" },
  ]);
  expect(foldTranscript(foldTranscript(null, lines.slice(0, 2), 0), lines.slice(2), 0)).toEqual(
    whole,
  );
  const remove = frame("assistant", 5, [
    { type: "tool_use", id: "d", name: "TaskUpdate", input: { taskId: "8", status: "deleted" } },
  ]);
  const removed = frame("user", 6, [{ type: "tool_result", tool_use_id: "d", content: "Deleted" }]);
  const deleted = foldTranscript(whole, [remove, removed], 0);
  expect(deleted.digest.tasks).toEqual([]);
  expect(foldTranscript(deleted, [...lines, remove, removed], 0).digest.tasks).toEqual([]);
});

it("replaces TodoWrite lists and never interprets Markdown or background notifications as a plan", () => {
  const todo = (id: string, todos: unknown[]) =>
    frame("assistant", 1, [{ type: "tool_use", id, name: "TodoWrite", input: { todos } }]);
  const first = todo("t1", [{ id: "a", content: "Check files", status: "pending" }]);
  const second = todo("t2", [
    { id: "a", content: "Check files", status: "completed" },
    { id: "b", content: "Check speed", status: "in_progress" },
  ]);
  const whole = foldTranscript(null, [first, second], 0);
  expect(whole.digest.tasks).toEqual([
    { id: "a", text: "Check files", status: "done" },
    { id: "b", text: "Check speed", status: "in_progress" },
  ]);
  expect(foldTranscript(whole, [todo("clear", [])], 0).digest.tasks).toEqual([]);
  expect(
    foldTranscript(
      null,
      [
        JSON.stringify({
          type: "system",
          subtype: "task_started",
          task_id: "sub",
          task_type: "local_agent",
        }),
        frame("assistant", 2, [{ type: "text", text: "- [ ] A ticket Markdown plan" }]),
      ],
      0,
    ).digest.tasks,
  ).toEqual([]);
  expect(
    foldTranscript(
      null,
      [
        JSON.stringify({
          type: "assistant",
          parent_tool_use_id: "sub",
          message: {
            content: [
              {
                type: "tool_use",
                id: "subtask",
                name: "TodoWrite",
                input: { todos: [{ content: "Not top level", status: "pending" }] },
              },
            ],
          },
        }),
      ],
      0,
    ).digest.tasks,
  ).toEqual([]);
});

it("does not invent measured zero from an empty usage object", () => {
  expect(
    foldTranscript(null, [frame("assistant", 1, [], { usage: {} })], 0).digest.attemptUsage,
  ).toEqual([]);
});

it("does not substitute a later timestamp for an untimed first content frame", () => {
  const untimed = JSON.stringify({
    type: "assistant",
    message: { id: "reply", content: [{ type: "text", text: "First" }] },
  });
  expect(
    foldTranscript(
      null,
      [
        frame("user", 1, []),
        untimed,
        frame("assistant", 5, [{ type: "text", text: "Last" }], { usage: { output_tokens: 20 } }),
      ],
      0,
    ).digest.speed?.firstTokenMs,
  ).toBeNull();
});

for (const status of ["completed", "deleted"]) {
  it(`keeps a task unchanged when its ${status} update fails`, () => {
    const initial = foldTranscript(
      null,
      [
        frame("assistant", 1, [
          { type: "tool_use", id: "c", name: "TaskCreate", input: { subject: "Keep task" } },
        ]),
        frame("user", 2, [
          { type: "tool_result", tool_use_id: "c", content: "Task #1 created successfully" },
        ]),
      ],
      0,
    );
    const update = frame("assistant", 3, [
      {
        type: "tool_use",
        id: "u",
        name: "TaskUpdate",
        input: { taskId: "1", status, subject: "Changed" },
      },
    ]);
    const failed = frame("user", 4, [
      { type: "tool_result", tool_use_id: "u", is_error: true, content: "Update failed" },
    ]);
    const pending = foldTranscript(initial, [update], 0);
    expect(foldTranscript(pending, [failed], 0).digest.tasks).toEqual(initial.digest.tasks);
    expect(pending.digest.tasks).toEqual(initial.digest.tasks);
    expect(
      foldTranscript(
        null,
        [
          update,
          failed,
          frame("assistant", 5, [
            { type: "tool_use", id: "c2", name: "TaskCreate", input: { subject: "Keep task" } },
          ]),
          frame("user", 6, [
            { type: "tool_result", tool_use_id: "c2", content: "Task #1 created successfully" },
          ]),
        ],
        0,
      ).digest.tasks,
    ).toEqual(initial.digest.tasks);
  });
}
