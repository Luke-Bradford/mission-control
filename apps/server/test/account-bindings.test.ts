import "./temp-home.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { accountBindingProblem } from "../src/account-bindings.ts";

const dirs: string[] = [];
const profile = (login: string) => {
  const dir = mkdtempSync(join(tmpdir(), "mc-profile-"));
  dirs.push(dir);
  mkdirSync(join(dir, "sessions"));
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({ tokens: { account_id: login, access_token: "fictional-token" } }),
  );
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const account = (id: string, cliProfile?: string) => ({
  id,
  vendor: "codex" as const,
  alertAt: 80,
  stopAt: 100,
  ...(cliProfile === undefined ? {} : { cliProfile }),
});

it("accepts independently logged-in Codex profiles", () => {
  expect(
    accountBindingProblem([
      account("first", profile("fictional-first")),
      account("second", profile("fictional-second")),
    ]),
  ).toBeNull();
});
it("refuses the same login in different profile directories", () => {
  expect(
    accountBindingProblem([
      account("first", profile("fictional-same")),
      account("second", profile("fictional-same")),
    ]),
  ).toContain("same Codex login");
});
it("refuses a profile alias even with different labels", () => {
  const dir = profile("fictional-first");
  expect(
    accountBindingProblem([account("first", dir), account("second", join(dir, "."))]),
  ).toContain("same CLI profile");
});
it("refuses Claude profile isolation rather than inferring it from a label", () => {
  expect(
    accountBindingProblem([{ ...account("first", profile("fictional-first")), vendor: "claude" }]),
  ).toContain("Claude");
});
it("preserves a machine login and refuses two labels for it", () => {
  expect(accountBindingProblem([account("first")])).toBeNull();
  expect(accountBindingProblem([account("first"), account("second")])).toContain(
    "same CLI profile",
  );
});
it("refuses missing logins with fixed text and no credential content", () => {
  const dir = profile("fictional-first");
  writeFileSync(join(dir, "auth.json"), "fictional-secret-malformed");
  const problem = accountBindingProblem([account("first", dir)]);
  expect(problem).toContain("already logged in");
  expect(problem).not.toContain("fictional-secret");
  expect(problem).not.toContain(dir);
});

it("uses the CLI's inherited default Codex home when validating aliases", () => {
  const inherited = profile("fictional-inherited");
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = inherited;
  try {
    expect(accountBindingProblem([account("machine"), account("alias", inherited)])).toContain(
      "same CLI profile",
    );
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});
