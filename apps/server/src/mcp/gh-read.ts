import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLIGHT_GH_QUERY_FILTERS,
  FLIGHT_GH_READ_MAX,
  GH_READ_CUT,
  GH_READ_UNTRUSTED,
} from "@mc/core";
import { cleanText } from "../clean.ts";
import type { GhRunner } from "./gh.ts";

const JOB_LOG_PATH = /^actions\/jobs\/[1-9]\d*\/logs$/;
const REPO_PATHS = [
  /^pulls(?:\/[1-9]\d*(?:\/(?:files|commits|comments|reviews(?:\/[1-9]\d*(?:\/comments)?)?))?|\/comments(?:\/[1-9]\d*)?)?$/,
  /^issues(?:\/[1-9]\d*(?:\/comments)?|\/comments(?:\/[1-9]\d*)?)?$/,
  /^commits(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/comments)?)?$/,
  /^actions\/runs(?:\/[1-9]\d*(?:\/jobs|\/attempts\/[1-9]\d*(?:\/jobs)?)?)?$/,
  /^actions\/jobs\/[1-9]\d*$/,
  JOB_LOG_PATH,
];
const REF = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;
const HEAD = new RegExp(`^[A-Za-z0-9-]+:${REF.source.slice(1)}`);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z$/;
const QUERY = new Map([
  ["page", /^[1-9]\d{0,5}$/],
  ["per_page", /^(?:[1-9]\d?|100)$/],
  ...FLIGHT_GH_QUERY_FILTERS.map((key): [string, RegExp] => [
    key,
    key === "since" || key === "until"
      ? ISO_TIMESTAMP
      : key === "head"
        ? HEAD
        : /^[A-Za-z0-9_][A-Za-z0-9._/+-]*$/,
  ]),
]);

