import "./temp-home.ts";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BUILTIN_ROLES,
  CREW_EFFORTS,
  DEFAULT_CREW_NODE,
  DEFAULT_SEAT_COMMANDS,
  FLIGHT_TOOLS,
} from "@mc/core";
import { describe, expect, it } from "vitest";
import {
  type CcConfig,
  ConfigError,
  crewAllowed,
  crewSeatGrants,
  crewSeatMode,
  DEFAULT_PORT,
  findHubRoot,
  isPreview,
  loadConfig,
  parseConfig,
  portFromEnv,
} from "../src/config.ts";
import { configView } from "../src/views.ts";

const EXAMPLE_SOURCE = resolve(import.meta.dirname, "../../../config.example.yaml");
/** `crew.node` must be an executable file, and the default only exists on the author's Mac. */
const withNode = (yaml: string) =>
  yaml.replace("\ncrew:\n", `\ncrew:\n  node: ${process.execPath}\n`);
/** The example config, pointed at this machine's node. */
const EXAMPLE = join(mkdtempSync(join(tmpdir(), "mc-example-")), "config.yaml");
writeFileSync(EXAMPLE, withNode(readFileSync(EXAMPLE_SOURCE, "utf8")));

function tmpConfig(mutate: (yaml: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-config-"));
  const p = join(dir, "config.yaml");
  writeFileSync(p, mutate(readFileSync(EXAMPLE, "utf8")));
  return p;
}

function errorOf(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return e as ConfigError;
  }
  throw new Error("expected ConfigError");
}

describe("loadConfig", () => {
  it("loads the example config", () => {
    const c = loadConfig(EXAMPLE);
    expect(c.operator.timezone).toBe("UTC");
    expect(c.accounts.map((a) => a.id)).toEqual(["claude-main", "codex-main"]);
    expect(c.accounts[0]).toMatchObject({ vendor: "claude", alertAt: 85, stopAt: 95 });
    expect(c.repos[0]?.statusMap["In Review"]).toBe("review");
    expect(c.repos[1]?.statusMap.Blocking).toBe("blocked");
    expect(c.loops.map((l) => l.id)).toEqual(["shop-app-ta", "studio-builder"]);
    expect(c.loops[1]).toMatchObject({
      kind: "studio-loop",
      launchdLabel: "com.site-builder.studio-build-driver",
    });
    expect(c.poll).toEqual({ usageMinutes: 30, githubSeconds: 60 });
  });

  it("reads updates.cli, defaulting to off", () => {
    expect(loadConfig(EXAMPLE).updates).toEqual({ hub: "off", cli: "off" });
    const on = tmpConfig((y) => `${y}\nupdates:\n  cli: between_runs\n`);
    expect(loadConfig(on).updates).toEqual({ hub: "off", cli: "between_runs" });
    const bad = tmpConfig((y) => `${y}\nupdates:\n  cli: sometimes\n`);
    expect(errorOf(() => loadConfig(bad)).path).toBe("updates.cli");
  });

  it('reads operator.id, defaulting to "operator"', () => {
    expect(loadConfig(EXAMPLE).operator.id).toBe("operator");
    const named = tmpConfig((y) => y.replace("  id: operator\n", "  id: op\n"));
    expect(loadConfig(named).operator.id).toBe("op");
    const omitted = tmpConfig((y) => y.replace("  id: operator\n", ""));
    expect(loadConfig(omitted).operator.id).toBe("operator");
  });

  it("still accepts a legacy operator.password_hash, and ignores it", () => {
    const legacy = tmpConfig((y) =>
      y.replace("  id: operator\n", '  id: operator\n  password_hash: "scrypt$1$2$3$s$h"\n'),
    );
    const c = loadConfig(legacy);
    expect(c.operator).toEqual({ id: "operator", timezone: "UTC" });
  });

  it("reads updates.hub: off by default, auto when set, nothing else", () => {
    expect(loadConfig(EXAMPLE).updates).toEqual({ hub: "off", cli: "off" });
    const auto = tmpConfig((y) => `${y}\nupdates:\n  hub: auto\n`);
    expect(loadConfig(auto).updates).toEqual({ hub: "auto", cli: "off" });
    const bad = tmpConfig((y) => `${y}\nupdates:\n  hub: always\n`);
    expect(errorOf(() => loadConfig(bad)).path).toBe("updates.hub");
  });

  it("rejects an empty operator.id", () => {
    const p = tmpConfig((y) => y.replace("  id: operator\n", '  id: ""\n'));
    expect(errorOf(() => loadConfig(p)).path).toBe("operator.id");
  });

  it("bounds poll intervals: github_seconds 30..3600, usage_minutes 5..240", () => {
    const poll = (gh: number, usage: number) =>
      tmpConfig((y) =>
        y
          .replace("github_seconds: 60", `github_seconds: ${gh}`)
          .replace("usage_minutes: 30", `usage_minutes: ${usage}`),
      );
    expect(loadConfig(poll(30, 5)).poll).toEqual({ usageMinutes: 5, githubSeconds: 30 });
    expect(loadConfig(poll(3600, 240)).poll).toEqual({ usageMinutes: 240, githubSeconds: 3600 });
    expect(errorOf(() => loadConfig(poll(29, 30))).path).toBe("poll.githubSeconds");
    expect(errorOf(() => loadConfig(poll(3601, 30))).path).toBe("poll.githubSeconds");
    expect(errorOf(() => loadConfig(poll(60, 4))).path).toBe("poll.usageMinutes");
    expect(errorOf(() => loadConfig(poll(60, 241))).path).toBe("poll.usageMinutes");
  });

  it("requires launchd_label to be letters, digits, dot, underscore or hyphen", () => {
    const label = (v: string) =>
      tmpConfig((y) => y.replace("launchd_label: com.shop-app.ta-loop", `launchd_label: "${v}"`));
    expect(loadConfig(label("com.shop-app_ta-loop.2")).loops[0]?.launchdLabel).toBe(
      "com.shop-app_ta-loop.2",
    );
    for (const bad of ["com shop-app", "a/b", "gui/501/x", "x;y", "é"])
      expect(errorOf(() => loadConfig(label(bad))).path).toBe("loops[0].launchdLabel");
  });

  it("expands ~ to the home directory", () => {
    const c = loadConfig(EXAMPLE);
    expect(c.loops[0]?.stateDir).toBe(join(homedir(), "code/.shop-app-autonomy/var/autonomy"));
    expect(c.loops[0]?.worktree).toBe(join(homedir(), "code/.shop-app-autonomy"));
    expect(c.loops[1]?.logsDir).toBe(join(homedir(), "code/studio-loop/logs"));
    expect(c.loops[0]?.logsDir).toBeUndefined();
  });

  it("rejects a loop whose repoId is not in repos", () => {
    const p = tmpConfig((y) => y.replace("repo_id: shop-app", "repo_id: nope"));
    const e = errorOf(() => loadConfig(p));
    expect(e.path).toBe("loops[0].repoId");
    expect(e.message).toContain("loops[0].repoId");
  });

  it("rejects a loop whose accountId is not in accounts", () => {
    const p = tmpConfig((y) => y.replace("account_id: claude-main", "account_id: nope"));
    expect(errorOf(() => loadConfig(p)).path).toBe("loops[0].accountId");
  });

  it("rejects a second account of the same vendor (usage credentials are one login per vendor)", () => {
    const p = tmpConfig((y) => y.replace("vendor: codex", "vendor: claude"));
    const e = errorOf(() => loadConfig(p));
    expect(e.path).toBe("accounts[1].vendor");
    expect(e.message).toContain('second "claude" account');
  });

  it("rejects duplicate ids in accounts, repos and loops", () => {
    const acct = tmpConfig((y) =>
      y.replace("  - id: codex-main\n    vendor: codex", "  - id: claude-main\n    vendor: codex"),
    );
    expect(errorOf(() => loadConfig(acct)).path).toBe("accounts[1].id");
    const repo = tmpConfig((y) => y.replace("  - id: site-builder", "  - id: shop-app"));
    const re = errorOf(() => loadConfig(repo));
    expect(re.path).toBe("repos[1].id");
    expect(re.message).toContain('duplicate id "shop-app"');
    const loop = tmpConfig((y) => y.replace("  - id: studio-builder", "  - id: shop-app-ta"));
    expect(errorOf(() => loadConfig(loop)).path).toBe("loops[1].id");
  });

  it("reads optional needs_you_labels per repo", () => {
    const p = tmpConfig((y) =>
      y.replace(
        "    project: 2\n",
        "    project: 2\n    needs_you_labels: [needs-design, needs-human]\n",
      ),
    );
    const c = loadConfig(p);
    expect(c.repos[0]?.needsYouLabels).toEqual(["needs-design", "needs-human"]);
    expect(c.repos[1]?.needsYouLabels).toBeUndefined();
  });

  it("rejects a statusMap value outside TicketState", () => {
    const p = tmpConfig((y) => y.replace("Todo: planned", "Todo: someday"));
    const e = errorOf(() => loadConfig(p));
    expect(e.path).toBe("repos[0].statusMap.Todo");
  });

  it("reports snake_case fields under their camelCase path", () => {
    const p = tmpConfig((y) => y.replace("alert_at: 85", "alert_at: lots"));
    expect(errorOf(() => loadConfig(p)).path).toBe("accounts[0].alertAt");
  });

  it("throws ConfigError with empty path for a missing file", () => {
    const e = errorOf(() => loadConfig("/nonexistent/cc/config.yaml"));
    expect(e.path).toBe("");
    expect(e.message).toContain("/nonexistent/cc/config.yaml");
  });

  it("throws ConfigError with empty path for invalid YAML", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-config-"));
    const p = join(dir, "bad.yaml");
    writeFileSync(p, "a: [unclosed");
    expect(errorOf(() => loadConfig(p)).path).toBe("");
  });
});

