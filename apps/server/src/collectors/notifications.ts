import { createHash } from "node:crypto";
import type { AttentionBrief, PersonMessage } from "@mc/core";
import { GITHUB_COLLECTOR_PREFIX, type RepoId, startOfLocalDay } from "@mc/core";
import type { CcConfig } from "../config.ts";
import type { NotificationRead, NotificationRow, Store } from "../store.ts";
import { errMsg, GqlTransportError, HTTP_TIMEOUT_MS, isObj, ms, ssoRefusal } from "./github.ts";

export const NOTIFICATIONS_COLLECTOR = `${GITHUB_COLLECTOR_PREFIX}.notifications`;
export const NOTIFICATIONS_MODIFIED_SETTING = "github.notifications.lastModified";
export const NOTIFICATIONS_URL = "https://api.github.com/notifications?per_page=50";
export const NOTIFICATIONS_MAX_PAGES = 5;
export const NOTIFICATIONS_KEEP_MS = 7 * 86_400_000;
/** A thread whose latest comment is older than this reads as old. */
export const OLD_THREAD_MS = 7 * 86_400_000;
export const SNIPPET_MAX = 280;
export const NO_OPEN_THREAD = "no such open thread";

const API_ORIGIN = "https://api.github.com/";
const WEB_ORIGIN = "https://github.com/";

/** The notification reasons that mean a person is waiting on the operator. */
export const PERSON_REASONS = [
  "mention",
  "team_mention",
  "review_requested",
  "author",
  "comment",
] as const;

const REASON_TEXT: Record<(typeof PERSON_REASONS)[number], string> = {
  mention: "mentioned you",
  team_mention: "mentioned your team",
  review_requested: "asked for your review",
  author: "commented on your issue",
  comment: "replied in a thread you commented on",
};

export const HANDLED_HOW_TEXT = {
  marked: "marked handled",
  read: "read on GitHub",
  replied: "replied on GitHub",
  copied: "reply copied for Teams",
  flight: "with FLIGHT",
} as const;

/** Source text stays untrusted display content; the digest binds a draft to that exact content. */
export function sourceMessage(
  body: unknown,
  fallbackUrl: string,
  fallbackAt: number,
): PersonMessage | undefined {
  if (
    !isObj(body) ||
    typeof body.body !== "string" ||
    (typeof body.id !== "number" && typeof body.id !== "string")
  )
    return undefined;
  const author = isObj(body.user) && typeof body.user.login === "string" ? body.user.login : null;
  const url =
    typeof body.html_url === "string" && body.html_url.startsWith(WEB_ORIGIN)
      ? body.html_url
      : fallbackUrl;
  return {
    source: {
      kind: "github",
      messageId: String(body.id),
      revision: createHash("sha256")
        .update(JSON.stringify([body.id, body.body, body.updated_at, author, url]))
        .digest("hex"),
    },
    author,
    at: typeof body.created_at === "string" ? ms(body.created_at) : fallbackAt,
    text: body.body.slice(0, 12_000),
    url,
  };
}

/** Only a configured thread's issue/PR or comment endpoint can be used for source reads. */
export function sourceReadUrl(repo: string, url: string): boolean {
  const match =
    /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/((?:issues|pulls)\/(?:comments\/)?[1-9]\d*)$/.exec(
      url,
    );
  return match !== null && match[1]?.toLowerCase() === repo.toLowerCase();
}

export type CatchUpKind = "new" | "follow-up" | "old";

/** One GET against api.github.com: the status, headers and parsed body (null for a 304). */
export type Rest = (
  url: string,
  headers?: Record<string, string>,
) => Promise<{ status: number; headers: Headers; body: unknown }>;

/**
 * REST GETs over plain fetch, for api.github.com only: a URL elsewhere is refused before any
 * request, so the token cannot be sent anywhere else. The token never appears in an error.
 */
