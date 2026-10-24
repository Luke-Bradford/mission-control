import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CrewMode, GUARD_RULES, MC_MCP_SERVER, MC_TOOL_NAMES } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { TestLock } from "../src/guard/lock.ts";
import { createCodexApprover } from "../src/runtime/codex-approval.ts";
import { CODEX_MCP_ELICITATION } from "../src/runtime/codex-session.ts";

let cwd: string;
beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "mc-codex-approval-")));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function approver(mode: CrewMode = "writer", grants: string[] = []) {
  const config: CcConfig = {
    operator: { id: "op", timezone: "UTC" },
    accounts: [],
    repos: [{ id: "repo", github: "o/r", project: 1, statusMap: {}, autonomy: "draft" }],
    loops: [],
    poll: { usageMinutes: 30, githubSeconds: 60 },
  };
  const record = vi.fn();
  const seatGrants = vi.fn(() => grants);
  const approve = createCodexApprover({
    config,
    repoId: "repo",
    seatId: "seat",
    runId: "run",
    mode,
    area: ["apps/**"],
    cwd,
    lock: new TestLock(),
    record,
    seatGrants,
  });
  return { approve, record, seatGrants, config };
}

const elicitation = (tool: string = MC_TOOL_NAMES.commit, server: string = MC_MCP_SERVER) => ({
  id: 1,
  method: CODEX_MCP_ELICITATION,
  params: {
    serverName: server,
    mode: "form",
    _meta: { codex_approval_kind: "mcp_tool_call" },
    requestedSchema: { type: "object", properties: {} },
  },
  mcpCall: { itemId: "item", server, tool },
});
const signal = () => new AbortController().signal;

describe("Codex MCP approvals", () => {
  it.each([
    ["writer", MC_TOOL_NAMES.commit, [], "accept"],
    ["writer", MC_TOOL_NAMES.reportEvidence, [], "accept"],
    ["writer", MC_TOOL_NAMES.draftPr, [], "decline"],
    ["read-only", MC_TOOL_NAMES.commit, [MC_TOOL_NAMES.commit], "decline"],
    ["read-only", MC_TOOL_NAMES.reportPlan, [], "decline"],
    ["read-only", MC_TOOL_NAMES.reportPlan, [MC_TOOL_NAMES.reportPlan], "accept"],
    ["scratch", MC_TOOL_NAMES.reportFindings, [], "accept"],
    ["scratch", MC_TOOL_NAMES.commit, [], "decline"],
  ] as const)("checks %s grants for %s (%j)", async (mode, tool, grants, decision) => {
    const h = approver(mode, [...grants]);
    expect(await h.approve(elicitation(tool), undefined, signal())).toBe(decision);
    expect(h.seatGrants).toHaveBeenCalledWith("seat");
  });

  it("refuses foreign servers, unknown tools and missing or mismatched call context", async () => {
    const h = approver();
    const req = elicitation();
    for (const request of [
      elicitation(MC_TOOL_NAMES.commit, "other"),
      elicitation("unknown"),
      { ...req, mcpCall: undefined },
      { ...req, mcpCall: { ...req.mcpCall, server: "other" } },
      { ...req, params: { ...req.params, serverName: "other" } },
      { ...req, params: { ...req.params, mode: "url" } },
      {
        ...req,
        params: { ...req.params, requestedSchema: { type: "object", properties: { answer: {} } } },
      },
    ])
      expect(await h.approve(request, undefined, signal())).toBe("decline");
    expect(await h.approve(req, undefined, AbortSignal.abort())).toBe("decline");
  });

  it("checks live grants and the shared superuser guard", async () => {
    const grants = [MC_TOOL_NAMES.reportPlan] as string[];
    const h = approver("read-only", grants);
    expect(await h.approve(elicitation(MC_TOOL_NAMES.reportPlan), undefined, signal())).toBe(
      "accept",
    );
    grants.length = 0;
    expect(await h.approve(elicitation(MC_TOOL_NAMES.reportPlan), undefined, signal())).toBe(
      "decline",
    );
    grants.push(MC_TOOL_NAMES.mergePr);
    expect(await h.approve(elicitation(MC_TOOL_NAMES.mergePr), undefined, signal())).toBe(
      "decline",
    );
    expect(h.record).toHaveBeenLastCalledWith(
      "flight-powers",
      expect.stringContaining(MC_TOOL_NAMES.mergePr),
    );
  });
});

describe("Codex refusal records", () => {
  it("includes the whole refused chain, even when its amendment matches an allowed segment", async () => {
    const h = approver();
    const command = "sed -n 1p a && curl x";
    expect(
      await h.approve(
        {
          id: 1,
          method: "item/commandExecution/requestApproval",
          params: {
            kind: "command",
            cwd,
            command: `/bin/zsh -lc '${command}'`,
            proposedExecpolicyAmendment: ["sed", "-n", "1p", "a"],
          },
        },
        undefined,
        signal(),
      ),
    ).toBe("decline");
    expect(h.record).toHaveBeenCalledWith(
      "codex-allowlist",
      `${GUARD_RULES["codex-allowlist"]}: ${command}`,
    );
  });

  it.each([false, true])(
    "strips controls and caps command and path details at 200 chars (aborted: %s)",
    async (aborted) => {
      const h = approver();
      const detail = `outside\n\t\u001b\u007f\u0085${"x".repeat(220)}`;
      const expected = `outside${"x".repeat(193)}`;
      const s = aborted ? AbortSignal.abort() : signal();
      for (const [method, params, paths] of [
        [
          "item/commandExecution/requestApproval",
          { kind: "command", cwd, command: detail },
          undefined,
        ],
        ["item/fileChange/requestApproval", {}, [detail, "other.ts"]],
      ] as const) {
        expect(await h.approve({ id: 1, method, params }, paths, s)).toBe("decline");
        expect(h.record).toHaveBeenLastCalledWith(
          "codex-allowlist",
          `${GUARD_RULES["codex-allowlist"]}: ${expected}`,
        );
      }
    },
  );

  it("includes all refused file paths and shared-guard refusals", async () => {
    const h = approver("read-only");
    expect(
      await h.approve(
        { id: 1, method: "item/fileChange/requestApproval", params: {} },
        ["apps/a.ts", "apps/b.ts"],
        signal(),
      ),
    ).toBe("decline");
    expect(h.record).toHaveBeenCalledWith(
      "read-only",
      expect.stringContaining("apps/a.ts, apps/b.ts"),
    );
  });
});
