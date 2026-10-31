import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROFILES, type Profile } from "@mc/core";
import { describe, expect, it } from "vitest";
import { chooseRunProfile, loadProfiles, ProfilesError, profileHash } from "../src/profiles.ts";

const dir = mkdtempSync(join(tmpdir(), "mc-profiles-"));
let n = 0;
function file(text: string): string {
  const p = join(dir, `profiles-${n++}.yaml`);
  writeFileSync(p, text);
  return p;
}

const entry = (name: string, extra = ""): string => `
  - name: ${name}
    steps: [{ name: do, phase: working }]
    plan_required: false
    reviewer: { role: RETRO, depth: light }
    tries: 2
    rounds: 2${extra}`;
const two = `profiles:${entry("small-change")}${entry("feature")}\n`;

describe("loadProfiles", () => {
  it("loads legacy steps beyond creation limits and preserves routing and execution", async () => {
    const steps = Array.from({ length: 31 }, (_, i) => ({
      name: `${i}-${"x".repeat(101)}`,
      phase: i === 0 ? "working" : null,
    }));
    const text = two.replace("[{ name: do, phase: working }]", JSON.stringify(steps));
    const path = file(text);
    const ps = loadProfiles(path);
    expect(ps).not.toBeInstanceOf(ProfilesError);
    expect(chooseRunProfile(ps, [], "S", null)).toMatchObject({
      profile: { name: "small-change", steps, tries: 2, rounds: 2, planRequired: false },
    });
    const { createProfile, profilesVersion } = await import("../src/profiles.ts");
    await createProfile(
      path,
      {
        name: "custom",
        steps: [{ name: "implement", phase: "working" }],
        plan_required: false,
        reviewer: { role: "RETRO", depth: "light" },
        tries: 2,
        rounds: 2,
      },
      profilesVersion(ps as Profile[]),
      1,
    );
    expect((loadProfiles(path) as Profile[]).slice(0, 2)).toEqual(ps);
  });

  it("a missing file gives the defaults", () => {
    expect(loadProfiles(join(dir, "none.yaml"))).toEqual(DEFAULT_PROFILES);
  });

  it("reads a file, in order, with defaults for the optional fields", () => {
    const ps = loadProfiles(file(two));
    expect(ps).not.toBeInstanceOf(ProfilesError);
    expect((ps as Profile[]).map((p) => p.name)).toEqual(["small-change", "feature"]);
    expect((ps as Profile[])[0]).toEqual({
      name: "small-change",
      labels: [],
      steps: [{ name: "do", phase: "working" }],
      checklist: "",
      planRequired: false,
      reviewer: { role: "RETRO", depth: "light" },
      checks: [],
      tries: 2,
      rounds: 2,
    });
  });

  const refused = (text: string, message: string | RegExp): void => {
    const r = loadProfiles(file(text));
    expect(r).toBeInstanceOf(ProfilesError);
    expect((r as ProfilesError).message).toMatch(message);
  };

  it("refuses a file that is not a mapping with a profiles list", () => {
    refused("- a\n", "the file must be a mapping with a profiles list");
    refused("profiles: 3\n", "the file must be a mapping with a profiles list");
  });

  it("refuses an invalid profile with its path", () => {
    refused(
      `profiles:${entry("feature", "\n    nope: 1")}${entry("small-change")}\n`,
      /^profiles\.0: /,
    );
    refused(`profiles:${entry("Bad Name")}\n`, /^profiles\.0\.name: /);
    refused(
      `profiles:${entry("feature").replace("tries: 2", "tries: 11")}${entry("small-change")}\n`,
      /^profiles\.0\.tries: /,
    );
  });

  it("refuses a name used twice", () => {
    refused(
      `profiles:${entry("feature")}${entry("feature")}\n`,
      'profiles: the name "feature" is used twice',
    );
  });

  it("refuses a file without the two size fallbacks", () => {
    refused(
      `profiles:${entry("feature")}\n`,
      'profiles: no profile named "small-change" (Size XS or S with no template label needs it)',
    );
    refused(
      `profiles:${entry("small-change")}\n`,
      'profiles: no profile named "feature" (Size M or larger, or no Size, with no template label needs it)',
    );
  });

  it("refuses a file it cannot parse, naming the path", () => {
    const p = file("profiles: [\n");
    const r = loadProfiles(p);
    expect(r).toBeInstanceOf(ProfilesError);
    expect((r as ProfilesError).message.startsWith(`${p}: `)).toBe(true);
  });

  it("refuses a path it cannot read", () => {
    const r = loadProfiles(dir);
    expect(r).toBeInstanceOf(ProfilesError);
    expect((r as ProfilesError).message.startsWith(`cannot read ${dir}: `)).toBe(true);
  });
});

describe("profileHash", () => {
  it("changes with the profile and not with the object's key order", () => {
    const f = DEFAULT_PROFILES[0] as Profile;
    expect(profileHash(f)).toMatch(/^[0-9a-f]{64}$/);
    expect(profileHash({ ...f, tries: 5 })).not.toBe(profileHash(f));
    const { name, ...rest } = f;
    expect(profileHash({ ...rest, name } as Profile)).toBe(profileHash(f));
  });
});