describe("parseConfig", () => {
  it("validates text exactly as loadConfig validates the file", () => {
    const text = readFileSync(EXAMPLE, "utf8");
    expect(parseConfig(text, "example")).toEqual(loadConfig(EXAMPLE));
  });

  it("names the source, not a file, in its errors", () => {
    const e = errorOf(() => parseConfig("a: [unclosed", "the new text"));
    expect(e.path).toBe("");
    expect(e.message).toContain("the new text");
    const dup = readFileSync(EXAMPLE, "utf8").replace("  - id: site-builder", "  - id: shop-app");
    expect(errorOf(() => parseConfig(dup, "x")).path).toBe("repos[1].id");
  });
});

describe("portFromEnv (MC_PORT)", () => {
  it("defaults to 7420 when unset or empty", () => {
    expect(DEFAULT_PORT).toBe(7420);
    expect(portFromEnv(undefined)).toBe(7420);
    expect(portFromEnv("")).toBe(7420);
  });

  it("accepts an integer from 1024 to 65535", () => {
    expect(portFromEnv("1024")).toBe(1024);
    expect(portFromEnv("7431")).toBe(7431);
    expect(portFromEnv("65535")).toBe(65535);
  });

  it.each(["1023", "65536", "0", "-1", "7431.5", "7e3", " 7431", "0x1d07", "abc", "7431abc"])(
    "rejects %j as a ConfigError on MC_PORT",
    (raw) => {
      expect(errorOf(() => portFromEnv(raw)).path).toBe("MC_PORT");
    },
  );
});

