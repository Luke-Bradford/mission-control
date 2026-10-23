import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { CcConfig, TeamsConfig } from "../config.ts";
import type { Store } from "../store.ts";
import { isObj } from "./github.ts";

export const TEAMS_COLLECTOR = "teams";
const GRAPH = "https://graph.microsoft.com/v1.0/";
const STATE = "teams.poll";
const MAX_PAGES = 5;
const PERMISSION = "not permitted with this login; needs Chat.Read, ChannelMessage.Read.All";

type Selection = TeamsConfig["selected"][number];
interface PollState {
  blocked?: string;
  retryAt?: number;
  failures?: number;
  note?: string;
}
export interface TeamsDeps {
  fetch?: typeof fetch;
  token?: (argv: string[]) => Promise<string>;
}

/** Local configuration alone chooses the executable; argv never goes through a shell. */
export function teamsToken(argv: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      argv[0] as string,
      argv.slice(1),
      { timeout: 10_000, maxBuffer: 16_384, encoding: "utf8" },
      (error, stdout) => {
        const token = stdout.trim();
        if (error || !token || /\s/.test(token)) reject(new Error("Teams token command failed"));
        else resolve(token);
      },
    );
  });
}

function state(store: Store): PollState {
  try {
    return JSON.parse(store.getSetting(STATE) ?? "{}");
  } catch {
    return {};
  }
}

export function teamsStatus(config: CcConfig, store: Store) {
  const teams = config.sources?.teams;
  const poll = state(store);
  return {
    phase: 5,
    lane: "work",
    readOnly: true,
    enabled: !!teams?.token_command,
    selected: teams?.selected ?? [],
    note: !teams?.token_command
      ? "Set sources.teams.token_command in local config to enable Microsoft Teams."
      : poll.blocked
        ? PERMISSION
        : (poll.note ?? "Polls on a timer. Mission Control never posts to Teams."),
    retryAt: poll.retryAt ?? null,
  };
}

function path(source: Selection): string {
  const id = encodeURIComponent(source.id);
  return source.kind === "chat"
    ? `${GRAPH}chats/${id}/messages`
    : `${GRAPH}teams/${encodeURIComponent(source.teamId ?? "")}/channels/${id}/messages`;
}
const termPattern = (term: string) => {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, "giu");
};

const contains = (text: string, term: string) => termPattern(term).test(text);

function matches(text: string, mentions: unknown, config: TeamsConfig, source: Selection): boolean {
  if (config.aliases.some((alias) => contains(text, alias))) return true;
  if (
    Array.isArray(mentions) &&
    mentions.some((m) => {
      if (!isObj(m) || !isObj(m.mentioned) || !isObj(m.mentioned.user)) return false;
      const user = m.mentioned.user;
      return config.aliases.some((alias) =>
        [user.id, user.displayName].some(
          (v) => typeof v === "string" && v.toLowerCase() === alias.toLowerCase(),
        ),
      );
    })
  )
    return true;
  if (config.refs.some((ref) => contains(text, ref))) return true;
  return config.areas.some(
    (area) =>
      area.repoId === source.repoId &&
      area.words.some((word) =>
        [...text.matchAll(termPattern(word))].some((match) =>
          area.keywords.some((keyword) =>
            contains(
              text.slice(Math.max(0, match.index - 120), match.index + match[0].length + 120),
              keyword,
            ),
          ),
        ),
      ),
  );
}

