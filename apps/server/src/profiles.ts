/**
 * Template profiles from user config: `profiles.yaml` beside the hub's `config.yaml`. The operator
 * may create it through Setup. With no file the built-ins apply; a file that cannot be
 * loaded refuses starts (a `ProfilesError`) and never stops the hub.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  BUILTIN_PROFILES_SOURCE,
  type ChosenProfile,
  type ConfigView,
  DEFAULT_PROFILES,
  overrideProfile,
  PROFILE_CHECK_KINDS,
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
import { parseDocument, parse as parseYaml, stringify } from "yaml";
import { z } from "zod";

import { backUp, ConfigWriteError, pruneBackups, replace } from "./config-write.ts";

export const PROFILES_FILE = "profiles.yaml";

export class ProfilesError extends Error {}

const CHECKLIST_MAX = 4000;
const LIMIT = z.number().int().min(1).max(10);

const fileStep = z.strictObject({
  name: z.string().min(1),
  phase: z.enum(PROFILE_STEP_PHASES).nullish(),
  role: z.string().min(1).max(300).optional(),
  gate: z.boolean().optional(),
  max: LIMIT.optional(),
  retry: z.string().min(1).max(500).optional(),
  checks: z
    .array(z.strictObject({ kind: z.enum(PROFILE_CHECK_KINDS), text: z.string().min(1).max(1000) }))
    .max(30)
    .optional(),
});

export const fileProfile = z
  .strictObject({
    trigger: z.string().min(1).max(300).optional(),
    budget: z.number().int().positive().nullable().optional(),
    budget_usd: z.number().positive().nullable().optional(),
    orchestration_only: z.boolean().optional(),
    nodes: z.array(fileStep).min(1).max(30).optional(),
    name: z
      .string()
      .regex(PROFILE_NAME, "must be a lowercase name of up to 32 letters, digits and -"),
    labels: z.array(z.string().min(1)).default([]),
    steps: z.array(fileStep).min(1),
    checklist: z.string().max(CHECKLIST_MAX).default(""),
    plan_required: z.boolean(),
    reviewer: z.strictObject({
      role: z.string().regex(ROLE_NAME, "must be a role name"),
      depth: z.enum(REVIEW_DEPTHS),
    }),
    checks: z.array(z.string().min(1)).default([]),
    tries: LIMIT,
    rounds: z.number().int().min(0).max(10),
  })
  .superRefine((p, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (p.rounds === 0 && !(p.name === "watch" && p.orchestration_only))
      fail("only watch may have unlimited rounds");
    if (p.orchestration_only && p.steps.some((s) => s.phase != null))
      fail("orchestration-only templates cannot have execution phases");
  });

const toProfile = (f: z.infer<typeof fileProfile>): Profile => ({
  name: f.name,
  labels: f.labels,
  steps: f.steps.map((s) => ({ ...s, phase: s.phase ?? null })),
  ...(f.trigger === undefined ? {} : { trigger: f.trigger }),
  ...(f.budget === undefined ? {} : { budget: f.budget }),
  ...(f.budget_usd === undefined ? {} : { budgetUsd: f.budget_usd }),
  ...(f.orchestration_only === undefined ? {} : { orchestrationOnly: f.orchestration_only }),
  ...(f.nodes === undefined
    ? {}
    : { nodes: f.nodes.map((s) => ({ ...s, phase: s.phase ?? null })) }),
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
    if (!ps.some((p) => p.name === name && !p.orchestrationOnly))
      return new ProfilesError(`profiles: no profile named "${name}" (${why})`);
  }
  return ps;
}

/**
 * The profiles as `/api/config` shows them, read now. A file that cannot be loaded gives its error
 * and no profiles; the hub still answers.
 */