describe("chooseRunProfile", () => {
  it("routes, overrides, and refuses", () => {
    const routed = chooseRunProfile(DEFAULT_PROFILES, ["bug"], "M", null);
    expect(routed).toMatchObject({ profile: { name: "bugfix" } });
    const o = chooseRunProfile(DEFAULT_PROFILES, ["bug"], "M", {
      profile: "small-change",
      reason: "tiny",
      by: "FLIGHT",
    });
    expect(o).toMatchObject({ route: { by: "override", from: "bugfix", reason: "tiny" } });
    const unknown = chooseRunProfile(DEFAULT_PROFILES, [], "M", {
      profile: "zzz",
      reason: "r",
      by: "planner",
    });
    expect(unknown).toEqual({
      refusal: `Not started: no template profile is named "zzz"; the profiles are ${DEFAULT_PROFILES.map((p) => p.name).join(", ")}.`,
    });
    expect(chooseRunProfile(new ProfilesError("bad"), [], "M", null)).toEqual({
      refusal: "Not started: the template profiles in user config could not be read (bad).",
    });
  });
});

describe("template descriptions", () => {
  it("exposes seven templates without routing orchestration into a build", () => {
    expect(DEFAULT_PROFILES).toHaveLength(7);
    expect(DEFAULT_PROFILES.find((p) => p.name === "watch")).toMatchObject({
      orchestrationOnly: true,
      rounds: 0,
      budget: null,
    });
    expect(
      chooseRunProfile(DEFAULT_PROFILES, [], "M", {
        profile: "watch",
        reason: "monitor",
        by: "FLIGHT",
      }),
    ).toHaveProperty("refusal");
    const feature = DEFAULT_PROFILES[0] as Profile;
    expect(feature.steps.map((s) => s.name)).toEqual([
      "implement",
      "draft PR",
      "verify",
      "review",
      "merge",
    ]);
    expect(feature.steps.find((s) => s.name === "verify")).toMatchObject({
      max: 3,
      role: "Mission Control runs it",
      checks: expect.any(Array),
    });
  });

  it("loads typed metadata, hashes it, and rejects unknown check kinds and fields", () => {
    const metadata = "\n    budget: 120000\n    budget_usd: 12.5\n    trigger: label custom";
    const text = two.replace(
      "steps: [{ name: do, phase: working }]",
      "steps: [{ name: do, phase: working, gate: true, max: 2, retry: again, role: GUIDO, checks: [{kind: gate, text: approval}] }]",
    );
    const ps = loadProfiles(file(text + metadata));
    expect(ps).not.toBeInstanceOf(ProfilesError);
    const p = (ps as Profile[])[0] as Profile;
    expect(p.steps[0]).toMatchObject({
      gate: true,
      max: 2,
      checks: [{ kind: "gate", text: "approval" }],
    });
    expect((ps as Profile[]).at(-1)?.budgetUsd).toBe(12.5);
    expect(profileHash(p)).not.toBe(
      profileHash({ ...p, steps: [{ name: "do", phase: "working" }] }),
    );
    expect(loadProfiles(file(text.replace("kind: gate", "kind: shell")))).toBeInstanceOf(
      ProfilesError,
    );
    expect(loadProfiles(file(text.replace("retry: again", "unknown: again")))).toBeInstanceOf(
      ProfilesError,
    );
  });
});

