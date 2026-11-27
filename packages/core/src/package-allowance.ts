/**
 * A ticket that needs a new package: FLIGHT allows named packages, at exact versions, in named
 * manifest and lockfile paths, for one run (`allow_dependency`). The commit tool then accepts those
 * files when their change adds just the named packages; the PR lists what was added.
 */
import { unclosedMarkdown } from "./guard.ts";
import { NESTED_PROTECTED_PROBLEM, pathGrantProblem } from "./path-grants.ts";

export interface AllowedPackage {
  name: string;
  version: string;
  licence: string;
}

/** An npm package name, scoped or not. */
export const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
/** One exact SemVer 2.0.0 version (semver.org's own pattern): no range, no leading zero. */
export const EXACT_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
/** A licence as the package states it, such as MIT or (MIT OR Apache-2.0). */
export const LICENCE = /^[A-Za-z0-9.+()\- ]{1,100}$/;

const MANIFEST = "package.json";
const LOCKFILE = "pnpm-lock.yaml";
const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
/** The lockfile's records of resolved packages: a new package may add records, never change one. */
const LOCK_RECORDS = ["packages", "snapshots"] as const;
/** The lockfile parts a new package may add to, each checked entry by entry. */
const LOCK_GROWS = new Set<string>(["importers", ...LOCK_RECORDS]);

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** Whether `path` is a file an allowance can name: a package.json or pnpm-lock.yaml. */
export function isAllowanceFile(path: string): boolean {
  return baseName(path) === MANIFEST || baseName(path) === LOCKFILE;
}

export const isManifest = (path: string): boolean => baseName(path) === MANIFEST;

/** Why `path` cannot be in an allowance, or null. Unlike a start grant, a nested manifest can. */
export function allowanceFileProblem(path: string): string | null {
  const why = pathGrantProblem(path);
  if (why !== null && why !== NESTED_PROTECTED_PROBLEM) return why;
  if (!isAllowanceFile(path)) return `only a ${MANIFEST} or ${LOCKFILE} can be allowed`;
  return null;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => same(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && same(a[k], b[k]));
  }
  return false;
}

const withoutKeys = (o: Record<string, unknown>, keys: ReadonlySet<string>) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !keys.has(k)));

const notAllowedText = (name: string): string => `adds ${name}, which FLIGHT did not allow`;
const otherVersionText = (name: string, got: string, allowed: string): string =>
  `adds ${name} at ${got}, but FLIGHT allowed ${allowed}`;

/**
 * Compares one group of direct dependencies. `ok` says whether an added entry's value fits the
 * named version. Each new named package goes into `added`.
 */
function compareDeps(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  where: string,
  allowed: readonly AllowedPackage[],
  ok: (value: unknown, version: string) => string | null,
  problems: string[],
  added: string[],
): void {
  for (const [name, value] of Object.entries(after)) {
    if (Object.hasOwn(before, name)) {
      if (!same(before[name], value)) problems.push(`changes ${name} in ${where}`);
      continue;
    }
    const pkg = allowed.find((p) => p.name === name);
    if (pkg === undefined) {
      problems.push(notAllowedText(name));
      continue;
    }
    const got = ok(value, pkg.version);
    if (got !== null) problems.push(otherVersionText(name, got, pkg.version));
    else if (!added.includes(name)) added.push(name);
  }
  for (const name of Object.keys(before)) {
    if (!Object.hasOwn(after, name)) problems.push(`removes ${name} from ${where}`);
  }
}

const parseObject = (text: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(text);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
};

/**
 * What a package.json change does: the named packages it adds, and every way it goes beyond them.
 * `before` is null for a new manifest. A spec is the version itself, or it with `^` or `~`.
 */
export function manifestChange(
  before: string | null,
  after: string,
  allowed: readonly AllowedPackage[],
): { problems: string[]; added: string[] } {
  const a = parseObject(after);
  const b = before === null ? {} : parseObject(before);
  if (a === null || b === null) return { problems: ["is not a JSON object"], added: [] };
  const problems: string[] = [];
  const added: string[] = [];
  const fields = new Set<string>(DEP_FIELDS);
  if (!same(withoutKeys(b, fields), withoutKeys(a, fields))) {
    problems.push("changes something besides the added dependencies");
  }
  const spec = (value: unknown, version: string): string | null =>
    value === version || value === `^${version}` || value === `~${version}` ? null : String(value);
  for (const field of DEP_FIELDS) {
    const bf = b[field] ?? {};
    const af = a[field] ?? {};
    if (!isObject(bf) || !isObject(af)) {
      problems.push(`has a ${field} that is not an object`);
      continue;
    }
    compareDeps(bf, af, field, allowed, spec, problems, added);
  }
  return { problems, added };
}

/**
 * What goes beyond the named packages in a parsed pnpm lockfile: each importer may only gain
 * direct entries for them, resolved at the named version (a peer suffix allowed). `packages` and
 * `snapshots` may only gain records (their dependencies, shown in the PR's lockfile diff): a
 * record already there keeps its resolution, integrity and the rest exactly.
 */
