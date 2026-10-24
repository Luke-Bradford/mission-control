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
        ["**"],
      ),
    ).toBe(false);
  });

  it("allows new tests, refuses edited, deleted and renamed tests, and limits test/docs types", () => {
    const safe = (type: "test" | "docs" | "bug", path: string, status: string) =>
      awayDiffSafe(type, { base: "base", changes: [{ path, status }] }, DEFAULT_REPO_RULES, ["**"]);
    expect(safe("test", "src/a.test.ts", "A")).toBe(true);
    for (const status of ["M", "D", "R100"])
      expect(safe("bug", "src/a.test.ts", status)).toBe(false);
    expect(safe("test", "src/a.ts", "A")).toBe(false);
    expect(safe("docs", "src/a.ts", "A")).toBe(false);
    expect(safe("docs", "README.md", "M")).toBe(true);
  });
});

// Every sample from the reviewer probe, retained here as a regression table.
const PROBE_PATHS = [
  ".gitlab-ci.yml",
  "azure-pipelines.yml",
  "vitest.config.ts",
  "tsconfig.json",
  ".npmrc",
  "pnpm-workspace.yaml",
  "apps/server/src/store.ts",
  ".claude/agents/x.md",
  ".claude/hooks/pre.sh",
  "apps/web/CLAUDE.md",
  "AGENTS.md",
  "biome.json",
  "Makefile",
  ".env",
  "setup.py",
  "setup.cfg",
  "Pipfile",
  "app/App.csproj",
  "pom.xml",
  "build.gradle",
  "src/oauth/x.ts",
  "openapi.yaml",
  ".husky/pre-commit",
  ".pre-commit-config.yaml",
  "turbo.json",
  ".nvmrc",
  "scripts/deploy.sh",
  "src/session.ts",
  "src/secrets.ts",
  "Directory.Packages.props",
  "alembic/versions/1.py",
  "db/migrate/1.rb",
  "schema.sql",
  ".mcp.json",
  "roles/dev.md",
  "loops/a.md",
  "ops/launchd.plist",
  "apps/web/src/App.tsx",
  "apps/server/src/api.ts",
  "apps/server/src/main.ts",
  "apps/server/src/collectors/github.ts",
  "apps/server/src/github-board.ts",
  "apps/server/src/claim.ts",
  "apps/server/src/update.ts",
  "apps/server/src/accounts.ts",
  "packages/core/src/profiles.ts",
  "packages/core/src/away.ts",
  "apps/server/src/away.ts",
  "apps/server/package.json",
  "config.example.yaml",
  "config.yaml",
  "launchd/com.x.plist",
  "Procfile",
  "netlify.toml",
  "vercel.json",
  "fly.toml",
  "wrangler.toml",
  "app.yaml",
  "serverless.yml",
  "k8s/deploy.yaml",
  "helm/values.yaml",
  "charts/x/values.yaml",
  "Taskfile.yml",
  "justfile",
  "noxfile.py",
  "tox.ini",
  "pytest.ini",
  "conftest.py",
  "jest.setup.ts",
  "vitest.setup.ts",
  "apps/server/test/setup.ts",
  "playwright.config.ts",
  "requirements.in",
  "poetry.lock",
  "uv.lock",
  "environment.yml",
  "Brewfile",
  ".tool-versions",
  "CODEOWNERS",
  "docs/CODEOWNERS",
  "SECURITY.md",
  "LICENSE",
  "src/permissions.ts",
  "src/token.ts",
  "src/login.ts",
  "src/guard/x.ts",
  "src/middleware/x.ts",
  "src/routes/x.ts",
  "src/public/index.ts",
  "src/index.ts",
  "bin/mc",
  "scripts/install.sh",
  "scripts/postinstall.js",
  "apps/web/vite.config.ts",
  "apps/web/index.html",
  "docs/prototype/mission-control-hud.html",
  "docs/run.sh",
  "README.md",
  "docs/guide.md",
  "CONTRIBUTING.md",
  "packages/core/README.md",
];
const PROBE_DOCS = [
  "SECURITY.md",
  "README.md",
  "docs/guide.md",
  "CONTRIBUTING.md",
  "packages/core/README.md",
];
const PROBE_CHORES = [
  ...PROBE_DOCS,
  "packages/core/src/profiles.ts",
  "apps/web/src/App.tsx",
  "LICENSE",
  "src/routes/x.ts",
  "src/public/index.ts",
  "src/index.ts",
  "bin/mc",
  "apps/web/index.html",
  "docs/prototype/mission-control-hud.html",
  "docs/run.sh",
];
it.each(PROBE_PATHS)("probe path %s", (path) => {
  const diff = { base: "b", changes: [{ path, status: "M" }] };
  const rules = { ...DEFAULT_REPO_RULES, hardRules: [] };
  expect(awayDiffSafe("chore", diff, rules, ["**"])).toBe(PROBE_CHORES.includes(path));
  expect(awayDiffSafe("docs", diff, rules, ["**"])).toBe(PROBE_DOCS.includes(path));
  expect(awayDiffSafe("test", { ...diff, changes: [{ path, status: "A" }] }, rules, ["**"])).toBe(
    false,
  );
});
it.each(["permission", "permissions", "token", "tokens", "login", "guard", "middleware"])(
  "holds security segment %s",
  (segment) => {
    for (const path of [`src/${segment}/x.ts`, `src/${segment}.ts`, `src/user-${segment}.ts`]) {
      expect(
        awayDiffSafe("chore", { base: "b", changes: [{ path, status: "A" }] }, DEFAULT_REPO_RULES, [
          "**",
        ]),
      ).toBe(false);
    }
  },
);
it.each(["md", "mdx", "rst", "txt", "png", "jpg", "jpeg", "svg", "gif"])(
  "allows documentation extension %s outside docs",
  (extension) => {
    expect(
      awayDiffSafe(
        "docs",
        { base: "b", changes: [{ path: `guide/a.${extension}`, status: "M" }] },
        DEFAULT_REPO_RULES,
        ["**"],
      ),
    ).toBe(true);
  },
);
it.each(["README", "packages/core/README", "guide/README.notes"])(
  "allows README path %s",
  (path) => {
    expect(
      awayDiffSafe("docs", { base: "b", changes: [{ path, status: "M" }] }, DEFAULT_REPO_RULES, [
        "**",
      ]),
    ).toBe(true);
  },
);
it.each([
  ["docs", "docs/superpowers/specs/a.md", "M", true],
  ["test", "docs/specs/a.md", "A", false],
  ["test", "apps/server/test/helpers.ts", "A", false],
  ["test", "apps/server/test/setup.ts", "A", false],
  ["chore", "apps/server/test/helpers.ts", "M", false],
  ["test", "apps/server/test/helpers.test.ts", "A", true],
  ["test", "apps/server/test/fixtures/x.json", "A", true],
  ["chore", "src/x.ts", "D", true],
  ["chore", "src/foo_test.go", "M", false],
] as const)("probe %s %s %s", (type, path, status, expected) => {
  expect(
    awayDiffSafe(type, { base: "b", changes: [{ path, status }] }, DEFAULT_REPO_RULES, ["**"]),
  ).toBe(expected);
});
it("needs an area covering every changed path", () => {
  const diff = {
    base: "b",
    changes: [
      { path: "apps/web/a.ts", status: "M" },
      { path: "docs/a.md", status: "M" },
    ],
  };
  expect(awayDiffSafe("chore", diff, DEFAULT_REPO_RULES, [])).toBe(false);
  expect(awayDiffSafe("chore", diff, DEFAULT_REPO_RULES, ["apps/**"])).toBe(false);
  expect(awayDiffSafe("chore", diff, DEFAULT_REPO_RULES, ["apps/**", "docs/**"])).toBe(true);
});
it("recognises the probe's type:docs mapping", () => {
  expect(awayTicketType({ size: "S", labels: ["type:docs"] })).toBeNull();
  expect(
    awayTicketType({ size: "S", labels: ["type:docs"] }, { "type:docs": "small-change" }),
  ).toBe("docs");
});