describe("profile creation", () => {
  const input = {
    name: "custom",
    labels: ["type:custom"],
    steps: [
      {
        name: "implement",
        phase: "working",
        checks: [
          { kind: "cmd", text: "Scoped tests pass" },
          { kind: "rule", text: "Area checked" },
          { kind: "review", text: "Fresh reviewer" },
          { kind: "gate", text: "Approval" },
          { kind: "agent", text: "Evidence" },
        ],
        gate: true,
        max: 2,
      },
    ],
    plan_required: false,
    reviewer: { role: "RETRO", depth: "light" },
    tries: 2,
    rounds: 2,
    budget: 100000,
  };
  it("enforces step count and name limits on creation", async () => {
    const { createProfile, NewProfileBody, profilesVersion } = await import("../src/profiles.ts");
    const path = file(two);
    const base = profilesVersion(loadProfiles(path) as Profile[]);
    for (const steps of [
      Array.from({ length: 31 }, (_, i) => ({ name: `step-${i}`, phase: "working" })),
      [{ name: "x".repeat(101), phase: "working" }],
    ]) {
      const profile = { ...input, steps };
      expect(NewProfileBody.safeParse({ base, profile }).success).toBe(false);
      await expect(createProfile(path, profile, base, 1)).rejects.toThrow(/Too big/);
    }
    expect(loadProfiles(path)).toEqual(loadProfiles(file(two)));
  });

  it("creates and reloads, preserving fallbacks and a started snapshot", async () => {
    const { createProfile, profilesVersion } = await import("../src/profiles.ts");
    const path = join(dir, `new-${n++}.yaml`);
    const snapshot = structuredClone(DEFAULT_PROFILES[0] as Profile);
    const hash = profileHash(snapshot);
    await createProfile(path, input, profilesVersion(loadProfiles(path) as Profile[]), 1);
    const ps = loadProfiles(path) as Profile[];
    expect(ps.map((p) => p.name)).toContain("custom");
    expect(ps.slice(0, 7)).toEqual(DEFAULT_PROFILES);
    expect(ps[7]?.steps[0]?.checks).toHaveLength(5);
    expect(profileHash(snapshot)).toBe(hash);
    expect(snapshot).toEqual(DEFAULT_PROFILES[0]);
  });
  it("refuses duplicate, invalid graph, unknown execution and stale writes without changing the file", async () => {
    const { createProfile, profilesVersion } = await import("../src/profiles.ts");
    const path = file(two);
    const { readFileSync } = await import("node:fs");
    const before = readFileSync(path, "utf8");
    const base = profilesVersion(loadProfiles(path) as Profile[]);
    for (const profile of [
      { ...input, name: "feature" },
      { ...input, steps: [{ name: "work", phase: "shell" }] },
      { ...input, steps: [{ name: "split", phase: null }] },
      {
        ...input,
        steps: [
          { name: "a", phase: "review" },
          { name: "b", phase: "working" },
        ],
      },
      { ...input, rounds: 0 },
      { ...input, orchestration_only: true },
    ]) {
      await expect(createProfile(path, profile, base, 1)).rejects.toThrow();
      expect(readFileSync(path, "utf8")).toBe(before);
    }
    await expect(createProfile(path, input, "stale", 1)).rejects.toThrow(/changed/);
    expect(readFileSync(path, "utf8")).toBe(before);
    const outcomes = await Promise.allSettled([
      createProfile(path, input, base, 1),
      createProfile(path, { ...input, name: "other" }, base, 1),
    ]);
    expect(outcomes.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((loadProfiles(path) as Profile[]).map((p) => p.name)).toEqual([
      "small-change",
      "feature",
      "custom",
    ]);
  });
});

it("exposes multiple current occupants of the same step", async () => {
  const { profilesView } = await import("../src/profiles.ts");
  const view = profilesView(join(dir, "absent.yaml"), [
    { id: "guido-1", loop: { profile: "feature", step: "verify" } },
    { id: "guido-2", loop: { profile: "feature", step: "verify" } },
    { id: "guido-3", loop: { profile: "bugfix", step: "verify" } },
  ]);
  expect(view.list[0]?.steps.find((s) => s.name === "verify")?.agents).toEqual([
    "guido-1",
    "guido-2",
  ]);
});

it("matches the catalogue descriptions, with the folded developer path corrections", async () => {
  const { default: golden } = await import("./template-catalogue.json");
  for (const p of DEFAULT_PROFILES) {
    const t = golden[p.name as keyof typeof golden];
    expect(p.trigger).toBe(t.trigger);
    expect(p.rounds).toBe(t.rounds);
    expect(p.budget).toBe(t.budget === "—" ? null : Number.parseInt(t.budget, 10) * 1000);
    for (const node of t.nodes) {
      if (p.name === "feature" && ["plan", "go/no-go"].includes(node.id)) continue;
      expect(p.nodes?.find((s) => s.name === node.id)).toMatchObject({
        name: node.id,
        role: node.role,
        checks: node.checks.map(([kind, text]) => ({ kind, text })),
        ...("gate" in node ? { gate: node.gate } : {}),
        ...("max" in node ? { max: node.max } : {}),
        ...(node.id in t.rules ? { retry: (t.rules as Record<string, string>)[node.id] } : {}),
      });
    }
  }
});

it("keeps the original profiles when atomic replacement fails and refuses symbolic links", async () => {
  const { createProfile, profilesVersion } = await import("../src/profiles.ts");
  const { mkdirSync, readFileSync, symlinkSync } = await import("node:fs");
  const path = file(two);
  const before = readFileSync(path, "utf8");
  const input = {
    name: "custom",
    steps: [{ name: "implement", phase: "working" }],
    plan_required: false,
    reviewer: { role: "RETRO", depth: "light" },
    tries: 2,
    rounds: 2,
  };
  const temp = `${path}.tmp-${process.pid}`;
  mkdirSync(temp);
  writeFileSync(join(temp, "occupied"), "fixture");
  await expect(
    createProfile(path, input, profilesVersion(loadProfiles(path) as Profile[]), 1),
  ).rejects.toThrow();
  expect(readFileSync(path, "utf8")).toBe(before);
  const link = join(dir, `link-${n++}.yaml`);
  symlinkSync(path, link);
  await expect(
    createProfile(link, input, profilesVersion(loadProfiles(path) as Profile[]), 1),
  ).rejects.toThrow(/symbolic link/);
  expect(readFileSync(path, "utf8")).toBe(before);
});