export function makeRest(token: string, doFetch: typeof fetch = fetch): Rest {
  return async (url, headers = {}) => {
    if (!url.startsWith(API_ORIGIN))
      throw new Error("github: refused a URL outside api.github.com");
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "GET",
        headers: {
          ...headers,
          Authorization: `bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "mission-control",
        },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch {
      throw new GqlTransportError("github: request failed", null);
    }
    if (res.status === 304) return { status: 304, headers: res.headers, body: null };
    if (!res.ok) {
      throw new GqlTransportError(
        `github: HTTP ${res.status}`,
        res.status,
        res.headers.get("x-github-sso"),
      );
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error("github: response was not JSON");
    }
    return { status: res.status, headers: res.headers, body };
  };
}

type Thread = Pick<NotificationRow, "id" | "updatedAt">;

export const personKey = (n: Thread): string => `person:${n.id}:${n.updatedAt}`;

export function parsePersonKey(key: string): Thread | null {
  const m = /^person:(\d{1,20}):(\d{1,15})$/.exec(key);
  return m ? { id: m[1] as string, updatedAt: Number(m[2]) } : null;
}

/** Still waiting on the operator: unread on GitHub, and not handled since its latest comment. */
export const notificationOpen = (
  n: Pick<NotificationRow, "unread" | "handledThrough" | "updatedAt">,
): boolean => n.unread && (n.handledThrough === null || n.updatedAt > n.handledThrough);

export function reasonText(n: Pick<NotificationRow, "reason" | "subjectType">): string {
  if (n.reason === "author" && n.subjectType === "PullRequest") return "commented on your PR";
  return REASON_TEXT[n.reason as keyof typeof REASON_TEXT] ?? n.reason;
}

export const personText = (
  n: Pick<NotificationRow, "reason" | "subjectType" | "author" | "repoId" | "number" | "title">,
): string =>
  `${n.author ?? "Someone"} ${reasonText(n)}: ${n.repoId}${n.number === null ? "" : `#${n.number}`} ${n.title}`;

export function catchUpKind(
  n: Pick<NotificationRow, "updatedAt" | "lastReadAt" | "handledAt">,
  now: number,
): CatchUpKind {
  if (now - n.updatedAt > OLD_THREAD_MS) return "old";
  return n.lastReadAt !== null || n.handledAt !== null ? "follow-up" : "new";
}

/** A comment's text as one short line: whitespace collapsed, cut at SNIPPET_MAX code points. */
export function snippetOf(body: unknown): string | null {
  if (typeof body !== "string") return null;
  const text = body.replace(/\s+/g, " ").trim();
  if (text === "") return null;
  const chars = [...text];
  return chars.length > SNIPPET_MAX ? `${chars.slice(0, SNIPPET_MAX - 1).join("")}…` : text;
}

export interface PersonThreadView {
  key: string;
  id: string;
  repoId: RepoId;
  /** The repo's `owner/name`. */
  github: string;
  subjectType: string;
  number: number | null;
  title: string;
  reason: string;
  reasonText: string;
  author: string | null;
  snippet: string | null;
  url: string;
  updatedAt: number;
  firstSeenAt: number;
  catchUp: CatchUpKind;
  message?: PersonMessage;
  history?: PersonMessage[];
  brief?: AttentionBrief;
}

export interface HandledThreadView {
  id: string;
  repoId: RepoId;
  number: number | null;
  title: string;
  author: string | null;
  how: string;
  at: number;
  firstSeenAt: number;
}

export interface NotificationsView {
  open: PersonThreadView[];
  handledToday: HandledThreadView[];
}

/** The open person threads of configured repos, and the ones closed since the operator's local midnight. */
export function notificationsView(config: CcConfig, store: Store, now: number): NotificationsView {
  const github = new Map(config.repos.map((r) => [r.id, r.github]));
  const briefs = store.briefs();
  const dayStart = startOfLocalDay(now, config.operator.timezone);
  const open: PersonThreadView[] = [];
  const handledToday: HandledThreadView[] = [];
  for (const n of store.notifications()) {
    const repo = github.get(n.repoId);
    if (repo === undefined) continue;
    if (notificationOpen(n)) {
      open.push({
        key: personKey(n),
        id: n.id,
        repoId: n.repoId,
        github: repo,
        subjectType: n.subjectType,
        number: n.number,
        title: n.title,
        reason: n.reason,
        reasonText: reasonText(n),
        author: n.author,
        snippet: n.snippet,
        url: n.url,
        updatedAt: n.updatedAt,
        firstSeenAt: n.firstSeenAt,
        catchUp: catchUpKind(n, now),
        message: n.message,
        history: n.history,
        brief: briefs.get(personKey(n)),
      });
    } else if (n.handledAt !== null && n.handledHow !== null && n.handledAt >= dayStart) {
      handledToday.push({
        id: n.id,
        repoId: n.repoId,
        number: n.number,
        title: n.title,
        author: n.author,
        how: HANDLED_HOW_TEXT[n.handledHow],
        at: n.handledAt,
        firstSeenAt: n.firstSeenAt,
      });
    }
  }
  return { open, handledToday: handledToday.sort((a, b) => b.at - a.at) };
}

const NEXT_LINK = /<([^>]+)>;\s*rel="next"/;
const SUBJECT_URL =
  /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(issues|pulls)\/(\d{1,15})$/;

interface Kept {
  id: string;
  repoId: RepoId;
  subjectType: string;
  title: string;
  reason: string;
  updatedAt: number;
  lastReadAt: number | null;
  number: number | null;
  fallbackUrl: string;
  commentUrl: string | null;
}

/** The threads worth a person item: configured repo, a person reason, an issue or PR, a sane id. */
function keepThreads(raw: unknown[], repos: CcConfig["repos"]): Kept[] {
  const byGithub = new Map(repos.map((r) => [r.github.toLowerCase(), r]));
  const kept: Kept[] = [];
  for (const t of raw) {
    if (!isObj(t) || !isObj(t.repository) || !isObj(t.subject)) continue;
    const id = typeof t.id === "string" ? t.id : "";
    const full = typeof t.repository.full_name === "string" ? t.repository.full_name : "";
    const repo = byGithub.get(full.toLowerCase());
    const { type, title, url, latest_comment_url: latest } = t.subject;
    if (
      repo === undefined ||
      !/^\d{1,20}$/.test(id) ||
      !PERSON_REASONS.some((r) => r === t.reason) ||
      (type !== "Issue" && type !== "PullRequest") ||
      typeof title !== "string"
    ) {
      continue;
    }
    const m = typeof url === "string" ? SUBJECT_URL.exec(url) : null;
    if (m && m[1]?.toLowerCase() !== repo.github.toLowerCase()) continue;
    kept.push({
      id,
      repoId: repo.id,
      subjectType: type,
      title,
      reason: t.reason as string,
      updatedAt: ms(t.updated_at),
      lastReadAt: typeof t.last_read_at === "string" ? ms(t.last_read_at) : null,
      number: m ? Number(m[3]) : null,
      fallbackUrl: m
        ? `${WEB_ORIGIN}${m[1]}/${m[2] === "pulls" ? "pull" : "issues"}/${m[3]}`
        : `${WEB_ORIGIN}${repo.github}`,
      commentUrl: typeof latest === "string" ? latest : typeof url === "string" ? url : null,
    });
  }
  return kept;
}

/**
 * Read-only refresh of the operator's unread GitHub notifications into the store. Never throws: a
 * failure keeps the stored rows and is recorded in collector status. True `changed` when a row did.
 */
export async function collectNotifications(
  repos: CcConfig["repos"],
  store: Store,
  rest: Rest,
  now: number,
): Promise<{ changed: boolean }> {
  try {
    const modified = store.getSetting(NOTIFICATIONS_MODIFIED_SETTING);
    // Last-Modified tracks new activity, not reads: while a thread is unread here, a 304 could hide
    // that it was read on GitHub, so the conditional header goes only when nothing is unread.
    const anyUnread = store.notifications().some((n) => n.unread);
    const first = await rest(
      NOTIFICATIONS_URL,
      modified === null || anyUnread ? undefined : { "If-Modified-Since": modified },
    );
    if (first.status === 304) {
      store.setStatus(NOTIFICATIONS_COLLECTOR, true, null);
      return { changed: false };
    }
    const raw: unknown[] = [];
    let page = first;
    let truncated = false;
    for (let n = 1; ; n++) {
      if (!Array.isArray(page.body)) throw new Error("unexpected notifications response");
      raw.push(...page.body);
      const next = NEXT_LINK.exec(page.headers.get("link") ?? "")?.[1];
      if (next === undefined) break;
      if (n >= NOTIFICATIONS_MAX_PAGES) {
        truncated = true;
        break;
      }
      page = await rest(next);
    }

    let misses = 0;
    const rows: NotificationRead[] = [];
    for (const k of keepThreads(raw, repos)) {
      const stored = store.notification(k.id);
      let author: string | null;
      let snippet: string | null;
      let url: string;
      let message = stored?.message;
      let history = stored?.history;
      if (stored !== null && stored.updatedAt === k.updatedAt && stored.message) {
        ({ author, snippet, url } = stored);
      } else {
        author = null;
        snippet = null;
        url = k.fallbackUrl;
        try {
          if (k.commentUrl === null) throw new Error("no comment url");
          const repo = repos.find((r) => r.id === k.repoId);
          if (!repo) throw new Error("unknown repo");
          if (!sourceReadUrl(repo.github, k.commentUrl)) throw new Error("invalid source URL");
          const { body } = await rest(k.commentUrl);
          if (!isObj(body)) throw new Error("unexpected comment response");
          author = isObj(body.user) && typeof body.user.login === "string" ? body.user.login : null;
          snippet = snippetOf(body.body);
          message = sourceMessage(body, k.fallbackUrl, k.updatedAt);
          if (typeof body.html_url === "string" && body.html_url.startsWith(WEB_ORIGIN)) {
            url = body.html_url;
          }
        } catch {
          message = undefined;
          history = undefined;
          misses++;
        }
        if (message && k.number !== null) {
          history = [];
          const latest = message;
          const repo = repos.find((r) => r.id === k.repoId);
          const kinds = k.subjectType === "PullRequest" ? ["issues", "pulls"] : ["issues"];
          for (const kind of kinds) {
            try {
              if (!repo) throw new Error("unknown repo");
              const listUrl = `${API_ORIGIN}repos/${repo.github}/${kind}/${k.number}/comments?per_page=100`;
              let page = await rest(listUrl);
              const last = /<([^>]+)>;\s*rel="last"/.exec(page.headers.get("link") ?? "")?.[1];
              if (last?.startsWith(`${listUrl}&page=`)) page = await rest(last);
              if (Array.isArray(page.body))
                history.push(
                  ...page.body
                    .map((b) => sourceMessage(b, k.fallbackUrl, k.updatedAt))
                    .filter(
                      (m): m is PersonMessage =>
                        m !== undefined &&
                        m.source.messageId !== latest.source.messageId &&
                        m.at <= latest.at,
                    ),
                );
            } catch {
              // Latest-message data remains usable when earlier comments cannot be fetched.
            }
          }
          history = history.sort((a, b) => a.at - b.at).slice(-20);
        }
      }
      rows.push({
        id: k.id,
        repoId: k.repoId,
        subjectType: k.subjectType,
        title: k.title,
        number: k.number,
        reason: k.reason,
        url,
        author,
        snippet,
        updatedAt: k.updatedAt,
        lastReadAt: k.lastReadAt,
        message,
        history,
      });
    }

    const changed = store.upsertNotifications(rows, !truncated, now);
    store.pruneNotifications(now - NOTIFICATIONS_KEEP_MS);
    const lastModified = first.headers.get("last-modified");
    if (!truncated && lastModified !== null) {
      store.setSetting(NOTIFICATIONS_MODIFIED_SETTING, lastModified);
    }
    const notes = [
      ...(truncated
        ? [`truncated: more than ${NOTIFICATIONS_MAX_PAGES} pages of notifications`]
        : []),
      ...(misses > 0 ? [`could not read the latest comment of ${misses} thread(s)`] : []),
    ];
    store.setStatus(NOTIFICATIONS_COLLECTOR, true, notes.length > 0 ? notes.join("; ") : null);
    return { changed };
  } catch (e) {
    store.setStatus(
      NOTIFICATIONS_COLLECTOR,
      false,
      `${ssoRefusal(e, "GitHub") ?? errMsg(e)} at ${new Date(now).toISOString()}`,
    );
    return { changed: false };
  }
}
