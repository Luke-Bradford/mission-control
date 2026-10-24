import { mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREW_MODES, crewSandboxSettings } from "@mc/core";
import { describe, expect, it } from "vitest";
import {
  newOperatorToken,
  OPERATOR_TOKEN_FILE,
  operatorTokenMatches,
  writeOperatorToken,
} from "../src/operator.ts";

describe("operator token", () => {
  it("writes the token where every seat's sandbox denies reads", () => {
    const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "mc-op-")));
    const path = writeOperatorToken(dataDir, "tok-1");
    expect(path).toBe(join(dataDir, OPERATOR_TOKEN_FILE));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8").trim()).toBe("tok-1");
    const input = {
      cwd: "/w/seat",
      gitCommonDir: "/w/clone/.git",
      worktreeGitDir: "/w/clone/.git/worktrees/seat",
      home: "/home/you",
      toolchainPaths: ["/tools/node", "/tools/pnpm"],
      gitConfigPaths: [],
      allowRead: [],
      dataDir,
      denyRead: [],
    };
    for (const mode of CREW_MODES) {
      const text = crewSandboxSettings(input, mode, { command: "/hub/hook", timeoutS: 10 });
      const sandbox = JSON.parse(text).sandbox;
      const denied = (sandbox.filesystem.denyRead as string[]).some((p) =>
        path.startsWith(`${p}/`),
      );
      expect(denied, mode).toBe(true);
      expect(sandbox.network.allowedDomains).toEqual([]);
      expect(text).not.toContain("tok-1");
    }
  });

  it("matches only the exact token", () => {
    expect(operatorTokenMatches("abc", "abc")).toBe(true);
    for (const given of ["abd", "ab", undefined, ["abc"]]) {
      expect(operatorTokenMatches("abc", given)).toBe(false);
    }
    const [a, b] = [newOperatorToken(), newOperatorToken()];
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
