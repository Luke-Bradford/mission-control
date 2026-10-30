/**
 * Atomic edits to the server's own config.yaml: repos, session seats and accounts. The path is
 * the one the server started with; no request names a path, and a symbolic link there is refused.
 * Every write re-reads the file, keeps its comments and key order (the YAML Document API, never
 * string concatenation; other spacing and quoting may be normalised), re-validates the whole result
 * with the startup loader, keeps a backup beside it, and swaps the file in by an atomic rename.
 */
import { type FileHandle, lstat, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  CONFIG_SEAT_MODES,
  compactUtc,
  type NewCrewSession,
  type NewRepo,
  ROLE_NAME,
  SESSION_CHECKOUT_STRATEGIES,
} from "@mc/core";
import { isMap, isSeq, parseDocument, type YAMLMap } from "yaml";
import { z } from "zod";
import { accountBindingProblem } from "./account-bindings.ts";
import {
  areaGlob,
  type CcConfig,
  ConfigError,
  type ConfigSeatInput,
  type CrewSessionConfig,
  defaultSeatCommands,
  displayCallSign,
  findHubRoot,
  MODEL_NAME,
  managedSessionPath,
  parseConfig,
  realish,
  SEAT_ID,
  seatEffort,
  seatInput,
  ticketState,
} from "./config.ts";
import { seatFocus } from "./focus.ts";
import {
  CheckoutError,
  createSessionCheckout,
  removeSessionCheckout,
  validateSessionCheckout,
} from "./runtime/checkouts.ts";

/** Backups (`config.yaml.bak-<UTC>`) kept beside the file; older ones are deleted. */
export const CONFIG_BACKUPS_KEEP = 10;

/** A GitHub `owner/name`: owner 1–39 of [A-Za-z0-9-] not starting with `-`, name 1–100. */
const GITHUB_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const CONTROL_CHAR = /\p{Cc}/u;
const MAX_STATUS_ENTRIES = 50;

/** Where a repo's board lives on GitHub; shared by every route that takes a repo to add. */
export const RepoLocation = z.strictObject({
  github: z.string().regex(GITHUB_REPO, "must be owner/name"),
  project: z.number().int().min(1).max(1_000_000),
});

/** `POST /api/repos`. */
export const NewRepoBody = z.strictObject({
  id: z.string().regex(REPO_ID, "must be 1–40 letters, digits, . _ or -, starting alphanumeric"),
  ...RepoLocation.shape,
  statusMap: z
    .record(
      z
        .string()
        .min(1)
        .max(100)
        .refine((k) => !CONTROL_CHAR.test(k), "must not contain control characters"),
      ticketState,
    )
    .refine(
      (m) => Object.keys(m).length >= 1 && Object.keys(m).length <= MAX_STATUS_ENTRIES,
      `must have 1–${MAX_STATUS_ENTRIES} entries`,
    ),
  needsYouLabels: z.array(z.string().min(1).max(50)).max(10).optional(),
});

/** The editable part of a configured repo card. Guidance is advice, never a dispatch filter. */
export const RepoSetupBody = z.strictObject({
  defaultAccountId: z.string().min(1).max(64).nullable(),
  guidance: z.strictObject({
    priority: z.array(z.string().min(1).max(100)).max(20),
    milestone: z.array(z.string().min(1).max(100)).max(20),
    labels: z.array(z.string().min(1).max(100)).max(30),
    labelMode: z.enum(["any", "all"]),
    avoid: z.array(z.string().min(1).max(100)).max(30),
    direction: z.string().max(4000),
  }),
});

/** One all-or-nothing Add/Convert submission from Setup › Repos & seats. */
export const RepoOnboardBody = z.strictObject({
  /** Omitted when converting an observed repo already in config.yaml. */
  repo: NewRepoBody.optional(),
  repoId: z.string().regex(REPO_ID, "must be a configured repo id"),
  defaultAccountId: z.string().min(1).max(64).nullable(),
  guidance: RepoSetupBody.shape.guidance,
  checkout: z.strictObject({
    source: z.string().refine(isAbsolute, "must be an absolute clone path"),
    branch: z
      .string()
      .min(1)
      .max(255)
      .refine((s) => !s.startsWith("-") && !CONTROL_CHAR.test(s)),
  }),
  /** An empty shared-checkout crew session, or null for an observed repo. */
  session: z
    .strictObject({
      id: z.string().regex(SEAT_ID),
      checkoutStrategy: z.literal("shared"),
    })
    .nullable(),
});

export const SEATS_CHANGED = "the seats changed since this page loaded them; reload and try again";
export const noSessionText = (id: string): string => `no crew session s/${id} in config.yaml`;

export const SeatInputBody = z.strictObject({
  id: z.string().regex(SEAT_ID, "must match /^[a-z][a-z0-9-]{0,30}$/"),
  displayCallSign: displayCallSign.optional(),
  focus: seatFocus.optional(),
  role: z.string().regex(ROLE_NAME, "must be a role name"),
  accountId: z.string().min(1).max(64),
  model: z.string().max(100).regex(MODEL_NAME, "must match /^[A-Za-z0-9][A-Za-z0-9._\\[\\]-]*$/"),
  effort: seatEffort.optional(),
  mode: z.enum(CONFIG_SEAT_MODES).optional(),
  area: z.array(areaGlob).max(20),
}) satisfies z.ZodType<ConfigSeatInput>;

