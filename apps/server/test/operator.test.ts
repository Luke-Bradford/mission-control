import { mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREW_MODES, crewSandboxSettings } from "@mc/core";
import { describe, expect, it } from "vitest";
import {
  newOperatorToken,
  OPERATOR_LOGIN_FILE,
  OPERATOR_SESSION_FILE,
  OPERATOR_TOKEN_FILE,
  openOperatorLogin,
  operatorLoginUrl,
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

describe("operator login", () => {
  const dir = () => realpathSync(mkdtempSync(join(tmpdir(), "mc-op-")));

  it("keeps the session across boots, with a fresh code each, all 0600", () => {
    const dataDir = dir();
    const first = openOperatorLogin(dataDir, 7420);
    const second = openOperatorLogin(dataDir, 7420);
    expect(second.code).not.toBe(first.code);
    expect(readFileSync(join(dataDir, OPERATOR_LOGIN_FILE), "utf8").trim()).toBe(second.code);
    for (const file of [OPERATOR_LOGIN_FILE, OPERATOR_SESSION_FILE]) {
      expect(statSync(join(dataDir, file)).mode & 0o777).toBe(0o600);
    }
    const cookie = second.redeem(second.code) as string;
    const pair = cookie.split(";")[0] ?? "";
    expect(first.signedIn(pair)).toBe(true); // an earlier boot's cookie still signs in
    expect(second.code).toBeNull();
  });

  it("signs in only with the session cookie of this port", () => {
    const login = openOperatorLogin(dir(), 7420);
    const pair = (login.redeem(login.code) as string).split(";")[0] ?? "";
    const value = pair.split("=")[1];
    expect(login.signedIn(`a=b; ${pair}`)).toBe(true);
    for (const header of [undefined, "", pair.replace(/.$/, "x"), `mc_operator_7421=${value}`]) {
      expect(login.signedIn(header)).toBe(false);
    }
  });

  it("builds the sign-in URL", () => {
    expect(operatorLoginUrl(7420, "abc")).toBe("http://127.0.0.1:7420/?operator-login=abc");
  });
});
