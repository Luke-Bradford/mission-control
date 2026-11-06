/**
 * External links are rendered only for https://github.com/... URLs from the API; anything else
 * (javascript:, data:, http:, another host) is shown as plain text with no href.
 */
const OWNER_NAME = /^[\w.-]+\/[\w.-]+$/;

/**
 * The GitHub page of an issue or a pull request, from a repo's configured `owner/name`; null when
 * that is not an owner and a name (it is config, but it becomes part of a URL).
 */
export function githubItemHref(
  github: string,
  kind: "issue" | "pr",
  number: number,
): string | null {
  if (!OWNER_NAME.test(github) || github.split("/").some((p) => p === "." || p === "..")) {
    return null;
  }
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return githubHref(`https://github.com/${github}/${kind === "pr" ? "pull" : "issues"}/${number}`);
}

const ITEM_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/\d+$/i;

/**
 * The `owner/name` of the repo a GitHub pull request or issue URL
 * (`https://github.com/<owner>/<name>/pull/<n>` or `/issues/<n>`) belongs to; null for any other
 * URL, including one with a port, userinfo or dot segments (checked on the text as given, before
 * the URL parser resolves them).
 */
export function githubRepoOfUrl(url: string): string | null {
  const repo = ITEM_URL.exec(url)?.[1];
  if (repo === undefined || repo.split("/").some((p) => p === "." || p === "..")) return null;
  return githubHref(url) === null ? null : repo;
}

export function githubHref(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== "github.com" || u.username || u.password) {
    return null;
  }
  return u.href;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The URL of a link the operator may open from a brief: https, http only on a loopback host, or a
 * same-origin path starting with one `/`. Anything with credentials, `file:`, `javascript:`,
 * `data:`, `blob:`, `//host` or that does not parse is refused (null).
 */
export function openableHref(url: string): string | null {
  const text = url.trim();
  if (text === "" || text.includes("\\") || [...text].some((c) => c <= "\u001f" || c === "\u007f"))
    return null;
  if (text.startsWith("/")) {
    if (text.startsWith("//")) return null;
    return text;
  }
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol === "https:") return u.href;
  if (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname)) return u.href;
  return null;
}

/** The scheme of a refused link, for the refusal text (`file`), or "that kind of" when none parses. */
export function schemeOf(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim());
  return m?.[1]?.toLowerCase() ?? "these";
}