describe("crew", () => {
  const hub = mkdtempSync(join(tmpdir(), "mc-hub-"));
  const guard = { hubRoot: hub };
  const exampleText = readFileSync(EXAMPLE, "utf8");
  const withoutCrew = exampleText.slice(0, exampleText.indexOf("\ncrew:"));

  const seat = (id: string, role: string, extra = "", account = "claude-main") =>
    `          - { id: ${id}, role: ${role}, account_id: ${account}, model: sonnet${extra} }`;
  /** The example config with its crew section replaced. */
  function crewText(opts: {
    seats?: string[];
    checkout?: string;
    worktrees?: string;
    repo?: string;
    sessionId?: string;
    maxSeats?: number;
    node?: string;
    denyRead?: string[];
    budget?: string;
    lane?: string;
    laneDefault?: string;
    /** `crew.roles` entries, one `NAME: {…}` per line. */
    roles?: string[];
  }): string {
    const seats = opts.seats ?? [
      seat("guido-1", "GUIDO", ', area: ["apps/server/**"]'),
      seat("inco-1", "INCO", ', area: ["apps/web/**"]'),
    ];
    return `${withoutCrew}
crew:
  node: ${opts.node ?? process.execPath}
  worktrees: ${opts.worktrees ?? "~/code/mc-crew/worktrees"}
  ${opts.maxSeats === undefined ? "" : `max_seats: ${opts.maxSeats}`}
  ${opts.denyRead === undefined ? "" : `deny_read: ${JSON.stringify(opts.denyRead)}`}
  ${opts.budget === undefined ? "" : `run_token_budget: ${opts.budget}`}
  ${opts.lane === undefined ? "" : `lane: ${opts.lane}`}
  ${opts.laneDefault === undefined ? "" : `lane_default: ${opts.laneDefault}`}
${opts.roles === undefined ? "" : `  roles:\n${opts.roles.map((r) => `    ${r}`).join("\n")}`}
  sessions:
    - id: ${opts.sessionId ?? "shop-app"}
      repo_id: ${opts.repo ?? "shop-app"}
      checkout: ${opts.checkout ?? "~/code/mc-crew/shop-app"}
      seats:
${seats.join("\n")}
`;
  }
  const load = (t: string) => parseConfig(t, "test", guard);
  const fails = (t: string) => errorOf(() => load(t));

  it("is absent when the file has no crew section", () => {
    expect(load(withoutCrew).crew).toBeUndefined();
  });

  it("loads the example config's crew, camelCased, with ~ expanded and the default max_seats", () => {
    const c = loadConfig(EXAMPLE).crew;
    expect(c?.worktrees).toBe(join(homedir(), "code/mc-crew/worktrees"));
    expect(c?.maxSeats).toBe(8);
    expect(c?.sessions[0]).toMatchObject({
      id: "mission-control",
      repoId: "mission-control",
      checkout: join(homedir(), "code/mc-crew/mission-control"),
    });
    expect(c?.sessions[0]?.seats.map((s) => [s.id, s.role, s.area])).toEqual([
      ["guido-1", "GUIDO", ["apps/server/**", "packages/core/**"]],
      ["inco-1", "INCO", ["apps/web/**"]],
      ["retro-1", "RETRO", []],
    ]);
  });

  it("defaults run_token_budget to 400000 and takes a positive integer", () => {
    expect(load(crewText({})).crew?.runTokenBudget).toBe(400000);
    expect(load(crewText({ budget: "250000" })).crew?.runTokenBudget).toBe(250000);
  });

  it("rejects a run_token_budget of 0 or a non-integer", () => {
    for (const bad of ["0", "-5", "1.5", '"lots"']) {
      expect(fails(crewText({ budget: bad })).path).toBe("crew.runTokenBudget");
    }
  });

  it.each(["../x", "Shop", "a/b", ""])("refuses the session id %j (it is a folder name)", (id) => {
    expect(fails(crewText({ sessionId: JSON.stringify(id) })).path).toBe("crew.sessions[0].id");
  });

  it("takes lane home or work only, and defaults lane_default to false", () => {
    const none = load(crewText({})).crew;
    expect(none?.lane).toBeUndefined();
    expect(none?.laneDefault).toBe(false);
    expect(load(crewText({ lane: "home" })).crew?.lane).toBe("home");
    expect(load(crewText({ lane: "work", laneDefault: "true" })).crew).toMatchObject({
      lane: "work",
      laneDefault: true,
    });
    expect(fails(crewText({ lane: "other" })).path).toBe("crew.lane");
    expect(fails(crewText({ laneDefault: '"yes"' })).path).toBe("crew.laneDefault");
  });

  it("rejects overlapping writer areas", () => {
    const e = fails(
      crewText({
        seats: [
          seat("guido-1", "GUIDO", ', area: ["apps/**"]'),
          seat("inco-1", "INCO", ', area: ["apps/web/**"]'),
        ],
      }),
    );
    expect(e.path).toBe("crew.sessions[0].seats[1].area");
    expect(e.message).toContain("areas overlap: guido-1 and inco-1");
  });

  it("accepts two writers with the same area, in any order", () => {
    const t = crewText({
      seats: [
        seat("guido-1", "GUIDO", ', area: ["apps/server/**", "packages/core/**"]'),
        seat("guido-2", "GUIDO", ', area: ["packages/core/**", "apps/server/**"]'),
      ],
    });
    expect(load(t).crew?.sessions[0]?.seats).toHaveLength(2);
  });

  it("accepts two whole-checkout writers", () => {
    const t = crewText({ seats: [seat("guido-1", "GUIDO"), seat("guido-2", "GUIDO")] });
    expect(load(t).crew?.sessions[0]?.seats).toHaveLength(2);
  });

  it("accepts twins beside a writer with its own area", () => {
    const t = crewText({
      seats: [
        seat("guido-1", "GUIDO", ', area: ["apps/server/**"]'),
        seat("guido-2", "GUIDO", ', area: ["apps/server/**"]'),
        seat("inco-1", "INCO", ', area: ["apps/web/**"]'),
      ],
    });
    expect(load(t).crew?.sessions[0]?.seats).toHaveLength(3);
  });

  it("still refuses an area that shares only some globs", () => {
    const e = fails(
      crewText({
        seats: [
          seat("guido-1", "GUIDO", ', area: ["apps/server/**", "packages/core/**"]'),
          seat("guido-2", "GUIDO", ', area: ["apps/server/**"]'),
        ],
      }),
    );
    expect(e.path).toBe("crew.sessions[0].seats[1].area");
    expect(e.message).toBe(
      "crew.sessions[0].seats[1].area: areas overlap: guido-1 and guido-2; writers may share an area only when it is the same list of globs",
    );
  });

  it("accepts sibling areas that share only a name prefix", () => {
    const t = crewText({
      seats: [
        seat("guido-1", "GUIDO", ', area: ["apps/web/**"]'),
        seat("inco-1", "INCO", ', area: ["apps/webhook/**"]'),
      ],
    });
    expect(load(t).crew?.sessions[0]?.seats).toHaveLength(2);
  });

  it("an empty writer area overlaps every other writer", () => {
    const e = fails(
      crewText({
        seats: [seat("guido-1", "GUIDO"), seat("inco-1", "INCO", ', area: ["apps/web/**"]')],
      }),
    );
    expect(e.path).toBe("crew.sessions[0].seats[1].area");
    expect(e.message).toContain("areas overlap: guido-1 and inco-1");
  });

  it("a read-only seat may sit beside writers but may not have an area", () => {
    const e = fails(crewText({ seats: [seat("retro-1", "RETRO", ', area: ["apps/**"]')] }));
    expect(e.path).toBe("crew.sessions[0].seats[0].area");
  });

  it("mode: scratch loads on RETRO", () => {
    const cfg = load(crewText({ seats: [seat("retro-1", "RETRO", ", mode: scratch")] }));
    expect(cfg.crew?.sessions[0]?.seats[0]?.mode).toBe("scratch");
    expect(crewSeatMode(cfg, "retro-1")).toBe("scratch");
  });

  describe("roles", () => {
    const SCOUT = "SCOUT: { prompt: roles/SCOUT.md, model: haiku, mode: read-only, loop: none }";
    const modelless = (id: string, role: string, extra = "") =>
      `          - { id: ${id}, role: ${role}, account_id: claude-main${extra} }`;
    mkdirSync(join(hub, "roles"), { recursive: true });
    writeFileSync(join(hub, "roles", "SCOUT.md"), "# SCOUT\n");
    const roleErr = (roles: string[], seats?: string[]) =>
      fails(crewText({ roles, ...(seats === undefined ? {} : { seats }) }));

    it("no crew.roles: built-in defs", () => {
      const crew = load(crewText({})).crew;
      expect(crew?.roles).toEqual(BUILTIN_ROLES);
      const [guido, inco] = crew?.sessions[0]?.seats ?? [];
      expect(guido?.def).toEqual({
        mode: "writer",
        loop: "build",
        prompt: "roles/GUIDO.md",
        mcTools: [],
        here: "backend developer, test-first in its area",
      });
      expect(inco?.def).toMatchObject({ mode: "writer", loop: "build" });
    });

    it("a seat without model gets its role's", () => {
      const seats = [modelless("guido-1", "GUIDO", ', area: ["apps/**"]'), modelless("r", "RETRO")];
      const [guido, retro] = load(crewText({ seats })).crew?.sessions[0]?.seats ?? [];
      expect(guido?.model).toBe("sonnet");
      expect(retro?.model).toBe("opus");
    });

    it("a config role", () => {
      const cfg = load(crewText({ roles: [SCOUT], seats: [modelless("scout-1", "SCOUT")] }));
      const s = cfg.crew?.sessions[0]?.seats[0];
      expect(s?.model).toBe("haiku");
      expect(s?.def).toEqual({
        mode: "read-only",
        loop: "none",
        prompt: "roles/SCOUT.md",
        mcTools: [],
        here: "crew member",
      });
      expect(cfg.crew?.roles?.SCOUT).toMatchObject({ model: "haiku", here: "crew member" });
      expect(crewSeatGrants(cfg, "scout-1")).toEqual([]);
    });

    it("replacing a built-in", () => {
      const cfg = load(
        crewText({
          roles: [
            "GUIDO: { prompt: roles/SCOUT.md, model: opus, mode: writer, loop: build, here: me }",
          ],
          seats: [modelless("guido-1", "GUIDO")],
        }),
      );
      const s = cfg.crew?.sessions[0]?.seats[0];
      expect(s?.model).toBe("opus");
      expect(s?.def).toMatchObject({ prompt: "roles/SCOUT.md", here: "me" });
    });

    it("refuses a replacement that is not whole", () => {
      expect(roleErr(["GUIDO: { model: opus }"]).path).toBe("crew.roles.GUIDO.prompt");
    });

    it("1: a name of 2–16 capitals or digits", () => {
      const e = roleErr([
        "scout: { prompt: roles/SCOUT.md, model: haiku, mode: read-only, loop: none }",
      ]);
      expect(e.path).toBe("crew.roles.scout");
      expect(e.message).toBe(
        "crew.roles.scout: role names are 2–16 capital letters or digits, starting with a letter",
      );
    });

    it("2: the loop must suit the mode", () => {
      const e = roleErr([
        "SCOUT: { prompt: roles/SCOUT.md, model: haiku, mode: read-only, loop: build }",
      ]);
      expect(e.message).toBe(
        "crew.roles.SCOUT.loop: a read-only role's loop is none or plan or watch, not build",
      );
    });

    it("a flight-1 FLIGHT seat is read-only and watches", () => {
      const cfg = load(crewText({ seats: [modelless("flight-1", "FLIGHT")] }));
      const s = cfg.crew?.sessions[0]?.seats[0];
      expect(s?.model).toBe("opus");
      expect(s?.def).toMatchObject({ mode: "read-only", loop: "watch", mcTools: FLIGHT_TOOLS });
      expect(crewSeatGrants(cfg, "flight-1")).toEqual(FLIGHT_TOOLS);
    });

    it("only one seat may watch, in any session", () => {
      const text = `${crewText({ seats: [modelless("flight-1", "FLIGHT")] })}
    - id: other
      repo_id: shop-app
      checkout: ~/code/mc-crew/shop-app-other
      seats:
${modelless("flight-2", "FLIGHT")}
`;
      const e = fails(text);
      expect(e.path).toBe("crew.sessions[1].seats[0].role");
      expect(e.message).toBe(
        "crew.sessions[1].seats[0].role: only one seat may run the watch loop; flight-1 already does",
      );
    });

    it("FLIGHT takes no area", () => {
      const e = fails(crewText({ seats: [seat("flight-1", "FLIGHT", ', area: ["apps/**"]')] }));
      expect(e.message).toBe(
        "crew.sessions[0].seats[0].area: FLIGHT is read-only and takes no area",
      );
    });

    it("a role holding log_decision needs the watch loop", () => {
      const e = roleErr([
        "SCOUT: { prompt: roles/SCOUT.md, model: haiku, mode: read-only, loop: none, tools: [log_decision] }",
      ]);
      expect(e.path).toBe("crew.roles.SCOUT.tools");
      expect(e.message).toBe("crew.roles.SCOUT.tools: log_decision is only for a watch role");
    });

    it("a plan role may hold read_ticket", () => {
      const cfg = load(
        crewText({
          roles: [
            "FAO: { prompt: roles/SCOUT.md, model: opus, mode: read-only, loop: plan, tools: [report_plan, read_ticket] }",
          ],
        }),
      );
      expect(cfg.crew?.roles?.FAO?.tools).toEqual(["report_plan", "read_ticket"]);
    });

    it("a plan role may not hold another FLIGHT tool", () => {
      const e = roleErr([
        "FAO: { prompt: roles/SCOUT.md, model: opus, mode: read-only, loop: plan, tools: [report_plan, answer_question] }",
      ]);
      expect(e.message).toBe("crew.roles.FAO.tools: answer_question is only for a watch role");
    });

    it("read_ticket is refused on a role that is neither watch nor plan", () => {
      const e = roleErr([
        "SCOUT: { prompt: roles/SCOUT.md, model: haiku, mode: read-only, loop: none, tools: [read_ticket] }",
      ]);
      expect(e.message).toBe(
        "crew.roles.SCOUT.tools: read_ticket is only for a watch or plan role",
      );
    });

    it("3: a tool must be grantable", () => {
      const e = roleErr([
        "SCOUT: { prompt: roles/SCOUT.md, model: haiku, mode: writer, loop: build, tools: [push] }",
      ]);
      expect(e.message).toBe("crew.roles.SCOUT.tools: push cannot be granted to a writer role");
    });

    it("4: the prompt must be a file in the hub's roles folder", () => {
      const e = roleErr([
        "SCOUT: { prompt: roles/NOPE.md, model: haiku, mode: read-only, loop: none }",
      ]);
      expect(e.message).toBe(
        "crew.roles.SCOUT.prompt: roles/NOPE.md is not a file in the hub's roles folder",
      );
      expect(
        roleErr(["SCOUT: { prompt: ../x.md, model: haiku, mode: read-only, loop: none }"]).message,
      ).toBe("crew.roles.SCOUT.prompt: must be roles/<name>.md");
    });

    it("4: a prompt symlinked out of roles/ is refused", () => {
      const outside = join(mkdtempSync(join(tmpdir(), "mc-out-")), "x.md");
      writeFileSync(outside, "x\n");
      symlinkSync(outside, join(hub, "roles", "LINK.md"));
      const e = roleErr([
        "LINK: { prompt: roles/LINK.md, model: haiku, mode: read-only, loop: none }",
      ]);
      expect(e.message).toBe(
        "crew.roles.LINK.prompt: roles/LINK.md is not a file in the hub's roles folder",
      );
    });

    it("5: a seat's role must exist", () => {
      const e = fails(crewText({ seats: [seat("x-1", "NOBODY")] }));
      expect(e.message).toBe('crew.sessions[0].seats[0].role: unknown role "NOBODY"');
    });

    it("6: a scratch config role takes no area", () => {
      const e = roleErr(
        ["REV: { prompt: roles/SCOUT.md, model: haiku, mode: scratch, loop: review }"],
        [seat("rev-1", "REV", ', area: ["apps/**"]')],
      );
      expect(e.message).toBe("crew.sessions[0].seats[0].area: REV is scratch and takes no area");
    });

    it("6: scratch is for read-only roles", () => {
      const e = fails(crewText({ seats: [seat("g", "GUIDO", ", mode: scratch")] }));
      expect(e.message).toBe(
        "crew.sessions[0].seats[0].mode: scratch is for read-only roles (RETRO), not GUIDO",
      );
    });
  });

  it("the config view says scratch for a scratch seat, and read-only for a RETRO without mode", () => {
    const scratchCfg = load(crewText({ seats: [seat("retro-1", "RETRO", ", mode: scratch")] }));
    expect(configView(scratchCfg).crew?.sessions[0]?.seats[0]?.mode).toBe("scratch");
    const plain = load(crewText({ seats: [seat("retro-1", "RETRO")] }));
    expect(configView(plain).crew?.sessions[0]?.seats[0]?.mode).toBe("read-only");
  });

  it("mode: scratch is refused on a writer", () => {
    const e = fails(
      crewText({ seats: [seat("guido-1", "GUIDO", ', mode: scratch, area: ["apps/**"]')] }),
    );
    expect(e.path).toBe("crew.sessions[0].seats[0].mode");
    expect(e.message).toContain("scratch is for read-only roles (RETRO), not GUIDO");
  });

  it("mode: writer is not a config value", () => {
    const e = fails(crewText({ seats: [seat("retro-1", "RETRO", ", mode: writer")] }));
    expect(e.path).toBe("crew.sessions[0].seats[0].mode");
  });

  it("a scratch seat with an area is refused as any read-only seat is", () => {
    const e = fails(
      crewText({ seats: [seat("retro-1", "RETRO", ', mode: scratch, area: ["apps/**"]')] }),
    );
    expect(e.message).toContain("RETRO is read-only and takes no area");
  });

  it("rejects an unknown repo, a codex account, an unknown account and an unknown role", () => {
    expect(fails(crewText({ repo: "nope" })).path).toBe("crew.sessions[0].repoId");
    expect(fails(crewText({ seats: [seat("guido-1", "GUIDO", "", "codex-main")] })).path).toBe(
      "crew.sessions[0].seats[0].accountId",
    );
    expect(fails(crewText({ seats: [seat("guido-1", "GUIDO", "", "nope")] })).path).toBe(
      "crew.sessions[0].seats[0].accountId",
    );
    expect(fails(crewText({ seats: [seat("fido-1", "FIDO")] })).path).toBe(
      "crew.sessions[0].seats[0].role",
    );
  });

  it("rejects a seat id that repeats a loop id or another seat, or is malformed", () => {
    expect(fails(crewText({ seats: [seat("shop-app-ta", "GUIDO")] })).path).toBe(
      "crew.sessions[0].seats[0].id",
    );
    expect(
      fails(
        crewText({
          seats: [
            seat("a-1", "GUIDO", ', area: ["x/**"]'),
            seat("a-1", "INCO", ', area: ["y/**"]'),
          ],
        }),
      ).path,
    ).toBe("crew.sessions[0].seats[1].id");
    expect(fails(crewText({ seats: [seat("Guido_1", "GUIDO")] })).path).toBe(
      "crew.sessions[0].seats[0].id",
    );
  });

  it("rejects more seats than max_seats, and max_seats outside 1..32", () => {
    const seats = [
      seat("a-1", "GUIDO", ', area: ["a/**"]'),
      seat("b-1", "GUIDO", ', area: ["b/**"]'),
    ];
    expect(fails(crewText({ seats, maxSeats: 1 })).path).toBe("crew.maxSeats");
    expect(load(crewText({ seats, maxSeats: 2 })).crew?.maxSeats).toBe(2);
    expect(fails(crewText({ seats, maxSeats: 0 })).path).toBe("crew.maxSeats");
    expect(fails(crewText({ seats, maxSeats: 33 })).path).toBe("crew.maxSeats");
  });

  it("refuses a checkout or worktrees path that is or lies inside the hub's checkout", () => {
    expect(fails(crewText({ checkout: hub })).path).toBe("crew.sessions[0].checkout");
    expect(fails(crewText({ checkout: join(hub, "clone") })).path).toBe(
      "crew.sessions[0].checkout",
    );
    expect(fails(crewText({ worktrees: join(hub, "wt") })).path).toBe("crew.worktrees");
    // a sibling that merely shares the name prefix is fine
    expect(load(crewText({ checkout: `${hub}-clone` })).crew).toBeDefined();
  });

  it("refuses paths inside any loop's worktree, state_dir or logs_dir", () => {
    for (const dir of [
      "~/code/.shop-app-autonomy/x",
      "~/code/studio-loop-repo",
      "~/code/studio-loop/logs/a",
    ]) {
      expect(fails(crewText({ checkout: dir })).path).toBe("crew.sessions[0].checkout");
      expect(fails(crewText({ worktrees: dir })).path).toBe("crew.worktrees");
    }
  });

  it("fails closed when crew is configured and the hub's checkout cannot be located", () => {
    const e = errorOf(() => parseConfig(crewText({}), "t", { hubRoot: null }));
    expect(e.path).toBe("crew");
    expect(e.message).toContain("cannot locate the hub's own checkout");
    expect(() => parseConfig(withoutCrew, "t", { hubRoot: null })).not.toThrow();
  });

  it("finds the hub root from the server module's location", () => {
    expect(findHubRoot()).toBe(resolve(import.meta.dirname, "../../.."));
  });

  it("refuses containment in both directions", () => {
    // worktrees containing the hub, a loop dir; checkout containing them
    expect(fails(crewText({ worktrees: join(hub, "..") })).path).toBe("crew.worktrees");
    expect(fails(crewText({ worktrees: "~/code" })).path).toBe("crew.worktrees");
    expect(fails(crewText({ checkout: "~/code" })).path).toBe("crew.sessions[0].checkout");
    expect(fails(crewText({ checkout: join(hub, "..") })).path).toBe("crew.sessions[0].checkout");
  });

  it("compares real paths: a symlinked parent cannot hide a checkout inside a loop dir", () => {
    const root = mkdtempSync(join(tmpdir(), "mc-link-"));
    const loopDir = join(root, "loop");
    mkdirSync(loopDir);
    symlinkSync(loopDir, join(root, "alias"));
    const t = crewText({ checkout: join(root, "alias", "clone") }).replace(
      "worktree: ~/code/.shop-app-autonomy\n",
      `worktree: ${loopDir}\n`,
    );
    expect(t).toContain(`worktree: ${loopDir}`);
    expect(fails(t).path).toBe("crew.sessions[0].checkout");
  });

  describe("a checkout sharing a git repository with a loop or the hub", () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=n", ...args], {
        cwd,
        stdio: "ignore",
      });
    /** A repo with one commit, and a linked worktree of it beside it (not inside). */
    function repoWithWorktree() {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "mc-common-")));
      const repo = join(root, "repo");
      mkdirSync(repo);
      git(repo, "init", "-q", "-b", "main");
      writeFileSync(join(repo, "a.txt"), "a\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "init");
      const linked = join(root, "linked");
      git(repo, "worktree", "add", "-q", "-b", "loop", linked);
      return { root, repo, linked };
    }

    it("refuses a checkout whose git common dir is a loop worktree's", () => {
      const { repo, linked } = repoWithWorktree();
      // the loop runs in the linked worktree; the crew checkout is the repo it belongs to
      const t = crewText({ checkout: repo }).replace(
        "worktree: ~/code/.shop-app-autonomy\n",
        `worktree: ${linked}\n`,
      );
      expect(t).toContain(`worktree: ${linked}`);
      const e = fails(t);
      expect(e.path).toBe("crew.sessions[0].checkout");
      expect(e.message).toContain("shares its git repository with loop shop-app-ta worktree");
    });

    it("refuses a checkout whose git common dir is the hub's", () => {
      const { repo, linked } = repoWithWorktree();
      const e = errorOf(() => parseConfig(crewText({ checkout: linked }), "t", { hubRoot: repo }));
      expect(e.path).toBe("crew.sessions[0].checkout");
      expect(e.message).toContain("shares its git repository with the hub's checkout");
    });

    it("accepts a separate clone, and skips a loop worktree or hub that is not a git repo", () => {
      const { root, repo } = repoWithWorktree();
      const clone = join(root, "clone");
      git(root, "clone", "-q", repo, clone);
      const plain = join(root, "plain");
      mkdirSync(plain);
      const t = crewText({ checkout: clone }).replace(
        "worktree: ~/code/.shop-app-autonomy\n",
        `worktree: ${repo}\n`,
      );
      expect(load(t).crew?.sessions[0]?.checkout).toBe(clone);
      const noGit = crewText({ checkout: clone }).replace(
        "worktree: ~/code/.shop-app-autonomy\n",
        `worktree: ${plain}\n`,
      );
      expect(parseConfig(noGit, "t", { hubRoot: plain }).crew?.sessions[0]?.checkout).toBe(clone);
    });
  });

  it("refuses checkout and worktrees nesting each other, and two sessions sharing a checkout", () => {
    expect(fails(crewText({ worktrees: "~/code/mc-crew/shop-app/wt" })).path).toBe(
      "crew.sessions[0].checkout",
    );
    expect(fails(crewText({ worktrees: "~/code/mc-crew" })).path).toBe("crew.sessions[0].checkout");
    const second = `    - id: other
      repo_id: site-builder
      checkout: ~/code/mc-crew/shop-app
      seats:
${seat("guido-2", "GUIDO", ', area: ["z/**"]')}
`;
    const e = fails(`${crewText({})}${second}`);
    expect(e.path).toBe("crew.sessions[1].checkout");
  });

  it("validates model names and areas", () => {
    const bad = (extra: string, path: string) =>
      expect(fails(crewText({ seats: [seat("guido-1", "GUIDO", extra)] })).path).toBe(path);
    expect(
      load(
        crewText({ seats: [seat("guido-1", "GUIDO").replace("sonnet", '"claude-opus-4.5[1m]"')] }),
      ).crew,
    ).toBeDefined();
    expect(() =>
      load(crewText({ seats: [seat("guido-1", "GUIDO").replace("sonnet", "--evil")] })),
    ).toThrow(ConfigError);
    expect(() =>
      load(crewText({ seats: [seat("guido-1", "GUIDO").replace("sonnet", '"a b"')] })),
    ).toThrow(ConfigError);
    for (const a of [
      "/abs/**",
      "./x/**",
      "a/../b/**",
      "a/{b,c}/**",
      "a/[x]/**",
      "a/?/**",
      "!a/**",
    ]) {
      bad(`, area: ["${a}"]`, "crew.sessions[0].seats[0].area[0]");
    }
  });
  it("reads a seat's effort from low|medium|high|max and leaves it unset otherwise", () => {
    const seats = (extra: string) => crewText({ seats: [seat("guido-1", "GUIDO", extra)] });
    for (const e of CREW_EFFORTS) {
      expect(load(seats(`, effort: ${e}`)).crew?.sessions[0]?.seats[0]?.effort).toBe(e);
    }
    expect(load(seats("")).crew?.sessions[0]?.seats[0]?.effort).toBeUndefined();
    for (const bad of ["extreme", "High", "'' ", "3"]) {
      expect(fails(seats(`, effort: ${bad}`)).path).toBe("crew.sessions[0].seats[0].effort");
    }
  });

  it("rejects areas with a leading ~, parentheses, commas, backslashes or whitespace", () => {
    for (const a of ["~/x/**", "a/(b)/**", "a,b/**", "a\\\\b/**", "a b/**"]) {
      const e = fails(crewText({ seats: [seat("guido-1", "GUIDO", `, area: ["${a}"]`)] }));
      expect(e.path).toBe("crew.sessions[0].seats[0].area[0]");
    }
  });

  it("refuses a session checkout nested in, or holding, another's", () => {
    const second = (checkout: string) => `    - id: other
      repo_id: site-builder
      checkout: ${checkout}
      seats:
${seat("guido-2", "GUIDO", ', area: ["z/**"]')}
`;
    for (const c of ["~/code/mc-crew/shop-app/inner", "~/code/mc-crew/shop-app"]) {
      expect(fails(`${crewText({})}${second(c)}`).path).toBe("crew.sessions[1].checkout");
    }
    expect(
      load(`${crewText({})}${second("~/code/mc-crew/shop-app2")}`).crew?.sessions,
    ).toHaveLength(2);
  });

  it("compares paths by their on-disk case on a case-insensitive filesystem", (ctx) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mc-case-")));
    const loopDir = join(root, "loopdir");
    mkdirSync(loopDir);
    if (!existsSync(join(root, "LOOPDIR"))) ctx.skip();
    const t = crewText({ checkout: join(root, "LOOPDIR", "clone") }).replace(
      "worktree: ~/code/.shop-app-autonomy\n",
      `worktree: ${loopDir}\n`,
    );
    expect(fails(t).path).toBe("crew.sessions[0].checkout");
  });

  describe("deny_read", () => {
    const holds = (p: string) => `crew.deny_read: ${p} holds the crew's own folders`;

    it("loads with ~ expanded, and defaults to none", () => {
      expect(load(crewText({})).crew?.denyRead).toEqual([]);
      const c = load(crewText({ denyRead: ["~/Work", "/Volumes/Projects"] })).crew;
      expect(c?.denyRead).toEqual([join(homedir(), "Work"), "/Volumes/Projects"]);
    });

    it("refuses ~/code when the worktrees live under it", () => {
      const e = fails(crewText({ denyRead: ["~/Work", "~/code"] }));
      expect(e.path).toBe("crew.deny_read");
      expect(e.message).toBe(holds(join(homedir(), "code")));
    });

    it("refuses the worktrees folder itself, a folder holding a session checkout, or the temp dir", () => {
      expect(fails(crewText({ denyRead: ["~/code/mc-crew/worktrees"] })).message).toBe(
        holds(join(homedir(), "code/mc-crew/worktrees")),
      );
      const elsewhere = { worktrees: "~/crew-worktrees" };
      expect(fails(crewText({ ...elsewhere, denyRead: ["~/code/mc-crew"] })).message).toBe(
        holds(join(homedir(), "code/mc-crew")),
      );
      expect(load(crewText({ ...elsewhere, denyRead: ["~/code/other"] })).crew?.denyRead).toEqual([
        join(homedir(), "code/other"),
      ]);
    });

    // Worktrees and checkout outside every temp dir (HOME is under tmpdir in these tests), so only
    // the temp-dir rules can refuse.
    const outside = {
      worktrees: "/mc-test-nowhere/worktrees",
      checkout: "/mc-test-nowhere/shop-app",
    };

    it("refuses the hub's temp dir, or a folder holding it", () => {
      expect(
        load(crewText({ ...outside, denyRead: ["/mc-test-nowhere/other"] })).crew,
      ).toBeDefined();
      for (const t of [tmpdir(), resolve(tmpdir(), "..")]) {
        expect(fails(crewText({ ...outside, denyRead: [t] })).message).toBe(holds(t));
      }
    });

    it("refuses /tmp, where sandboxed commands keep their temp files, under either name", () => {
      // On macOS /tmp is /private/tmp, so all three name it; elsewhere only /tmp does.
      const names = process.platform === "darwin" ? ["/tmp", "/private/tmp", "/private"] : ["/tmp"];
      for (const t of names) {
        expect(fails(crewText({ ...outside, denyRead: [t] })).message).toBe(holds(t));
      }
    });

    it("refuses a relative path", () => {
      const e = fails(crewText({ denyRead: ["Work"] }));
      expect(e.path).toBe("crew.deny_read");
      expect(e.message).toBe("crew.deny_read: Work is not an absolute path");
    });
  });

  it("configView carries the crew with each seat's mode, or null without one", () => {
    const v = configView(loadConfig(EXAMPLE)).crew;
    expect(v?.worktrees).toBe(join(homedir(), "code/mc-crew/worktrees"));
    expect(v?.sessions[0]?.seats.map((x) => [x.id, x.role, x.mode, x.model])).toEqual([
      ["guido-1", "GUIDO", "writer", "sonnet"],
      ["inco-1", "INCO", "writer", "sonnet"],
      ["retro-1", "RETRO", "read-only", "opus"],
    ]);
    expect(v?.sessions[0]?.seats[0]?.area).toEqual(["apps/server/**", "packages/core/**"]);
    expect(configView(load(withoutCrew)).crew).toBeNull();
  });
});

