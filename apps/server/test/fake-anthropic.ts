import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local stand-in for the Anthropic Messages API, so a real `claude` process can run a seat's
 * Bash call with no network and no login. It answers the first model turn with one Bash call
 * (`command`) and every turn after a tool result with a plain "done".
 */
export interface FakeAnthropic {
  url: string;
  /** How many Bash calls the CLI was asked to make (0: the CLI never reached the model). */
  bashCalls: () => number;
  close: () => Promise<void>;
}

export async function startFakeAnthropic(command: string): Promise<FakeAnthropic> {
  let bashCalls = 0;
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
