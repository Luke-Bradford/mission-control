import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const m of query({
  prompt: "Reply with the word ok.",
  options: { maxTurns: 1 },
})) {
  if ((m.type === "system" && m.subtype === "init") || m.type === "result") {
    console.log(JSON.stringify(m));
  }
}