describe("preview servers and crew", () => {
  it("a preview is any port but 7420, or MC_NO_LOOP_WRITES=1", () => {
    expect(isPreview(DEFAULT_PORT, {})).toBe(false);
    expect(isPreview(7431, {})).toBe(true);
    expect(isPreview(DEFAULT_PORT, { MC_NO_LOOP_WRITES: "1" })).toBe(true);
    expect(isPreview(DEFAULT_PORT, { MC_NO_LOOP_WRITES: "0" })).toBe(false);
  });

  it("the live hub runs crew unless MC_NO_CREW=1; a preview only with MC_CREW=1", () => {
    expect(crewAllowed(false, {})).toBe(true);
    expect(crewAllowed(false, { MC_NO_CREW: "1" })).toBe(false);
    expect(crewAllowed(true, {})).toBe(false);
    expect(crewAllowed(true, { MC_CREW: "1" })).toBe(true);
    expect(crewAllowed(true, { MC_CREW: "1", MC_NO_CREW: "1" })).toBe(false);
    expect(crewAllowed(true, { MC_CREW: "yes" })).toBe(false);
  });
});

describe("guard config", () => {
  const text = readFileSync(EXAMPLE, "utf8");
  const FULL_SUITE_BLOCK =
    "full_suite:\n      - pnpm -s test\n      - pnpm -s vitest run\n      - pnpm -s vitest";
  expect(text).toContain(FULL_SUITE_BLOCK);
  const parse = (t: string) =>
    parseConfig(t, "test", { hubRoot: mkdtempSync(join(tmpdir(), "mc-hub-")) });

  it("loads the example's full_suite, and [] for a repo without one", () => {
    const c = loadConfig(EXAMPLE);
    expect(c.repos.map((r) => r.fullSuite)).toEqual([
      [],
      [],
      ["pnpm -s test", "pnpm -s vitest run", "pnpm -s vitest"],
    ]);
  });

  it.skipIf(!existsSync(DEFAULT_CREW_NODE))(
    "defaults crew.node to the stable Homebrew path",
    () => {
      const c = parseConfig(readFileSync(EXAMPLE_SOURCE, "utf8"), "example");
      expect(c.crew?.node).toBe("/opt/homebrew/bin/node");
    },
  );

  it("reads an explicit crew.node", () => {
    expect(loadConfig(EXAMPLE).crew?.node).toBe(process.execPath);
  });

  it("accepts a full_suite entry equal to, or a word-extension of, an allowed prefix", () => {
    const t = text.replace(
      FULL_SUITE_BLOCK,
      'full_suite: ["pnpm -s test", "pnpm -s vitest", "pnpm -s vitest run --coverage"]',
    );
    expect(parse(t).repos[2]?.fullSuite).toEqual([
      "pnpm -s test",
      "pnpm -s vitest",
      "pnpm -s vitest run --coverage",
    ]);
  });

  it.each(["rm -rf /", "pnpm -s tests", "pnpm test", "git push"])(
    "refuses full_suite entry %j that crew seats may not run",
    (cmd) => {
      const t = text.replace(FULL_SUITE_BLOCK, `full_suite: [${JSON.stringify(cmd)}]`);
      const e = errorOf(() => parse(t));
      expect(e.path).toBe("repos[2].full_suite");
      expect(e.message).toBe(`repos[2].full_suite: ${cmd} is not a command crew seats may run`);
    },
  );

  it.each([
    ["v22.5.1", "is Node 22.5.1; 22.6 or later is needed"],
    ["v18.20.4", "is Node 18.20.4; 22.6 or later is needed"],
    ["not node", "did not report a Node version"],
  ])(
    "turns crew off with a note for a crew.node reporting %s (no type stripping)",
    (version, message) => {
      const dir = mkdtempSync(join(tmpdir(), "mc-node-"));
      const fake = join(dir, "node");
      writeFileSync(fake, `#!/bin/sh\necho "${version}"\n`, { mode: 0o755 });
      // a fault of the machine, not the file: the config loads, loops and all (m13)
      const c = parse(text.replace(`node: ${process.execPath}`, `node: ${fake}`));
      expect(c.crew?.nodeNote).toBe(`crew.node: ${fake} ${message}`);
      expect(c.loops.length).toBeGreaterThan(0);
      rmSync(dir, { recursive: true, force: true });
    },
  );

  it.each(["v22.6.0", "v23.1.0"])("accepts a crew.node reporting %s", (version) => {
    const dir = mkdtempSync(join(tmpdir(), "mc-node-"));
    const fake = join(dir, "node");
    writeFileSync(fake, `#!/bin/sh\necho "${version}"\n`, { mode: 0o755 });
    const c = parse(text.replace(`node: ${process.execPath}`, `node: ${fake}`));
    expect(c.crew?.node).toBe(fake);
    expect(c.crew?.nodeNote).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it("turns crew off with a note for a crew.node that is missing, a directory, or not executable", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-node-"));
    const plain = join(dir, "node");
    writeFileSync(plain, "#!/bin/sh\n", { mode: 0o644 });
    for (const bad of [join(dir, "absent"), dir, plain]) {
      const c = parse(text.replace(`node: ${process.execPath}`, `node: ${bad}`));
      expect(c.crew?.nodeNote).toBe(`crew.node: ${bad} is not an executable file`);
      expect(c.loops.length).toBeGreaterThan(0);
    }
  });
});

describe("repo commands and protected files", () => {
  const text = readFileSync(EXAMPLE, "utf8");
  const parse = (t: string) =>
    parseConfig(t, "test", { hubRoot: mkdtempSync(join(tmpdir(), "mc-hub-")) });
  const AT = "    github: octo-org/shop-app\n";
  expect(text).toContain(AT);
  const withRepo0 = (l: string) => text.replace(AT, AT + l);
  const PROTECTED = [
    "pyproject.toml",
    "uv.lock",
    "uv.toml",
    "conftest.py",
    "setup.cfg",
    "ruff.toml",
    "justfile",
    ".pre-commit-config.yaml",
  ];
  const EXAMPLE_KEYS = [
    '    full_suite: ["uv run pytest"]\n',
    "    commands:\n",
    '      writer: ["uv run pytest", "uv run ruff check", "uv run mypy"]\n',
    '      review: ["uv run pytest"]\n',
    `    protected: ${JSON.stringify(PROTECTED)}\n`,
  ].join("");
  const writer = (c: string) =>
    withRepo0(`    commands:\n      writer: [${JSON.stringify(c)}]\n      review: []\n`);

  it("a repo with neither key loads with the default commands and no extra protected files", () => {
    const r = parse(text).repos[0];
    expect(r?.commands).toEqual(DEFAULT_SEAT_COMMANDS);
    expect(r?.protectedFiles).toEqual([]);
  });

  it("loads the ticket's example", () => {
    expect(parse(withRepo0(EXAMPLE_KEYS)).repos[0]).toMatchObject({
      fullSuite: ["uv run pytest"],
      commands: {
        writer: ["uv run pytest", "uv run ruff check", "uv run mypy"],
        review: ["uv run pytest"],
      },
      protectedFiles: PROTECTED,
    });
  });

  const PLAIN =
    "must be plain words (letters, digits and . _ / = + , @ -) separated by single spaces";
  it.each([
    ["uv run", "ends at run, which runs whatever follows it"],
    ["npx", "ends at npx, which runs whatever follows it"],
    ["pnpm exec", "ends at exec, which runs whatever follows it"],
    ["python", "ends at python, which runs whatever follows it"],
    ["bash", "ends at bash, which runs whatever follows it"],
    ["just", "ends at just, which runs whatever follows it"],
    ["uv run pytest; git push", PLAIN],
    ["pytest $X", PLAIN],
    ["./run-tests", "must start with a program name, not a path"],
    ["git status", "runs git, which seats may never run"],
  ])("refuses seat command %j", (cmd, why) => {
    const e = errorOf(() => parse(writer(cmd)));
    expect(e.path).toBe("repos[0].commands.writer[0]");
    expect(e.message).toBe(`repos[0].commands.writer[0]: "${cmd}" ${why}`);
  });

  it.each([
    ["pnpm -s", "names no tool after pnpm"],
    ["pnpm -s exec y", "runs exec, which runs whatever follows it"],
    ["pnpm dlx y", "runs dlx, which runs whatever follows it"],
    ["npm exec y", "runs exec, which runs whatever follows it"],
    ["GIT -C .", "runs git, which seats may never run"],
    ["SH", "ends at sh, which runs whatever follows it"],
    ["Bash", "ends at bash, which runs whatever follows it"],
    ["sh x.sh", "runs sh, which seats may never run"],
    ["node -e y", "has -e, which runs code given on the command line"],
    ["node x.js", "runs node, which seats may never run"],
    ["python3 -c y", "has -c, which runs code given on the command line"],
    ["python3 x.py", "runs python3 without -m <module>, which runs arbitrary code"],
    ["uv run python x.py", "runs python without -m <module>, which runs arbitrary code"],
    ["uv run bash y", "runs bash, which seats may never run"],
    ["pytest -p y", "has -p, which runs code given on the command line"],
    ["tool --eval y", "has --eval, which runs code given on the command line"],
    ["osascript", "ends at"],
    ["osascript y", "runs osascript, which seats may never run"],
    ["ssh h", "runs ssh, which seats may never run"],
    ["find y", "runs find, which seats may never run"],
    ["env X=1 pytest", "runs env, which seats may never run"],
  ])("refuses the shell, interpreter, launcher or package-manager entry %j", (cmd, why) => {
    const e = errorOf(() => parse(writer(cmd)));
    expect(e.path).toBe("repos[0].commands.writer[0]");
    expect(e.message).toContain(why === "ends at" ? "osascript" : why);
  });

  it.each(["uv run python -m pytest", "python3 -m pytest", "pnpm -s vitest", "uv run ruff check"])(
    "loads seat command %j",
    (cmd) => {
      expect(parse(writer(cmd)).repos[0]?.commands?.writer).toEqual([cmd]);
    },
  );

  it.each([
    ["just test", ["justfile"], ".justfile"],
    ["make test", ["Makefile"], "GNUmakefile"],
    ["tox", ["tox.ini"], null],
    ["nox", [], "noxfile.py"],
    ["task test", ["Taskfile.yml"], "Taskfile.yaml"],
  ])("a task runner entry %j needs its recipe files protected (M1)", (cmd, prot, missing) => {
    const t = withRepo0(
      `    commands:\n      writer: [${JSON.stringify(cmd)}]\n      review: []\n    protected: ${JSON.stringify(prot)}\n`,
    );
    if (missing === null) {
      expect(parse(t).repos[0]?.commands?.writer).toEqual([cmd]);
      return;
    }
    const e = errorOf(() => parse(t));
    expect(e.path).toBe("repos[0].commands.writer[0]");
    expect(e.message).toContain(`runs recipes from ${missing}, which must be listed in protected`);
  });

  it("loads a task runner entry once every recipe file is protected (M1)", () => {
    const t = withRepo0(
      '    commands:\n      writer: ["just test"]\n      review: []\n    protected: ["justfile", "Justfile", ".justfile"]\n',
    );
    expect(parse(t).repos[0]?.commands?.writer).toEqual(["just test"]);
  });

  it("refuses a full_suite entry that extends a writer command (M3)", () => {
    const t = withRepo0(
      '    full_suite: ["uv run pytest -x"]\n    commands:\n      writer: ["uv run pytest"]\n      review: []\n',
    );
    const e = errorOf(() => parse(t));
    expect(e.path).toBe("repos[0].full_suite");
    expect(e.message).toContain('"uv run pytest -x" extends the writer command "uv run pytest"');
  });

  it("loads a full_suite entry that extends a writer command also listed in full_suite (M3)", () => {
    const t = withRepo0(
      '    full_suite: ["uv run pytest -x", "uv run pytest"]\n    commands:\n      writer: ["uv run pytest"]\n      review: []\n',
    );
    expect(parse(t).repos[0]?.fullSuite).toEqual(["uv run pytest -x", "uv run pytest"]);
  });

  it("checks the default writer list too: pnpm -s vitest run alone leaves pnpm -s vitest unlocked (M3)", () => {
    const e = errorOf(() => parse(withRepo0('    full_suite: ["pnpm -s vitest run"]\n')));
    expect(e.path).toBe("repos[0].full_suite");
    expect(e.message).toContain('"pnpm -s vitest run" extends the writer command "pnpm -s vitest"');
    expect(
      parse(withRepo0('    full_suite: ["pnpm -s vitest run", "pnpm -s vitest"]\n')).repos[0]
        ?.fullSuite,
    ).toEqual(["pnpm -s vitest run", "pnpm -s vitest"]);
  });

  it.each(["a/", "a//b", "./a", "a/./b", "."])("refuses protected glob shape %j (M2)", (g) => {
    const e = errorOf(() => parse(withRepo0(`    protected: [${JSON.stringify(g)}]\n`)));
    expect(e.path).toBe("repos[0].protected[0]");
  });

  it.each(["uv run ruff check"])("loads seat command %j", (cmd) => {
    expect(parse(writer(cmd)).repos[0]?.commands?.writer).toEqual([cmd]);
  });

  it("refuses commands with only writer", () => {
    const e = errorOf(() => parse(withRepo0('    commands:\n      writer: ["uv run pytest"]\n')));
    expect(e.path).toBe("repos[0].commands.review");
  });

  it("checks full_suite against the repo's own writer commands", () => {
    const e = errorOf(() =>
      parse(
        withRepo0(
          EXAMPLE_KEYS.replace('["uv run pytest"]\n    commands', '["pnpm -s test"]\n    commands'),
        ),
      ),
    );
    expect(e.message).toBe("repos[0].full_suite: pnpm -s test is not a command crew seats may run");
    expect(() => parse(withRepo0(EXAMPLE_KEYS))).not.toThrow();
  });

  it.each(["/etc/x", "../x", "a[b]"])("refuses protected glob %j", (g) => {
    const e = errorOf(() => parse(withRepo0(`    protected: [${JSON.stringify(g)}]\n`)));
    expect(e.path).toBe("repos[0].protected[0]");
  });
});

describe("crewSeatMode", () => {
  it("judges a writer seat as a writer, and any other seat as read-only (fails closed)", () => {
    const seat = (id: string, role: "GUIDO" | "INCO" | "RETRO") => ({
      id,
      role,
      accountId: "claude-main",
      model: "haiku",
      area: [],
    });
    const cfg = {
      crew: {
        worktrees: "/w",
        maxSeats: 8,
        sessions: [
          {
            id: "s",
            repoId: "mc",
            checkout: "/c",
            seats: [seat("guido-1", "GUIDO"), seat("inco-1", "INCO"), seat("retro", "RETRO")],
          },
        ],
      },
    } as unknown as CcConfig;
    expect(crewSeatMode(cfg, "guido-1")).toBe("writer");
    expect(crewSeatMode(cfg, "inco-1")).toBe("writer");
    expect(crewSeatMode(cfg, "retro")).toBe("read-only");
    expect(crewSeatMode(cfg, "nobody")).toBe("read-only");
    expect(crewSeatMode({ ...cfg, crew: undefined }, "guido-1")).toBe("read-only");
  });
});

describe("repo autonomy", () => {
  const text = readFileSync(EXAMPLE, "utf8");
  const withAutonomy = (repo: string, value: string, t = text) =>
    t.replace(`    github: octo-org/${repo}\n`, `$&    autonomy: ${value}\n`);
  const guard = { hubRoot: mkdtempSync(join(tmpdir(), "mc-hub-")) };
  const load = (t: string) => parseConfig(t, "test", guard);

  it("defaults to draft", () => {
    expect(load(text).repos.map((r) => r.autonomy)).toEqual(["draft", "draft", "draft"]);
  });

  it("accepts merge on a repo that has a crew session", () => {
    const c = load(withAutonomy("mission-control", "merge"));
    expect(c.repos.map((r) => r.autonomy)).toEqual(["draft", "draft", "merge"]);
  });

  it("rejects merge on a repo with no crew session, or when there is no crew", () => {
    const e = errorOf(() => load(withAutonomy("shop-app", "merge")));
    expect(e.path).toBe("repos[0].autonomy");
    expect(e.message).toContain("crew session");
    const noCrew = text.slice(0, text.indexOf("\ncrew:"));
    expect(errorOf(() => load(withAutonomy("mission-control", "merge", noCrew))).path).toBe(
      "repos[2].autonomy",
    );
  });

  it("rejects any other value", () => {
    for (const bad of ["auto", "Merge", '""', "true", "yes", "on"]) {
      expect(errorOf(() => load(withAutonomy("mission-control", bad))).path).toBe(
        "repos[2].autonomy",
      );
    }
  });
});