export function lockfileProblems(
  before: unknown,
  after: unknown,
  allowed: readonly AllowedPackage[],
): string[] {
  const b = before === null ? { importers: {} } : before;
  if (!isObject(b) || !isObject(after) || !isObject(after.importers) || !isObject(b.importers)) {
    return ["is not a pnpm lockfile"];
  }
  const problems: string[] = [];
  for (const key of new Set([...Object.keys(b), ...Object.keys(after)])) {
    if (!LOCK_GROWS.has(key) && !same(b[key], after[key])) problems.push(`changes ${key}`);
  }
  for (const key of LOCK_RECORDS) {
    const was = b[key] ?? {};
    const now = after[key] ?? {};
    if (!isObject(was) || !isObject(now)) {
      problems.push(`has ${key} that is not an object`);
      continue;
    }
    for (const [id, record] of Object.entries(was)) {
      if (!(id in now)) problems.push(`removes ${key} ${id}`);
      else if (!same(record, now[id])) problems.push(`changes ${key} ${id}`);
    }
  }
  const resolved = (value: unknown, version: string): string | null => {
    const v = isObject(value) ? value.version : value;
    if (typeof v !== "string") return String(v);
    return v === version || v.startsWith(`${version}(`) ? null : v;
  };
  const fields = new Set<string>(DEP_FIELDS);
  const added: string[] = [];
  for (const [id, imp] of Object.entries(after.importers)) {
    const was = id in b.importers ? b.importers[id] : {};
    if (!isObject(imp) || !isObject(was)) {
      problems.push(`has an importer ${id} that is not an object`);
      continue;
    }
    if (!same(withoutKeys(was, fields), withoutKeys(imp, fields))) {
      problems.push(`changes importer ${id}`);
    }
    for (const field of DEP_FIELDS) {
      const bf = was[field] ?? {};
      const af = imp[field] ?? {};
      if (!isObject(bf) || !isObject(af)) {
        problems.push(`has an importer ${id} ${field} that is not an object`);
        continue;
      }
      compareDeps(bf, af, `importer ${id} ${field}`, allowed, resolved, problems, added);
    }
  }
  for (const id of Object.keys(b.importers)) {
    if (!(id in after.importers)) problems.push(`removes importer ${id}`);
  }
  return problems;
}

export const ADDED_DEPENDENCIES_HEADING = "## Added dependencies";

const addedLine = (p: AllowedPackage): string =>
  `- \`${p.name}\` ${p.version}, licence ${p.licence}`;
/** One line as `addedLine` writes it: the name alone in a code span. */
const ADDED_LINE = /^- `([^`]+)` (\S+), licence (.+)$/;

/**
 * The PR body's section listing each added package, or null when none was added. A scoped name
 * is written whole, `@` included, in a code span: GitHub does not mention inside code, and
 * `inertAddedDependencies` lets these lines through the mention check.
 */
export function addedDependenciesSection(added: readonly AllowedPackage[]): string | null {
  if (added.length === 0) return null;
  return [ADDED_DEPENDENCIES_HEADING, "", ...added.map(addedLine)].join("\n");
}

/**
 * `body` for the mention check: in the Added dependencies section, each line as
 * `addedDependenciesSection` writes it has its scoped name's `@` dropped. Only the lines just
 * after the heading and its blank line are read, and only when the text before the heading is not
 * in an open code or HTML block, so each name sits in a code span on GitHub. Anything else, an
 * `@` after the name included, is left for the check to find.
 */
export function inertAddedDependencies(body: string): string {
  const lines = body.split("\n");
  const start = lines.indexOf(ADDED_DEPENDENCIES_HEADING);
  if (start < 0 || lines[start + 1] !== "") return body;
  if (unclosedMarkdown(lines.slice(0, start).join("\n"))) return body;
  for (let i = start + 2; i < lines.length; i++) {
    const m = ADDED_LINE.exec(lines[i] ?? "");
    const [, name = "", version = "", licence = ""] = m ?? [];
    const fits =
      m !== null && NPM_NAME.test(name) && EXACT_VERSION.test(version) && LICENCE.test(licence);
    if (!fits) break;
    lines[i] = addedLine({ name: name.replace(/^@/, ""), version, licence });
  }
  return lines.join("\n");
}

const packageList = (packages: readonly AllowedPackage[]): string =>
  packages.map((p) => `${p.name} ${p.version} (${p.licence})`).join(", ");

/** FLIGHT's logged decision for an allowance. */
export const dependencyDecisionText = (
  call: string,
  packages: readonly AllowedPackage[],
  files: readonly string[],
): string => `Allowed ${call} to add ${packageList(packages)} in ${files.join(", ")}`;
export const dependencyAllowedText = (
  call: string,
  packages: readonly AllowedPackage[],
  files: readonly string[],
): string =>
  `${dependencyDecisionText(call, packages, files)}, for this run only. ${call} commits them with mc commit. Recorded in Decided without you.`;
export const dependencyFileRefusedText = (path: string, why: string): string =>
  `Not allowed: ${path}: ${why}.`;

/** The commit tool's refusal of an allowed file whose change goes beyond the allowance. */
export const dependencyChangeText = (path: string, problems: readonly string[]): string =>
  `Not committed: ${path} ${problems.join("; ")}. Only the packages FLIGHT allowed may be added; ask FLIGHT to allow more with mc ask_flight.`;