/** `POST /api/crew/sessions/:sessionId/seats`. */
export const SeatsBody = z.strictObject({
  /** The seats as the page last saw them in config.yaml (`CrewChanges.sessions`). */
  base: z.array(SeatInputBody).max(32),
  seats: z
    .array(SeatInputBody.extend({ displayCallSign: displayCallSign.nullable().optional() }))
    .max(32)
    .refine((l) => new Set(l.map((s) => s.id)).size === l.length, "seat ids must be unique"),
});

export type ConfigWriteKind =
  | "current"
  | "duplicate"
  | "write"
  | "missing"
  | "conflict"
  | "invalid";

/**
 * Why a config write did not happen. `current`: the file on disk does not load (nothing written);
 * `duplicate`: the repo is already configured; `write`: the backup or swap failed (the file is
 * unchanged). The message never carries file contents.
 */
export class ConfigWriteError extends Error {
  readonly kind: ConfigWriteKind;
  constructor(kind: ConfigWriteKind, message: string) {
    super(message);
    this.name = "ConfigWriteError";
    this.kind = kind;
  }
}

type ConfigRepo = CcConfig["repos"][number];

/** Why `repo` is already in `repos` (same id, or same github in any case with the same project), or null. */
export function duplicateReason(repos: readonly ConfigRepo[], repo: NewRepo): string | null {
  if (repos.some((r) => r.id === repo.id))
    return `a repo with id "${repo.id}" is already configured`;
  const github = repo.github.toLowerCase();
  if (repos.some((r) => r.github.toLowerCase() === github && r.project === repo.project)) {
    return `${repo.github} project ${repo.project} is already configured`;
  }
  return null;
}

/** The part after `.bak-` in a backup this module names: the stamp and a same-second counter. */
const BACKUP_SUFFIX = /^(\d{8}T\d{6}Z)(?:-(\d+))?$/;
const MAX_SAME_SECOND = 100;

const errCode = (e: unknown): string => String((e as NodeJS.ErrnoException | null)?.code ?? "?");

// Writers run one at a time, so two Add clicks never read the same file and lose one repo.
let queue: Promise<unknown> = Promise.resolve();

