import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local stand-in for the Anthropic Messages API, so a real `claude` process can run a seat's
 * Bash call with no network and no login. It answers the first model turn with one Bash call
 * (`command`) and every turn after a tool result with a plain "done", keeping the text of each
 * tool result it is sent.
 */
export interface FakeAnthropic {
  url: string;
  /** How many Bash calls the CLI was asked to make (0: the CLI never reached the model). */
  bashCalls: () => number;
  /** The text of every tool result the CLI sent back, in order: what the Bash command printed. */
  toolResults: () => string[];
  close: () => Promise<void>;
}

export async function startFakeAnthropic(command: string): Promise<FakeAnthropic> {
  let bashCalls = 0;
  const toolResults: string[] = [];
  const message = (content: unknown[], stop: string | null) => ({
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "claude-fake",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!req.url?.startsWith("/v1/messages")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      let body: { stream?: boolean; messages?: unknown; tools?: { name: string }[] } = {};
      try {
        body = JSON.parse(raw);
      } catch {
        // an unreadable body gets the plain answer
      }
      const hasResult = JSON.stringify(body.messages ?? []).includes('"tool_result"');
      // the newest turn's results only: every later request repeats the earlier ones
      if (hasResult) toolResults.push(...resultTexts(body.messages));
      const canBash = (body.tools ?? []).some((t) => t.name === "Bash");
      const call = canBash && !hasResult;
      if (call) bashCalls++;
      const block = call
        ? { type: "tool_use", id: "toolu_fake", name: "Bash", input: { command } }
        : { type: "text", text: "done" };
      const stop = call ? "tool_use" : "end_turn";
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(message([block], stop)));
        return;
      }
      const events: [string, Record<string, unknown>][] = [
        ["message_start", { message: message([], null) }],
        [
          "content_block_start",
          { index: 0, content_block: call ? { ...block, input: {} } : { type: "text", text: "" } },
        ],
        [
          "content_block_delta",
          {
            index: 0,
            delta: call
              ? { type: "input_json_delta", partial_json: JSON.stringify({ command }) }
              : { type: "text_delta", text: "done" },
          },
        ],
        ["content_block_stop", { index: 0 }],
        [
          "message_delta",
          { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } },
        ],
        ["message_stop", {}],
      ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const [type, data] of events)
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    bashCalls: () => bashCalls,
    toolResults: () => [...toolResults],
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The text of the tool results in the last message of a request (a string, or text blocks). */
function resultTexts(messages: unknown): string[] {
  const last = Array.isArray(messages) ? messages.at(-1) : undefined;
  const content = (last as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b): b is { type: string; content?: unknown } => b?.type === "tool_result")
    .map((b) =>
      typeof b.content === "string"
        ? b.content
        : Array.isArray(b.content)
          ? b.content
              .map((c: { text?: unknown }) => (typeof c.text === "string" ? c.text : ""))
              .join("")
          : "",
    );
}
