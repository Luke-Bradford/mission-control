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