/** Appends `repo` to the config.yaml at `path`; resolves with the new config and the backup's path. */
export function addRepo(
  path: string,
  repo: NewRepo,
  now: number,
): Promise<{ config: CcConfig; backup: string }> {
  const run = queue.then(() => add(path, repo, now));
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Adds (or updates) a repo card and, when requested, its empty shared-checkout session in one
 * config replacement.  Checkout validation happens before the replacement, so a retry can never
 * encounter a repo left behind by a failed later setup/session write.
 */
export function onboardRepo(
  path: string,
  input: z.infer<typeof RepoOnboardBody>,
  now: number,
  validateRepo?: (repo: Pick<CcConfig["repos"][number], "github" | "project">) => Promise<void>,
): Promise<{ config: CcConfig; backup: string }> {
  const run = queue.then(() => onboard(path, input, now, validateRepo));
  queue = run.catch(() => undefined);
  return run;
}

async function onboard(
  path: string,
  input: z.infer<typeof RepoOnboardBody>,
  now: number,
  validateRepo?: (repo: Pick<CcConfig["repos"][number], "github" | "project">) => Promise<void>,
): Promise<{ config: CcConfig; backup: string }> {
  const parsed = RepoOnboardBody.safeParse(input);
  if (!parsed.success) throw new ConfigWriteError("invalid", "invalid repo onboarding request");
  const body = parsed.data;
  if (body.repo && body.repo.id !== body.repoId)
    throw new ConfigWriteError("invalid", "repo id does not match the repo being added");
  if (body.session && body.session.id !== body.repoId)
    throw new ConfigWriteError("invalid", "session id must match the repo id");

  const { bytes, text, current } = await readCurrent(path);
  if (
    body.defaultAccountId !== null &&
    !current.accounts.some((account) => account.id === body.defaultAccountId)
  )
    throw new ConfigWriteError("invalid", "the default account is not configured");

  const existing = current.repos.findIndex((repo) => repo.id === body.repoId);
  if (body.repo && existing >= 0)
    throw new ConfigWriteError(
      "duplicate",
      `a repo with id "${body.repoId}" is already configured`,
    );
  if (!body.repo && existing < 0)
    throw new ConfigWriteError("missing", `unknown repo ${body.repoId}`);
  if (body.repo) {
    const duplicate = duplicateReason(current.repos, body.repo);
    if (duplicate) throw new ConfigWriteError("duplicate", duplicate);
  }
  const repo = body.repo ?? current.repos[existing];
  if (!repo) throw new ConfigWriteError("missing", `unknown repo ${body.repoId}`);
  // This re-reads the repo from the serialized config operation.  It must precede local checkout
  // validation: a submitted branch other than GitHub's default has a precise refusal, even when
  // that branch does not exist in the checkout.
  await validateRepo?.(repo);
  const crew = current.crew;
  if (body.session && !crew)
    throw new ConfigWriteError("conflict", "configure crew before adding sessions");
  if (body.session && crew?.sessions.some((session) => session.id === body.session?.id))
    throw new ConfigWriteError("duplicate", `s/${body.session.id} already exists.`);

  try {
    await validateSessionCheckout(body.checkout.source, body.checkout.branch, repo.github, true, [
      ...current.loops.map((loop) => ({ label: `loop ${loop.id} worktree`, dir: loop.worktree })),
      ...(crew?.sessions ?? []).map((session) => ({
        label: `session ${session.id} checkout`,
        dir: session.checkout,
      })),
    ]);
  } catch (e) {
    throw new ConfigWriteError(
      "invalid",
      e instanceof CheckoutError ? e.message : "could not validate the checkout and branch",
    );
  }

  const doc = parseDocument(text);
  const repos = doc.get("repos", true);
  if (doc.errors.length > 0 || !isSeq(repos))
    throw new ConfigWriteError("current", "config.yaml has no repos list to edit");
  let node: YAMLMap;
  let repoIndex = existing;
  if (body.repo) {
    node = doc.createNode({
      id: body.repo.id,
      github: body.repo.github,
      project: body.repo.project,
      status_map: body.repo.statusMap,
      ...(body.repo.needsYouLabels === undefined
        ? {}
        : { needs_you_labels: body.repo.needsYouLabels }),
    });
    if (repos.items.length === 0) {
      const list = doc.createNode([node]);
      list.commentBefore = repos.commentBefore;
      list.comment = repos.comment;
      doc.set("repos", list);
    } else repos.add(node);
    repoIndex = current.repos.length;
  } else {
    const found = repos.items[repoIndex];
    if (!isMap(found))
      throw new ConfigWriteError("current", "config.yaml has no repo list to edit");
    node = found;
  }
  if (body.defaultAccountId === null) node.delete("default_account_id");
  else node.set("default_account_id", body.defaultAccountId);
  const guidance = body.guidance;
  const emptyGuidance =
    guidance.priority.length === 0 &&
    guidance.milestone.length === 0 &&
    guidance.labels.length === 0 &&
    guidance.labelMode === "any" &&
    guidance.avoid.length === 0 &&
    guidance.direction === "";
  if (emptyGuidance) node.delete("guidance");
  else
    node.set(
      "guidance",
      doc.createNode({
        priority: guidance.priority,
        milestone: guidance.milestone,
        labels: guidance.labels,
        label_mode: guidance.labelMode,
        avoid: guidance.avoid,
        direction: guidance.direction,
      }),
    );

  if (body.session) {
    const sessions = doc.getIn(["crew", "sessions"], true);
    if (!isSeq(sessions)) throw new ConfigWriteError("current", "config.yaml has no sessions list");
    sessions.add(
      doc.createNode({
        id: body.session.id,
        repo_id: body.repoId,
        checkout: realish(body.checkout.source),
        branch: body.checkout.branch,
        seats: [],
      }),
    );
    sessions.flow = false;
  }
  const newText = doc.toString({ lineWidth: 0 });
  const next = sessionConfig(newText);
  const nextRepo = next.repos[repoIndex];
  if (!nextRepo) throw new ConfigWriteError("write", "the new config.yaml has no added repo");
  const expectedRepo = {
    ...(body.repo
      ? {
          id: body.repo.id,
          github: body.repo.github,
          project: body.repo.project,
          statusMap: body.repo.statusMap,
          ...(body.repo.needsYouLabels === undefined
            ? {}
            : { needsYouLabels: body.repo.needsYouLabels }),
          fullSuite: [],
          requiredChecks: [],
          commands: defaultSeatCommands(),
          protectedFiles: [],
          autonomy: "draft" as const,
          flightPowers: "standard" as const,
        }
      : { ...repo }),
    ...(body.defaultAccountId === null ? {} : { defaultAccountId: body.defaultAccountId }),
    ...(emptyGuidance ? {} : { guidance: { ...guidance } }),
  };
  const expectedRepos = body.repo
    ? [...current.repos, expectedRepo]
    : current.repos.map((item, index) => (index === repoIndex ? expectedRepo : item));
  const addedSession = body.session ? next.crew?.sessions.at(-1) : undefined;
  const expected = {
    ...current,
    repos: expectedRepos,
    ...(body.session && crew && addedSession
      ? { crew: { ...crew, sessions: [...crew.sessions, addedSession] } }
      : {}),
  };
  if (!isDeepStrictEqual(next, expected))
    throw new ConfigWriteError(
      "write",
      "the new config.yaml would change more than this repo setup",
    );
  const backup = await backUp(path, bytes, now);
  await replace(path, newText);
  await pruneBackups(path, basename(backup)).catch(() => undefined);
  return { config: next, backup };
}

/**
 * The file as it is now, which may have been edited by hand since the server started. A link
 * would make the backup and the write land somewhere other than the file named by the path.
 */
async function readCurrent(
  path: string,
): Promise<{ bytes: Buffer; text: string; current: CcConfig }> {
  let isLink: boolean;
  try {
    isLink = (await lstat(path)).isSymbolicLink();
  } catch {
    throw new ConfigWriteError("current", "the current config.yaml does not load");
  }
  if (isLink) throw new ConfigWriteError("current", "config.yaml is a symbolic link");
  try {
    const bytes = await readFile(path);
    const text = bytes.toString("utf8");
    return {
      bytes,
      text,
      current: parseConfig(text, "config.yaml", { hubRoot: findHubRoot(), deferModels: true }),
    };
  } catch {
    throw new ConfigWriteError("current", "the current config.yaml does not load");
  }
}

/** Sets s/<sessionId>'s seats to `seats`; resolves with the new config and the backup's path. */
export function setSessionSeats(
  path: string,
  sessionId: string,
  base: ConfigSeatInput[],
  seats: z.infer<typeof SeatsBody>["seats"],
  now: number,
): Promise<{ config: CcConfig; backup: string }> {
  const run = queue.then(() => setSeats(path, sessionId, base, seats, now));
  queue = run.catch(() => undefined);
  return run;
}

/** Replaces only a repo card's account preference and FLIGHT guidance. */
export function setRepoSetup(
  path: string,
  repoId: string,
  setup: z.infer<typeof RepoSetupBody>,
  now: number,
): Promise<{ config: CcConfig; backup: string }> {
  const run = queue.then(() => setRepo(path, repoId, setup, now));
  queue = run.catch(() => undefined);
  return run;
}

async function setRepo(
  path: string,
  repoId: string,
  setup: z.infer<typeof RepoSetupBody>,
  now: number,
): Promise<{ config: CcConfig; backup: string }> {
  const parsed = RepoSetupBody.safeParse(setup);
  if (!parsed.success) throw new ConfigWriteError("invalid", "invalid repo setup");
  const { bytes, text, current } = await readCurrent(path);
  const index = current.repos.findIndex((repo) => repo.id === repoId);
  if (index < 0) throw new ConfigWriteError("missing", `unknown repo ${repoId}`);
  if (
    parsed.data.defaultAccountId !== null &&
    !current.accounts.some((account) => account.id === parsed.data.defaultAccountId)
  )
    throw new ConfigWriteError("invalid", "the default account is not configured");
  const doc = parseDocument(text);
  const repos = doc.get("repos", true);
  if (doc.errors.length > 0 || !isSeq(repos) || !isMap(repos.items[index]))
    throw new ConfigWriteError("current", "config.yaml has no repo list to edit");
  const node = repos.items[index] as YAMLMap;
  if (parsed.data.defaultAccountId === null) node.delete("default_account_id");
  else node.set("default_account_id", parsed.data.defaultAccountId);
  const guidance = parsed.data.guidance;
  const emptyGuidance =
    guidance.priority.length === 0 &&
    guidance.milestone.length === 0 &&
    guidance.labels.length === 0 &&
    guidance.labelMode === "any" &&
    guidance.avoid.length === 0 &&
    guidance.direction === "";
  if (emptyGuidance) {
    node.delete("guidance");
  } else {
    node.set(
      "guidance",
      doc.createNode({
        priority: guidance.priority,
        milestone: guidance.milestone,
        labels: guidance.labels,
        label_mode: guidance.labelMode,
        avoid: guidance.avoid,
        direction: guidance.direction,
      }),
    );
  }
  const newText = doc.toString({ lineWidth: 0 });
  let next: CcConfig;
  try {
    next = parseConfig(newText, "the new config.yaml");
  } catch {
    throw new ConfigWriteError("write", "the new config.yaml would not load");
  }
  const expected = current.repos.map((repo, i) => {
    if (i !== index) return repo;
    const updated = { ...repo };
    if (parsed.data.defaultAccountId === null) delete updated.defaultAccountId;
    else updated.defaultAccountId = parsed.data.defaultAccountId;
    if (emptyGuidance) delete updated.guidance;
    else
      updated.guidance = {
        priority: guidance.priority,
        milestone: guidance.milestone,
        labels: guidance.labels,
        labelMode: guidance.labelMode,
        avoid: guidance.avoid,
        direction: guidance.direction,
      };
    return updated;
  });
  if (!isDeepStrictEqual(next, { ...current, repos: expected }))
    throw new ConfigWriteError("write", "the new config.yaml would change more than this repo");
  const backup = await backUp(path, bytes, now);
  await replace(path, newText);
  await pruneBackups(path, basename(backup)).catch(() => undefined);
  return { config: next, backup };
}

async function setSeats(
  path: string,
  sessionId: string,
  base: ConfigSeatInput[],
  seats: z.infer<typeof SeatsBody>["seats"],
  now: number,
): Promise<{ config: CcConfig; backup: string }> {
  const parsed = SeatsBody.safeParse({ base, seats });
  if (!parsed.success) throw new ConfigWriteError("invalid", "invalid session seats");
  const { bytes, text, current } = await readCurrent(path);
  const i = current.crew?.sessions.findIndex((s) => s.id === sessionId) ?? -1;
  const session = current.crew?.sessions[i];
  if (!session) throw new ConfigWriteError("missing", noSessionText(sessionId));
  if (!isDeepStrictEqual(session.seats.map(seatInput), base)) {
    throw new ConfigWriteError("conflict", SEATS_CHANGED);
  }

  // Setup's seat editor omits display metadata. Preserve it unless explicitly cleared.
  const nextSeats: ConfigSeatInput[] = seats.map(({ displayCallSign: name, focus, ...seat }) => {
    const storedFocus = session.seats.find((s) => s.id === seat.id)?.focus;
    const nextFocus = focus === undefined ? storedFocus : focus;
    const focused: ConfigSeatInput = {
      ...seat,
      ...(nextFocus === undefined ? {} : { focus: nextFocus }),
    };
    const stored = session.seats.find((s) => s.id === seat.id)?.displayCallSign;
    const displayCallSign = name === undefined ? stored : name;
    return displayCallSign == null ? focused : { ...focused, displayCallSign };
  });
  const doc = parseDocument(text);
  const seq = doc.getIn(["crew", "sessions", i, "seats"], true);
  if (!isSeq(seq) || doc.errors.length > 0) {
    throw new ConfigWriteError("current", `config.yaml has no seats list for s/${sessionId}`);
  }
  const nodes = nextSeats.map((seat) => {
    const existing = seq.items.find((item) => isMap(item) && item.get("id") === seat.id);
    let node: YAMLMap;
    if (isMap(existing)) node = existing;
    else {
      node = doc.createNode({ id: seat.id }, { aliasDuplicateObjects: false });
      node.flow = true;
    }
    if (seat.displayCallSign === undefined) node.delete("display_call_sign");
    else node.set("display_call_sign", seat.displayCallSign);
    if (seat.focus === undefined) node.delete("focus");
    else node.set("focus", seat.focus);
    node.set("role", seat.role);
    node.set("account_id", seat.accountId);
    node.set("model", seat.model);
    if (seat.effort === undefined) node.delete("effort");
    else node.set("effort", seat.effort);
    if (seat.mode === undefined) node.delete("mode");
    else node.set("mode", seat.mode);
    if (seat.area.length === 0) node.delete("area");
    else {
      const area = doc.createNode(seat.area);
      area.flow = true;
      node.set("area", area);
    }
    return node;
  });
  seq.items = nodes;
  seq.flow = nodes.length === 0;
  const newText = doc.toString({ lineWidth: 0 });

  let next: CcConfig;
  try {
    next = parseConfig(newText, "the new config.yaml");
  } catch (e) {
    if (e instanceof ConfigError) throw new ConfigWriteError("invalid", e.message);
    throw new ConfigWriteError("write", "the new config.yaml would not load");
  }
  const bare = (c: CcConfig): CcConfig => ({
    ...c,
    crew: c.crew && {
      ...c.crew,
      sessions: c.crew.sessions.map((s, n) => (n === i ? { ...s, seats: [] } : s)),
    },
  });
  if (
    !isDeepStrictEqual(bare(next), bare(current)) ||
    !isDeepStrictEqual(next.crew?.sessions[i]?.seats.map(seatInput), nextSeats)
  ) {
    throw new ConfigWriteError(
      "write",
      "the new config.yaml would change more than the session's seats",
    );
  }

  const backup = await backUp(path, bytes, now);
  await replace(path, newText);
  await pruneBackups(path, basename(backup)).catch(() => undefined);
  return { config: next, backup };
}

async function add(
  path: string,
  repo: NewRepo,
  now: number,
): Promise<{ config: CcConfig; backup: string }> {
  // 1.
  const { bytes, text, current } = await readCurrent(path);
  // 2.
  const duplicate = duplicateReason(current.repos, repo);
  if (duplicate) throw new ConfigWriteError("duplicate", duplicate);

  // 3. Append through the YAML Document, which keeps comments and key order.
  const doc = parseDocument(text);
  const repos = doc.get("repos", true);
  if (doc.errors.length > 0 || !isSeq(repos)) {
    throw new ConfigWriteError("current", "config.yaml has no repos list to append to");
  }
  const entry = doc.createNode(
    {
      id: repo.id,
      github: repo.github,
      project: repo.project,
      status_map: repo.statusMap,
      ...(repo.needsYouLabels === undefined ? {} : { needs_you_labels: repo.needsYouLabels }),
    },
    { aliasDuplicateObjects: false },
  );
  if (repos.items.length === 0) {
    // `repos: []` is a flow sequence; a fresh one is written as a block list, keeping its comments.
    const list = doc.createNode([entry]);
    list.commentBefore = repos.commentBefore;
    list.comment = repos.comment;
    doc.set("repos", list);
  } else {
    repos.add(entry);
  }
  const newText = doc.toString({ lineWidth: 0 }); // 0: never fold a long line
  const added: ConfigRepo = {
    id: repo.id,
    github: repo.github,
    project: repo.project,
    statusMap: repo.statusMap,
    ...(repo.needsYouLabels === undefined ? {} : { needsYouLabels: repo.needsYouLabels }),
    fullSuite: [],
    requiredChecks: [],
    commands: defaultSeatCommands(),
    protectedFiles: [],
    autonomy: "draft",
    flightPowers: "standard",
  };
  let next: CcConfig;
  try {
    next = parseConfig(newText, "the new config.yaml");
  } catch {
    throw new ConfigWriteError("write", "the new config.yaml would not load");
  }
  if (!isDeepStrictEqual(next, { ...current, repos: [...current.repos, added] })) {
    throw new ConfigWriteError(
      "write",
      "the new config.yaml would change more than the added repo",
    );
  }

  // 4. Keep the old file beside the new one: the bytes read and validated above.
  const backup = await backUp(path, bytes, now);
  // 5.
  await replace(path, newText);
  // Old backups are spare copies: failing to delete one must not fail an add that has landed.
  await pruneBackups(path, basename(backup)).catch(() => undefined);
  return { config: next, backup };
}

/**
 * Writes `bytes` to a new `<path>.bak-<UTC>` (a counter when that second is taken), created 0600
 * and exclusively, so it is never readable more widely and never overwrites an earlier backup.
 */
export async function backUp(path: string, bytes: Buffer, now: number): Promise<string> {
  const stamp = compactUtc(now);
  for (let n = 0; n < MAX_SAME_SECOND; n++) {
    const backup = `${path}.bak-${stamp}${n === 0 ? "" : `-${n}`}`;
    let file: FileHandle;
    try {
      file = await open(backup, "wx", 0o600);
    } catch (e) {
      if (errCode(e) === "EEXIST") continue;
      throw new ConfigWriteError("write", `could not back up config.yaml (${errCode(e)})`);
    }
    try {
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (e) {
      await rm(backup, { force: true }).catch(() => undefined);
      throw new ConfigWriteError("write", `could not back up config.yaml (${errCode(e)})`);
    }
    return backup;
  }
  throw new ConfigWriteError("write", "could not back up config.yaml (no free backup name)");
}

/** Writes a temp file beside `path` (0600, fsynced) and renames it over `path`; never half-written. */
export async function replace(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    await rm(tmp, { force: true }); // a temp file left by a crashed process with this pid
    const file = await open(tmp, "wx", 0o600);
    try {
      await file.writeFile(text, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw new ConfigWriteError("write", `could not replace config.yaml (${errCode(e)})`);
  }
}

/**
 * Deletes all but CONFIG_BACKUPS_KEEP backups this module named, no other file: `keep` (this add's
 * own backup, whatever its stamp says, since the clock may have gone back) and the newest others.
 */
export async function pruneBackups(path: string, keep: string): Promise<void> {
  const dir = dirname(path);
  const prefix = `${basename(path)}.bak-`;
  const ours = (await readdir(dir)).flatMap((name) => {
    if (name === keep) return [];
    const m = name.startsWith(prefix) ? BACKUP_SUFFIX.exec(name.slice(prefix.length)) : null;
    return m?.[1] ? [{ name, stamp: m[1], n: Number(m[2] ?? 0) }] : [];
  });
  // newest first: by stamp, then by same-second counter
  ours.sort((a, b) => (a.stamp === b.stamp ? b.n - a.n : a.stamp < b.stamp ? 1 : -1));
  for (const old of ours.slice(CONFIG_BACKUPS_KEEP - 1)) {
    await rm(join(dir, old.name), { force: true });
  }
}

export const NewAccountBody = z.strictObject({
  name: z.string().regex(REPO_ID, "must be 1–40 letters, digits, . _ or -, starting alphanumeric"),
  provider: z.enum(["claude", "codex"]),
  cliProfile: z.string().min(1).max(4096).refine(isAbsolute, "must be absolute").optional(),
});

/** `PUT /api/accounts/:id`. Account ids stay stable because seats and loops refer to them. */
export const AccountBody = NewAccountBody.omit({ name: true })
  .extend({
    alertAt: z.number().int().min(0).max(100),
    stopAt: z.number().int().min(0).max(100),
  })
  .refine((account) => account.alertAt <= account.stopAt, "alert must not exceed stop");

export function accountDuplicateReason(
  accounts: CcConfig["accounts"],
  account: z.infer<typeof NewAccountBody>,
): string | null {
  if (accounts.some((a) => a.id.toLowerCase() === account.name.toLowerCase())) {
    return "an account with that name is already configured";
  }
  const problem = accountBindingProblem([
    ...accounts,
    { vendor: account.provider, cliProfile: account.cliProfile },
  ]);
  return problem === null
    ? null
    : `only one account per provider is supported without independent bindings: ${problem}`;
}

/** Validates existing login bindings and adds configuration; never logs in or creates profiles. */
export function addAccount(path: string, account: z.infer<typeof NewAccountBody>, now: number) {
  const run = queue.then(async () => {
    const parsed = NewAccountBody.safeParse(account);
    if (!parsed.success) throw new ConfigWriteError("invalid", "invalid account provider or name");
    const { bytes, text, current } = await readCurrent(path);
    const duplicate = accountDuplicateReason(current.accounts, account);
    if (duplicate) throw new ConfigWriteError("duplicate", duplicate);
    const doc = parseDocument(text);
    const accounts = doc.get("accounts", true);
    if (!isSeq(accounts) || doc.errors.length > 0) {
      throw new ConfigWriteError("current", "config.yaml has no accounts list");
    }
    accounts.add(
      doc.createNode({
        id: account.name,
        vendor: account.provider,
        alert_at: 80,
        stop_at: 100,
        ...(account.cliProfile === undefined ? {} : { cli_profile: account.cliProfile }),
      }),
    );
    accounts.flow = false;
    const newText = doc.toString({ lineWidth: 0 });
    let next: CcConfig;
    try {
      next = parseConfig(newText, "the new config.yaml");
    } catch {
      throw new ConfigWriteError("invalid", "the new account config would not load");
    }
    const added = {
      id: account.name,
      vendor: account.provider,
      alertAt: 80,
      stopAt: 100,
      ...(account.cliProfile === undefined ? {} : { cliProfile: account.cliProfile }),
    };
    if (!isDeepStrictEqual(next, { ...current, accounts: [...current.accounts, added] })) {
      throw new ConfigWriteError(
        "write",
        "the new config.yaml would change more than the added account",
      );
    }
    const backup = await backUp(path, bytes, now);
    await replace(path, newText);
    await pruneBackups(path, basename(backup)).catch(() => undefined);
    return { config: next, backup };
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Edit one account without touching any unrelated configuration. */
export function setAccount(
  path: string,
  id: string,
  account: z.infer<typeof AccountBody>,
  now: number,
) {
  const run = queue.then(async () => {
    const parsed = AccountBody.safeParse(account);
    if (!parsed.success) throw new ConfigWriteError("invalid", "invalid account settings");
    const { bytes, text, current } = await readCurrent(path);
    const index = current.accounts.findIndex((existing) => existing.id === id);
    if (index < 0) throw new ConfigWriteError("missing", "account not found");
    // the form does not carry the review budget: an edit leaves it as the file has it
    const reviewTokenBudget = current.accounts[index]?.reviewTokenBudget;
    const kept = reviewTokenBudget === undefined ? {} : { reviewTokenBudget };
    const nextAccount = {
      id,
      vendor: account.provider,
      alertAt: account.alertAt,
      stopAt: account.stopAt,
      ...(account.cliProfile === undefined ? {} : { cliProfile: account.cliProfile }),
      ...kept,
    };
    const problem = accountBindingProblem(
      current.accounts.map((existing, i) => (i === index ? nextAccount : existing)),
    );
    if (problem) throw new ConfigWriteError("invalid", problem);
    const doc = parseDocument(text);
    const accounts = doc.get("accounts", true);
    const item = isSeq(accounts) ? accounts.items[index] : undefined;
    if (!isMap(item) || doc.errors.length > 0)
      throw new ConfigWriteError("current", "config.yaml has no account to update");
    item.set("vendor", account.provider);
    item.set("alert_at", account.alertAt);
    item.set("stop_at", account.stopAt);
    if (account.cliProfile === undefined) item.delete("cli_profile");
    else item.set("cli_profile", account.cliProfile);
    const newText = doc.toString({ lineWidth: 0 });
    let next: CcConfig;
    try {
      next = parseConfig(newText, "the new config.yaml");
    } catch {
      throw new ConfigWriteError("invalid", "the updated account config would not load");
    }
    const expected = {
      id,
      vendor: account.provider,
      alertAt: account.alertAt,
      stopAt: account.stopAt,
      ...(account.cliProfile === undefined ? {} : { cliProfile: account.cliProfile }),
      ...kept,
    };
    if (
      !isDeepStrictEqual(next, {
        ...current,
        accounts: current.accounts.map((a, i) => (i === index ? expected : a)),
      })
    )
      throw new ConfigWriteError("write", "the new config.yaml would change more than the account");
    const backup = await backUp(path, bytes, now);
    await replace(path, newText);
    await pruneBackups(path, basename(backup)).catch(() => undefined);
    return { config: next, backup };
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Removes an unused account. Callers must establish it has no configured consumers first. */
export function removeAccount(path: string, id: string, now: number) {
  const run = queue.then(async () => {
    const { bytes, text, current } = await readCurrent(path);
    const index = current.accounts.findIndex((account) => account.id === id);
    if (index < 0) throw new ConfigWriteError("missing", "account not found");
    const doc = parseDocument(text);
    const accounts = doc.get("accounts", true);
    if (!isSeq(accounts) || doc.errors.length > 0)
      throw new ConfigWriteError("current", "config.yaml has no accounts list");
    accounts.items.splice(index, 1);
    accounts.flow = accounts.items.length === 0;
    const newText = doc.toString({ lineWidth: 0 });
    let next: CcConfig;
    try {
      next = parseConfig(newText, "the new config.yaml");
    } catch {
      throw new ConfigWriteError("invalid", "the updated account config would not load");
    }
    if (
      !isDeepStrictEqual(next, {
        ...current,
        accounts: current.accounts.filter((a) => a.id !== id),
      })
    )
      throw new ConfigWriteError("write", "the new config.yaml would change more than the account");
    const backup = await backUp(path, bytes, now);
    await replace(path, newText);
    await pruneBackups(path, basename(backup)).catch(() => undefined);
    return { config: next, backup };
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Changes only selected Teams sources; the token command is never accepted over HTTP. */
export function setTeamsSelection(
  path: string,
  selected: NonNullable<NonNullable<CcConfig["sources"]>["teams"]>["selected"],
  now: number,
): Promise<CcConfig> {
  const run = queue.then(async () => {
    const { bytes, text, current } = await readCurrent(path);
    const doc = parseDocument(text);
    doc.setIn(["sources", "teams", "selected"], doc.createNode(selected));
    const newText = doc.toString({ lineWidth: 0 });
    let next: CcConfig;
    try {
      next = parseConfig(newText, "the new config.yaml");
    } catch {
      throw new ConfigWriteError("write", "the new config.yaml would not load");
    }
    if (
      !current.sources?.teams ||
      !isDeepStrictEqual(next, {
        ...current,
        sources: { ...current.sources, teams: { ...current.sources.teams, selected } },
      })
    )
      throw new ConfigWriteError("write", "Configure Teams locally before selecting sources");
    const backup = await backUp(path, bytes, now);
    await replace(path, newText);
    await pruneBackups(path, basename(backup)).catch(() => undefined);
    return next;
  });
  queue = run.catch(() => undefined);
  return run;
}

export const NewSessionBody = z.strictObject({
  id: z.string().regex(SEAT_ID),
  repoId: z.string().min(1),
  source: z.string().refine(isAbsolute, "must be an absolute clone path"),
  branch: z
    .string()
    .min(1)
    .max(255)
    .refine((s) => !s.startsWith("-") && !CONTROL_CHAR.test(s)),
  checkoutStrategy: z.enum(SESSION_CHECKOUT_STRATEGIES),
}) satisfies z.ZodType<NewCrewSession>;

export const sessionActiveText = (id: string, n: number): string =>
  `Stop or remove the ${n} agent(s) in s/${id} first.`;

function sessionConfig(text: string): CcConfig {
  try {
    return parseConfig(text, "the new config.yaml");
  } catch (e) {
    throw new ConfigWriteError(
      "invalid",
      e instanceof ConfigError ? e.message : "invalid sessions",
    );
  }
}

export async function createSession(
  path: string,
  input: NewCrewSession,
  now: number,
  applied?: CcConfig,
) {
  const parsed = NewSessionBody.safeParse(input);
  if (!parsed.success) throw new ConfigWriteError("invalid", "invalid session");
  const { bytes, text, current } = await readCurrent(path);
  const crew = current.crew;
  if (!crew) throw new ConfigWriteError("conflict", "configure crew before adding sessions");
  const membership = (c: CcConfig) => c.crew?.sessions.map((s) => [s.id, s.repoId, s.checkout]);
  if (
    applied &&
    (!isDeepStrictEqual(membership(current), membership(applied)) ||
      !isDeepStrictEqual(current.loops, applied.loops) ||
      crew.worktrees !== applied.crew?.worktrees ||
      !isDeepStrictEqual(crew.denyRead, applied.crew?.denyRead))
  ) {
    throw new ConfigWriteError(
      "conflict",
      "session confinement changed on disk; apply it before adding a session",
    );
  }
  if (crew.sessions.some((s) => s.id === input.id)) {
    throw new ConfigWriteError("duplicate", `s/${input.id} already exists.`);
  }
  const repo = current.repos.find((r) => r.id === input.repoId);
  if (!repo) throw new ConfigWriteError("invalid", "unknown repo profile");
  const separate = input.checkoutStrategy === "separate";
  const checkout = realish(separate ? managedSessionPath(crew.worktrees, input.id) : input.source);
  const doc = parseDocument(text);
  const sessions = doc.getIn(["crew", "sessions"], true);
  if (!isSeq(sessions)) throw new ConfigWriteError("current", "config.yaml has no sessions list");
  const node: YAMLMap = doc.createNode({
    id: input.id,
    repo_id: input.repoId,
    checkout,
    branch: input.branch,
    seats: [],
  });
  sessions.add(node);
  sessions.flow = false;
  // Confinement, deny_read and every other config invariant are checked before creating anything.
  sessionConfig(doc.toString({ lineWidth: 0 }));
  const peers = current.loops.map((l) => ({ label: `loop ${l.id} worktree`, dir: l.worktree }));
  let owned: CrewSessionConfig | undefined;
  try {
    const origin = await validateSessionCheckout(
      input.source,
      input.branch,
      repo.github,
      !separate,
      peers,
    ).catch((e) => {
      throw new ConfigWriteError(
        "invalid",
        e instanceof CheckoutError ? e.message : "could not validate the checkout and branch",
      );
    });
    if (separate) {
      const proof = await createSessionCheckout(
        input.source,
        checkout,
        input.branch,
        origin,
        input.id,
      );
      owned = {
        id: input.id,
        repoId: input.repoId,
        checkout,
        branch: input.branch,
        managedCheckout: proof,
        seats: [],
      };
      node.set("managed_checkout", doc.createNode(proof));
    }
    const newText = doc.toString({ lineWidth: 0 });
    const next = sessionConfig(newText);
    const added = next.crew?.sessions.at(-1);
    if (
      !added ||
      !isDeepStrictEqual(next, {
        ...current,
        crew: { ...crew, sessions: [...crew.sessions, added] },
      })
    ) {
      throw new ConfigWriteError(
        "write",
        "the new config.yaml would change more than the added session",
      );
    }
    const folders = (await readdir(checkout, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name !== ".git")
      .map((e) => e.name)
      .sort();
    const run = queue.then(async () => {
      const latest = await readCurrent(path);
      if (latest.current.crew?.sessions.some((s) => s.id === input.id)) {
        throw new ConfigWriteError("duplicate", `s/${input.id} already exists.`);
      }
      if (owned) {
        const stat = await lstat(checkout);
        if (
          stat.dev !== owned.managedCheckout?.device ||
          stat.ino !== owned.managedCheckout?.inode
        ) {
          throw new ConfigWriteError(
            "conflict",
            `checkout destination already exists or changed: ${checkout}`,
          );
        }
      }
      if (!latest.bytes.equals(bytes)) {
        throw new ConfigWriteError(
          "conflict",
          "config.yaml changed while preparing the session; retry",
        );
      }
      const backup = await backUp(path, latest.bytes, now);
      await replace(path, newText);
      await pruneBackups(path, basename(backup)).catch(() => undefined);
      return { config: next, backup, folders };
    });
    queue = run.catch(() => undefined);
    return await run;
  } catch (e) {
    if (owned) {
      const outcome = await removeSessionCheckout(owned, crew.worktrees, true);
      if (outcome !== "removed")
        throw new ConfigWriteError("write", `config save failed; checkout ${outcome}`);
    }
    if (e instanceof CheckoutError) throw new ConfigWriteError("invalid", e.message);
    throw e;
  }
}

/** The caller holds live removal through crew-apply until the atomic save has finished. */
export function closeSession(
  path: string,
  id: string,
  stopped: (seatId: string) => boolean,
  now: number,
  expected: CrewSessionConfig,
) {
  const run = queue.then(async () => {
    const { bytes, text, current } = await readCurrent(path);
    const crew = current.crew;
    const index = crew?.sessions.findIndex((s) => s.id === id) ?? -1;
    const session = crew?.sessions[index];
    if (!crew || !session) throw new ConfigWriteError("missing", noSessionText(id));
    if (!isDeepStrictEqual(session, expected)) {
      throw new ConfigWriteError(
        "conflict",
        "the session changed on disk; reload before closing it",
      );
    }
    const active = session.seats.filter((s) => !stopped(s.id)).length;
    if (active) throw new ConfigWriteError("conflict", sessionActiveText(id, active));
    const doc = parseDocument(text);
    doc.deleteIn(["crew", "sessions", index]);
    const newText = doc.toString({ lineWidth: 0 });
    const next = sessionConfig(newText);
    if (
      !isDeepStrictEqual(next, {
        ...current,
        crew: { ...crew, sessions: crew.sessions.filter((s) => s.id !== id) },
      })
    ) {
      throw new ConfigWriteError(
        "write",
        "the new config.yaml would change more than the closed session",
      );
    }
    const backup = await backUp(path, bytes, now);
    await replace(path, newText);
    await pruneBackups(path, basename(backup)).catch(() => undefined);
    return { config: next, backup, session, worktrees: crew.worktrees };
  });
  queue = run.catch(() => undefined);
  return run;
}
