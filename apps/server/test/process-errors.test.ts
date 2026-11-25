import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { installHubErrorHandlers } from "../src/runtime/process-errors.ts";

type Report = { kind: string; status?: number; lines?: string[] };

const CHILD = fileURLToPath(new URL("./process-errors-child.ts", import.meta.url));

/** How long one report may take: under the server project's 15 s test timeout, so a stall names its report. */
const REPORT_WAIT_MS = 10_000;

/** The next message of `kind` the child sends, or a failure if it exits or stalls first. */
const next = (child: ChildProcess, kind: string): Promise<Report> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no "${kind}" report from the child`)),
      REPORT_WAIT_MS,
    );
    const onMessage = (m: Report) => {
      if (m.kind !== kind) return;
      clearTimeout(timer);
      child.off("message", onMessage);
      resolve(m);
    };
    child.on("message", onMessage);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the child exited (${String(code)}) before reporting "${kind}"`));
    });
  });

describe("hub process error handlers", () => {
  it("keeps serving after a real unhandled rejection and a real uncaught exception", async () => {
    const child = fork(CHILD, [], { execArgv: ["--experimental-strip-types"], silent: true });
    try {
      await next(child, "ready");
      child.send("reject");
      const afterRejection = await next(child, "reject");
      expect(afterRejection.status).toBe(200);
      expect(afterRejection.lines?.join("\n")).toContain("hub unhandled rejection");
      expect(afterRejection.lines?.join("\n")).toContain("real rejection");

      child.send("throw");
      const afterException = await next(child, "throw");
      expect(afterException.status).toBe(200);
      expect(afterException.lines?.join("\n")).toContain("hub uncaught exception");
      expect(afterException.lines?.join("\n")).toContain("real exception");
    } finally {
      child.kill();
    }
  });

  it("removes its listeners when asked, and a failing logger does not throw", () => {
    const before = process.listenerCount("unhandledRejection");
    const remove = installHubErrorHandlers(() => {
      throw new Error("logger down");
    });
    expect(process.listenerCount("unhandledRejection")).toBe(before + 1);
    expect(() =>
      process.emit("unhandledRejection", new Error("x"), Promise.resolve()),
    ).not.toThrow();
    remove();
    expect(process.listenerCount("unhandledRejection")).toBe(before);
  });
});