/** Read-only work intake. Remote text and provider errors never become commands or error details. */
export async function collectTeams(
  config: CcConfig,
  store: Store,
  now: number,
  deps: TeamsDeps = {},
): Promise<{ changed: boolean }> {
  const teams = config.sources?.teams;
  if (!teams?.token_command) return { changed: false };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(teams.token_command))
    .digest("hex");
  const poll = state(store);
  if (poll.blocked === fingerprint || (poll.retryAt ?? 0) > now) return { changed: false };
  let changed = false;
  let token: string;
  let note: string | undefined;
  try {
    token = await (deps.token ?? teamsToken)(teams.token_command);
    for (const source of teams.selected) {
      if (source.lane !== "work" || !config.repos.some((r) => r.id === source.repoId)) continue;
      const base = path(source);
      const key = `teams.watermark:${source.kind}:${source.id}${source.teamId ? `:${source.teamId}` : ""}`;
      let watermark = store.getSetting(`${key}:pending`) || store.getSetting(key) || "";
      const committed = store.getSetting(key) ?? "";
      const cursorKey = key.replace("watermark", "cursor");
      const first = new URL(
        `${base}?$top=50${source.kind === "channel" ? "&$expand=replies" : ""}`,
      );
      if (source.kind === "chat" && committed) {
        first.searchParams.set("$orderby", "lastModifiedDateTime desc");
        first.searchParams.set(
          "$filter",
          `lastModifiedDateTime gt ${new Date(Date.parse(committed) - 1).toISOString()}`,
        );
      }
      const saved = store.getSetting(cursorKey);
      const pending: string[] = saved ? JSON.parse(saved) : [first.href];
      for (let page = 0; pending.length > 0 && page < MAX_PAGES; page++) {
        const url = pending.shift() as string;
        const parsed = new URL(url);
        if (
          parsed.origin !== "https://graph.microsoft.com" ||
          !(
            parsed.pathname === new URL(base).pathname ||
            (source.kind === "channel" &&
              parsed.pathname.startsWith(`${new URL(base).pathname}/`) &&
              /^\/[^/]+\/replies$/.test(parsed.pathname.slice(new URL(base).pathname.length)))
          ) ||
          parsed.username ||
          parsed.password
        )
          throw new Error("Teams refused pagination URL");
        const get = () =>
          (deps.fetch ?? fetch)(url as string, {
            method: "GET",
            redirect: "error",
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15_000),
          });
        let res = await get();
        if (res.status === 401) {
          token = await (deps.token ?? teamsToken)(teams.token_command);
          res = await get();
        }
        if (res.status === 403) {
          store.setSetting(STATE, JSON.stringify({ blocked: fingerprint, note: PERMISSION }));
          store.setStatus(TEAMS_COLLECTOR, false, PERMISSION);
          return { changed };
        }
        if (!res.ok) {
          const failures = (poll.failures ?? 0) + 1;
          const retry = res.headers.get("retry-after");
          const seconds = Number(retry);
          const retryAt =
            retry && !Number.isFinite(seconds) ? Date.parse(retry) : now + seconds * 1000;
          store.setSetting(
            STATE,
            JSON.stringify({
              failures,
              retryAt: Math.max(
                now + Math.min(30 * 60_000, 30_000 * 2 ** Math.min(failures, 6)),
                Number.isFinite(retryAt) ? retryAt : 0,
              ),
              note: `Teams HTTP ${res.status}; will retry`,
            }),
          );
          store.setStatus(TEAMS_COLLECTOR, false, `Teams HTTP ${res.status}; will retry`);
          return { changed };
        }
        const body: unknown = await res.json();
        if (!isObj(body) || !Array.isArray(body.value)) throw new Error("Teams invalid response");
        const messages = body.value.slice(0, 50).flatMap((raw) => {
          if (source.kind !== "channel" || !isObj(raw)) return [raw];
          if (typeof raw["replies@odata.nextLink"] === "string")
            pending.push(raw["replies@odata.nextLink"]);
          return [raw, ...(Array.isArray(raw.replies) ? raw.replies.slice(0, 200) : [])];
        });
        for (const raw of messages) {
          if (
            !isObj(raw) ||
            typeof raw.id !== "string" ||
            !isObj(raw.body) ||
            typeof raw.body.content !== "string" ||
            raw.deletedDateTime
          )
            continue;
          const text = raw.body.content
            .replace(/<[^>]*>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .slice(0, 12_000);
          const modified =
            typeof raw.lastModifiedDateTime === "string"
              ? raw.lastModifiedDateTime
              : raw.createdDateTime;
          if (typeof modified !== "string" || !Number.isFinite(Date.parse(modified))) continue;
          if (modified > watermark) watermark = modified;
          if (!matches(text, raw.mentions, teams, source)) continue;
          let web: URL;
          try {
            web = new URL(String(raw.webUrl));
          } catch {
            continue;
          }
          if (web.origin !== "https://teams.microsoft.com" || web.username || web.password)
            continue;
          const identity = JSON.stringify([
            source.kind,
            source.teamId,
            source.id,
            raw.replyToId,
            raw.id,
          ]);
          const messageId = createHash("sha256").update(identity).digest("hex");
          // Numeric local ids keep existing person keys usable; metadata retains the Graph ids.
          const id = BigInt(`0x${messageId.slice(0, 16)}`).toString();
          const revision = createHash("sha256")
            .update(JSON.stringify([modified, text, raw.mentions, raw.from, web.href]))
            .digest("hex");
          const previous = store.notification(id);
          if (previous?.message?.source.revision === revision) continue;
          const at = Math.max(Date.parse(modified), (previous?.updatedAt ?? 0) + 1);
          const author =
            isObj(raw.from) && isObj(raw.from.user) && typeof raw.from.user.displayName === "string"
              ? raw.from.user.displayName
              : null;
          changed =
            store.upsertNotifications(
              [
                {
                  id,
                  repoId: source.repoId,
                  subjectType: "Teams",
                  title: source.name,
                  number: null,
                  reason: "mentioned you",
                  url: web.href,
                  author,
                  snippet: text.slice(0, 280),
                  updatedAt: at,
                  lastReadAt: null,
                  message: {
                    source: {
                      kind: "teams",
                      messageId,
                      revision,
                    },
                    teams: {
                      kind: source.kind,
                      id: source.id,
                      teamId: source.teamId,
                      name: source.name,
                      messageId: raw.id,
                    },
                    author,
                    at,
                    text,
                    url: web.href,
                  },
                },
              ],
              false,
              now,
            ) || changed;
        }
        if (typeof body["@odata.nextLink"] === "string") pending.push(body["@odata.nextLink"]);
        if (pending.length > 0 && page === MAX_PAGES - 1)
          note = "Teams pagination limit reached; continues next poll";
      }
      store.setSetting(cursorKey, pending.length > 0 ? JSON.stringify(pending) : "");
      store.setSetting(`${key}:pending`, pending.length > 0 ? watermark : "");
      if (pending.length === 0) store.setSetting(key, watermark);
    }
    store.setSetting(STATE, JSON.stringify({ note }));
    store.setStatus(TEAMS_COLLECTOR, true, note ?? null);
  } catch {
    store.setSetting(
      STATE,
      JSON.stringify({
        retryAt: now + 60_000,
        note: "Teams read or token command failed; will retry",
      }),
    );
    store.setStatus(TEAMS_COLLECTOR, false, "Teams read or token command failed; will retry");
  }
  return { changed };
}
