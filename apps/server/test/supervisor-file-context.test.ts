import "./supervisor-harness.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { dir, make, TICKET, until, userLines } from "./supervisor-harness.ts";

describe("planner file context wiring", () => {
  it.each([
    { seat: "fao-1", truncated: false, expected: true },
    { seat: "fao-1", truncated: true, expected: false },
    { seat: "guido-1", truncated: false, expected: false },
  ])(
    "limits generated context to a complete scoped FAO ticket: $seat/$truncated",
    async ({ seat, truncated, expected }) => {
      const rolesDir = join(dir, "roles");
      mkdirSync(rolesDir);
      writeFileSync(join(rolesDir, "FAO.md"), "# FAO: planner\n");
      const body = TICKET.body + "\n\n## Files\n- `src/example.ts`",
        fileContext = vi.fn(async () => '[{"file":"src/example.ts","recommendation":"fixture"}]');
      const { sup } = make({
        rolesDir,
        fileContext,
        fetchTicket: async () => ({
          ...TICKET,
          body,
          bodyLength: body.length,
          bodyTruncated: truncated,
        }),
      });
      sup.start();
      await sup.startRun(seat, 42);
      await until(() => expect(userLines()).toHaveLength(1));
      expect(fileContext).toHaveBeenCalledTimes(expected ? 1 : 0);
      expect(userLines()[0].includes("## Relevant file evidence")).toBe(expected);
      if (expected) expect(fileContext).toHaveBeenCalledWith("mc", body);
    },
  );
});
