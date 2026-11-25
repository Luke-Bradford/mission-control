import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const runbook = readFileSync(
  resolve(import.meta.dirname, "../../../docs/runbooks/work-mac.md"),
  "utf8",
);

describe("work-Mac runbook", () => {
  it("covers a local sessions-only launch", () => {
    expect(runbook).toContain("socketControlMode");
    expect(runbook).toContain("accounts, repositories, loops or crew");
    expect(runbook).toContain("operator-token");
    expect(runbook).toContain("launchctl");
    expect(runbook).toContain("MC_PORT");
    expect(runbook).toContain("127.0.0.1");
  });
});
