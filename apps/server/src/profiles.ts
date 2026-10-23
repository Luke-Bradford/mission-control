/**
 * Template profiles from user config: `profiles.yaml` beside the hub's `config.yaml`. The operator
 * may create it; the hub never writes it. With no file the built-ins apply; a file that cannot be
 * loaded refuses starts (a `ProfilesError`) and never stops the hub.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  BUILTIN_PROFILES_SOURCE,
  type ChosenProfile,
  type ConfigView,
  DEFAULT_PROFILES,
  overrideProfile,
  PROFILE_NAME,
  PROFILE_STEP_PHASES,
  type Profile,
  type ProfileOverride,
  REVIEW_DEPTHS,
  ROLE_NAME,
  routeProfile,
  startNoProfilesText,
  unknownProfileText,
} from "@mc/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const PROFILES_FILE = "profiles.yaml";

export class ProfilesError extends Error {}

const CHECKLIST_MAX = 4000;
const LIMIT = z.number().int().min(1).max(10);

const fileProfile = z.strictObject({
  name: z
    .string()
    .regex(PROFILE_NAME, "must be a lowercase name of up to 32 letters, digits and -"),
  labels: z.array(z.string().min(1)).default([]),
  steps: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        phase: z.enum(PROFILE_STEP_PHASES).nullish(),
      }),
    )
    .min(1),
  checklist: z.string().max(CHECKLIST_MAX).default(""),
  plan_required: z.boolean(),
  reviewer: z.strictObject({
    role: z.string().regex(ROLE_NAME, "must be a role name"),
    depth: z.enum(REVIEW_DEPTHS),
  }),
  checks: z.array(z.string().min(1)).default([]),
  tries: LIMIT,
  rounds: LIMIT,
});

const toProfile = (f: z.infer<typeof fileProfile>): Profile => ({
  name: f.name,
  labels: f.labels,
  steps: f.steps.map((s) => ({ name: s.name, phase: s.phase ?? null })),
  checklist: f.checklist,
  planRequired: f.plan_required,
  reviewer: { role: f.reviewer.role, depth: f.reviewer.depth },
  checks: f.checks,
  tries: f.tries,
  rounds: f.rounds,
});

const FALLBACKS: [string, string][] = [
  ["small-change", "Size XS or S with no template label needs it"],
  ["feature", "Size M or larger, or no Size, with no template label needs it"],
];

/**
 * The profiles in the file at `path`, read now (never cached). No file: the built-ins. A file
 * that cannot be read, parsed or checked: the `ProfilesError` that says why.
 */
export function loadProfiles(path: string): readonly Profile[] | ProfilesError {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_PROFILES;
    return new ProfilesError(`cannot read ${path}: ${(e as Error).message}`);
  }
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    return new ProfilesError(`${path}: ${(e as Error).message}`);
  }
  const list = (doc as { profiles?: unknown } | null)?.profiles;
  if (typeof doc !== "object" || doc === null || Array.isArray(doc) || !Array.isArray(list)) {
    return new ProfilesError("the file must be a mapping with a profiles list");
  }
  const parsed = z.array(fileProfile).safeParse(list);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    const at = ["profiles", ...(i?.path ?? [])].join(".");
    return new ProfilesError(`${at}: ${i?.message ?? "invalid"}`);
  }
  const ps = parsed.data.map(toProfile);
  const seen = new Set<string>();
  for (const p of ps) {
    if (seen.has(p.name)) return new ProfilesError(`profiles: the name "${p.name}" is used twice`);
    seen.add(p.name);
  }
  for (const [name, why] of FALLBACKS) {
    if (!seen.has(name)) return new ProfilesError(`profiles: no profile named "${name}" (${why})`);
  }
  return ps;
}

/**
 * The profiles as `/api/config` shows them, read now. A file that cannot be loaded gives its error
 * and no profiles; the hub still answers.
 */
export function profilesView(path: string): NonNullable<ConfigView["profiles"]> {
  const ps = loadProfiles(path);
  if (ps instanceof ProfilesError) return { source: path, error: ps.message, list: [] };
  return {
    source: ps === DEFAULT_PROFILES ? BUILTIN_PROFILES_SOURCE : path,
    error: null,
    list: ps.map((p) => ({
      name: p.name,
      labels: [...p.labels],
      steps: p.steps.map((s) => ({ name: s.name, phase: s.phase })),
      planRequired: p.planRequired,
      reviewer: { role: p.reviewer.role, depth: p.reviewer.depth },
      tries: p.tries,
      rounds: p.rounds,
    })),
  };
}

/** sha256 hex of the profile as JSON, keys in `Profile` order. */
export function profileHash(p: Profile): string {
  const ordered: Profile = {
    name: p.name,
    labels: p.labels,
    steps: p.steps.map((s) => ({ name: s.name, phase: s.phase })),
    checklist: p.checklist,
    planRequired: p.planRequired,
    reviewer: { role: p.reviewer.role, depth: p.reviewer.depth },
    checks: p.checks,
    tries: p.tries,
    rounds: p.rounds,
  };
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

/**
 * The profile a run starts with: routed by label then Size, or the override's. A refusal is the
 * text a start answers with.
 */
export function chooseRunProfile(
  ps: readonly Profile[] | ProfilesError,
  labels: readonly string[],
  size: string | null,
  override: ProfileOverride | null,
): ChosenProfile | { refusal: string } {
  if (ps instanceof ProfilesError) return { refusal: startNoProfilesText(ps.message) };
  const routed = routeProfile(ps, labels, size);
  if (override === null) return routed;
  return (
    overrideProfile(ps, routed, override) ?? {
      refusal: unknownProfileText(
        override.profile,
        ps.map((p) => p.name),
      ),
    }
  );
}