export function profilesView(
  path: string,
  occupants?: readonly { id: string; loop: { profile?: string; step?: string | null } | null }[],
): NonNullable<ConfigView["profiles"]> {
  const ps = loadProfiles(path);
  if (ps instanceof ProfilesError) return { source: path, error: ps.message, list: [] };
  return {
    source: ps === DEFAULT_PROFILES ? BUILTIN_PROFILES_SOURCE : path,
    error: null,
    version: profilesVersion(ps),
    list: ps.map((p) => ({
      name: p.name,
      labels: [...p.labels],
      steps: p.steps.map((s) => ({
        ...s,
        ...(occupants === undefined
          ? {}
          : {
              agents: [
                ...new Set(
                  occupants
                    .filter((a) => a.loop?.profile === p.name && a.loop.step === s.name)
                    .map((a) => a.id),
                ),
              ],
            }),
      })),
      trigger: p.trigger,
      budget: p.budget,
      budgetUsd: p.budgetUsd,
      orchestrationOnly: p.orchestrationOnly,
      nodes: p.nodes,
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
    steps: p.steps.map((s) => ({
      name: s.name,
      phase: s.phase,
      role: s.role,
      checks: s.checks?.map((c) => ({ kind: c.kind, text: c.text })),
      gate: s.gate,
      retry: s.retry,
      max: s.max,
    })),
    trigger: p.trigger,
    budget: p.budget,
    budgetUsd: p.budgetUsd,
    orchestrationOnly: p.orchestrationOnly,
    nodes: p.nodes?.map((s) => ({
      name: s.name,
      phase: s.phase,
      role: s.role,
      checks: s.checks?.map((c) => ({ kind: c.kind, text: c.text })),
      gate: s.gate,
      retry: s.retry,
      max: s.max,
    })),
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

/** Revision Setup sends back, so a stale editor never overwrites a newer definition. */
export function profilesVersion(ps: readonly Profile[]): string {
  return createHash("sha256").update(ps.map(profileHash).join("\n")).digest("hex");
}

const fileValue = (p: Profile) => ({
  name: p.name,
  labels: p.labels,
  steps: p.steps,
  checklist: p.checklist,
  plan_required: p.planRequired,
  reviewer: p.reviewer,
  checks: p.checks,
  tries: p.tries,
  rounds: p.rounds,
  trigger: p.trigger,
  budget: p.budget,
  budget_usd: p.budgetUsd,
  orchestration_only: p.orchestrationOnly,
  nodes: p.nodes,
});

// Creation limits must not prevent previously valid profiles from loading or being preserved.
const newStep = fileStep.extend({ name: z.string().min(1).max(100) });
const newProfile = fileProfile.safeExtend({
  steps: z.array(newStep).min(1).max(30),
  nodes: z.array(newStep).min(1).max(30).optional(),
});

export const NewProfileBody = z.strictObject({
  base: z.string().regex(/^[0-9a-f]{64}$/),
  profile: newProfile,
});

let writeQueue: Promise<unknown> = Promise.resolve();

/** Appends a validated executable profile to user config; never alters started-run snapshots. */
export function createProfile(path: string, input: unknown, base: string, now: number) {
  const run = writeQueue.then(async () => {
    const parsed = newProfile.safeParse(input);
    if (!parsed.success) throw new ConfigWriteError("invalid", parsed.error.message);
    const p = parsed.data;
    const fail = (message: string): never => {
      throw new ConfigWriteError("invalid", message);
    };
    if (new Set(p.steps.map((s) => s.name)).size !== p.steps.length)
      fail("step names must be unique");
    const phases = p.steps.flatMap((s) => (s.phase == null ? [] : [s.phase]));
    if (new Set(phases).size !== phases.length) fail("execution phases must be unique");
    if (
      phases.some(
        (phase, i) =>
          i > 0 &&
          PROFILE_STEP_PHASES.indexOf(phase) < PROFILE_STEP_PHASES.indexOf(phases[i - 1] ?? phase),
      )
    )
      fail("execution phases must be in working, ci, review order");
    const allowed = new Set(["reproduce", "draft PR", "merge", "write-up", "findings", "propose"]);
    if (
      p.orchestration_only ||
      p.nodes !== undefined ||
      !p.steps.some((s) => s.phase === "working") ||
      p.steps.some((s) => s.phase == null && !allowed.has(s.name))
    ) {
      throw new ConfigWriteError(
        "invalid",
        "unsupported execution nodes: use the working, ci and review phase model; orchestration-only templates cannot be created as build profiles",
      );
    }
    let bytes: Buffer | null = null;
    try {
      if (!(await lstat(path)).isFile())
        throw new ConfigWriteError(
          "current",
          "profiles file must be a regular file, not a symbolic link",
        );
      bytes = await readFile(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const current = loadProfiles(path);
    if (current instanceof ProfilesError) throw new ConfigWriteError("current", current.message);
    if (profilesVersion(current) !== base)
      throw new ConfigWriteError("conflict", "templates changed; reload and try again");
    if (current.some((x) => x.name === p.name))
      throw new ConfigWriteError("duplicate", `a template named "${p.name}" already exists`);
    const doc = parseDocument(
      bytes?.toString("utf8") ?? stringify({ profiles: current.map(fileValue) }),
    );
    doc.addIn(["profiles"], p);
    const text = doc.toString({ lineWidth: 0 });
    const checked = z
      .array(fileProfile)
      .safeParse((parseYaml(text) as { profiles: unknown }).profiles);
    if (!checked.success)
      throw new ConfigWriteError("invalid", "the new profiles file would not load");
    let latest: Buffer | null = null;
    try {
      latest = await readFile(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (bytes === null ? latest !== null : !latest?.equals(bytes))
      throw new ConfigWriteError("conflict", "templates changed while saving; retry");
    const backup = bytes === null ? null : await backUp(path, bytes, now);
    await replace(path, text);
    if (backup) await pruneBackups(path, basename(backup)).catch(() => undefined);
    return profilesView(path);
  });
  writeQueue = run.catch(() => undefined);
  return run;
}
