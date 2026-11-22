import { describe, expect, it, vi } from "vitest";
import { installHubErrorHandlers } from "../src/runtime/process-errors.ts";

describe("hub process error handlers", () => {
  it("logs unhandled rejections and uncaught exceptions without throwing", () => {
    const log = vi.fn();
    const remove = installHubErrorHandlers(log);
    try {
      expect(() => process.emit("unhandledRejection", new Error("rejection"), Promise.resolve())).not.toThrow();
      expect(() => process.emit("uncaughtException", new Error("exception"), "uncaughtException")).not.toThrow();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("hub unhandled rejection: Error: rejection"));
      expect(log).toHaveBeenCalledWith(expect.stringContaining("hub uncaught exception: Error: exception"));
    } finally {
      remove();
    }
  });
});