/** No decoding or URL resolution: only literal repo paths and known read filters reach gh. */
export function githubReadPath(path: string, repo: string): string | null {
  if (/[\s%\\#]/.test(path) || /:(?:owner|repo|branch)\b/i.test(path)) return null;
  const canonical = path.startsWith("/") ? path.slice(1) : path;
  const [endpoint = "", query, extra] = canonical.split("?");
  if (
    extra !== undefined ||
    endpoint.split("/").some((part) => part === "." || part === ".." || part === "")
  )
    return null;
  if (query !== undefined) {
    const seen = new Set<string>();
    for (const pair of query.split("&")) {
      const [key = "", value = "", rest] = pair.split("=");
      if (rest !== undefined || seen.has(key) || !QUERY.get(key)?.test(value)) return null;
      if (key === "since" || key === "until") {
        const day = value.slice(0, 10);
        const date = new Date(`${day}T00:00:00Z`);
        if (
          !Number.isFinite(Date.parse(value)) ||
          !Number.isFinite(date.getTime()) ||
          date.toISOString().slice(0, 10) !== day
        )
          return null;
      }
      seen.add(key);
    }
  }
  if (endpoint === "rate_limit") return query === undefined ? canonical : null;
  const prefix = `repos/${repo}/`;
  if (repo.split("/").length !== 2 || !endpoint.startsWith(prefix)) return null;
  const resource = endpoint.slice(prefix.length);
  if (resource.startsWith("compare/")) {
    const refs = resource.slice("compare/".length).split("...");
    if (refs.length !== 2 || refs.some((ref) => !REF.test(ref) || ref.includes(".."))) return null;
  } else if (
    resource.includes("..") ||
    resource.split("/").some((part) => part === "." || part === "") ||
    !REPO_PATHS.some((pattern) => pattern.test(resource))
  )
    return null;
  return canonical;
}

/** Bound API output to 4 MiB, with more room for job logs before taking their tail. */
export const GH_READ_MAX_BUFFER = 4 * 1024 * 1024;
export const GH_READ_JOB_LOG_MAX_BUFFER = 16 * 1024 * 1024;

type GithubReadResult = { ok: true; text: string } | { ok: false; notFound: boolean };
const unavailable: GithubReadResult = { ok: false, notFound: false };

function redactKnown(text: string, known: readonly string[]): string {
  let output = text;
  for (const secret of known) {
    if (secret !== "") output = output.split(secret).join("[redacted]");
  }
  return output;
}

/** The token exists only in memory and the API child's environment; neither failure stream escapes. */
export async function isolatedGithubRead(
  gh: GhRunner,
  path: string,
  known: readonly string[],
  repo: string,
  log?: (line: string) => void,
): Promise<GithubReadResult> {
  const endpoint = path.replace(/^\//, "").split("?")[0] ?? "";
  const repoPrefix = `repos/${repo}/`;
  const isJobLog =
    endpoint.startsWith(repoPrefix) && JOB_LOG_PATH.test(endpoint.slice(repoPrefix.length));
  let dir: string | undefined;
  let step = "setup";
  try {
    dir = await mkdtemp(join(tmpdir(), "mc-gh-read-"));
    step = "gh auth token";
    const auth = await gh(["auth", "token", "--hostname", "github.com"], { cwd: dir });
    const token = auth.stdout.trim();
    if (auth.code !== 0 || token === "") {
      log?.(`mc gh_read: gh auth token failed (${String(auth.code)})`);
      return unavailable;
    }
    step = "setup";
    const cwd = join(dir, "work");
    const config = join(dir, "config");
    await mkdir(cwd, { mode: 0o700 });
    await mkdir(config, { mode: 0o700 });
    step = "gh api";
    const result = await gh(["api", "--hostname", "github.com", "--method", "GET", path], {
      cwd,
      env: {
        HOME: dir,
        GH_CONFIG_DIR: config,
        GH_TOKEN: token,
        GH_HOST: "github.com",
        GH_REPO: repo,
        GH_TELEMETRY: "0",
      },
      maxBuffer: isJobLog ? GH_READ_JOB_LOG_MAX_BUFFER : GH_READ_MAX_BUFFER,
    });
    if (result.code !== 0) {
      log?.(`mc gh_read: gh api failed (${String(result.code)})`);
      try {
        const body: unknown = JSON.parse(result.stdout);
        if (
          body !== null &&
          typeof body === "object" &&
          "status" in body &&
          (body.status === "404" || body.status === 404)
        )
          return { ok: false, notFound: true };
      } catch {
        /* Failure bodies need not be JSON. */
      }
      return unavailable;
    }
    step = "clean";
    const secrets = [token, ...known];
    // Remove whole known credentials before slicing, including multiline credentials.
    let output = redactKnown(result.stdout, secrets);
    const max = FLIGHT_GH_READ_MAX - GH_READ_UNTRUSTED.length;
    let prefix = "";
    if (isJobLog && output.length > max) {
      prefix = `${GH_READ_CUT}\n`;
      output = output.slice(-(max - prefix.length));
      // Keep whole log lines when possible, just like read_ci_log.
      const nl = output.indexOf("\n");
      if (nl !== -1) output = output.slice(nl + 1);
      else {
        if (/^[\uDC00-\uDFFF]/.test(output)) output = output.slice(1);
        // A cut without a newline can start inside a credential, hiding its identifying prefix.
        output = output.replace(/^[A-Za-z0-9._+/=-]+/, "");
      }
    }
    output = cleanText(output, max - prefix.length, GH_READ_CUT);
    // Cleaning can reveal short known secrets concealed by terminal/control characters.
    output = redactKnown(output, secrets);
    return { ok: true, text: prefix + cleanText(output, max - prefix.length, GH_READ_CUT) };
  } catch {
    log?.(`mc gh_read: ${step} failed (null)`);
    return unavailable;
  } finally {
    if (dir !== undefined) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        log?.("mc gh_read: cleanup failed (null)");
      }
    }
  }
}
