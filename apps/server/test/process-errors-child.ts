/**
 * Runs in its own process for process-errors.test.ts: installs the real hub handlers, starts an
 * app, and on each message causes a real unhandled failure, then proves the app still answers.
 */
import Fastify from "fastify";
import { installHubErrorHandlers } from "../src/runtime/process-errors.ts";

const lines: string[] = [];
installHubErrorHandlers((line) => lines.push(line));
const app = Fastify();
app.get("/ping", async () => ({ ok: true }));
await app.ready();

const answer = async (kind: string) => {
  const res = await app.inject({ method: "GET", url: "/ping" });
  process.send?.({ kind, status: res.statusCode, lines: [...lines] });
};

process.on("message", (message: string) => {
  if (message === "reject") {
    // a promise rejected with nothing attached to it
    void Promise.reject(new Error("real rejection"));
    setTimeout(() => void answer("reject"), 50);
  } else if (message === "throw") {
    // an exception that escapes an asynchronous callback
    setTimeout(() => {
      throw new Error("real exception");
    }, 0);
    setTimeout(() => void answer("throw"), 50);
  }
});
process.send?.({ kind: "ready" });
