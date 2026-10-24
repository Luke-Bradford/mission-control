import { describe, expect, it } from "vitest";
import {
  awayDiffSafe,
  awayIsOn,
  awayTicketType,
  DEFAULT_AWAY,
  DEFAULT_REPO_RULES,
} from "../src/index.ts";

const ON = { ...DEFAULT_AWAY, on: true };

describe("away policy", () => {
  it("expires after the named day in the operator's timezone", () => {
    const settings = { ...ON, until: "2026-10-24" };
    expect(awayIsOn(settings, Date.parse("2026-10-24T22:59:59Z"), "Europe/London")).toBe(true);
    expect(awayIsOn(settings, Date.parse("2026-10-24T23:00:00Z"), "Europe/London")).toBe(false);
    expect(awayIsOn(ON, Date.now(), "UTC")).toBe(true);
    expect(awayIsOn(DEFAULT_AWAY, Date.now(), "UTC")).toBe(false);
  });

  it.each(["bug", "chore", "test", "docs"])("recognises a small %s ticket", (label) => {
    expect(awayTicketType({ size: "S", labels: [label] })).toBe(label);
    expect(awayTicketType({ size: "M", labels: [label] })).toBeNull();
  });

  it("uses the repo mapping and refuses missing or conflicting types", () => {
    expect(awayTicketType({ size: "XS", labels: ["defect"] }, { defect: "bugfix" })).toBe("bug");
    expect(awayTicketType({ size: "S", labels: [] })).toBeNull();
    expect(awayTicketType({ size: "S", labels: ["bug", "type:feature"] })).toBeNull();
    expect(awayTicketType({ size: "S", labels: ["bug", "docs"] })).toBeNull();
  });

  it.each([
    "apps/server/src/engine/a.ts",
    "db/migrations/001.sql",
    "src/settings.ts",
    ".github/workflows/ci.yml",
    "infra/main.tf",
    "package.json",
    "packages/app/package.json",
    "pnpm-lock.yaml",
    "src/auth/login.ts",
    "src/api/routes.ts",
  ])("holds unsafe path %s even when the repo omits hard rules", (path) => {
    expect(
      awayDiffSafe(
        "chore",
        { base: "base", changes: [{ path, status: "A" }] },
        { ...DEFAULT_REPO_RULES, hardRules: [] },
      ),
    ).toBe(false);
  });

  it("allows new tests, refuses edited, deleted and renamed tests, and limits test/docs types", () => {
    const safe = (type: "test" | "docs" | "bug", path: string, status: string) =>
      awayDiffSafe(type, { base: "base", changes: [{ path, status }] }, DEFAULT_REPO_RULES);
    expect(safe("test", "src/a.test.ts", "A")).toBe(true);
    for (const status of ["M", "D", "R100"])
      expect(safe("bug", "src/a.test.ts", status)).toBe(false);
    expect(safe("test", "src/a.ts", "A")).toBe(false);
    expect(safe("docs", "src/a.ts", "A")).toBe(false);
    expect(safe("docs", "README.md", "M")).toBe(true);
  });
});
