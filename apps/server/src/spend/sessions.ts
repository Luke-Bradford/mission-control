import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  SESSION_SPEND_WEEK_DAYS,
  type SessionSpendCell,
  type SessionSpendRow,
  type SessionSpendSplit,
  type SpendCell,
  type SpendTokens,
  startOfLocalDay,
  tokensCostUsd,
} from "@mc/core";
import { type CcConfig, crewSeatDef, isInside, realish } from "../config.ts";
import { dayFormatter, lastDays } from "../hud/views.ts";
import type {
  SessionSpendLastUsage,
  SessionSpendRecord,
  SpendOwner,
} from "../store/session-spend.ts";
import type { Store } from "../store.ts";
import { offsetSince, readNewLines } from "../transcript/tail.ts";

const DAY_MS = 24 * 60 * 60_000;

/** The setting that holds when the transcripts were last read (epoch ms). */
export const SESSION_SPEND_READ_SETTING = "sessionSpend.readAt";
/** Most transcript bytes one pass reads; a longer first read carries on at the next pass. */
export const SESSION_SPEND_PASS_BYTES = 64 * 1024 * 1024;

/** Epoch ms of the start of the local day SESSION_SPEND_WEEK_DAYS - 1 days before `now`'s. */
function weekStartOf(now: number, tz: string): number {
  const today = startOfLocalDay(now, tz);
  // noon of that day, give or take an hour of DST, is inside it
  return startOfLocalDay(today - (SESSION_SPEND_WEEK_DAYS - 1) * DAY_MS + DAY_MS / 2, tz);
}

/**
 * Every `*.jsonl` under `root`, at any depth, and the folders that could not be listed. Throws when
 * `root` itself cannot be read (missing or refused), so the pass fails instead of looking empty.
 */
function transcriptFiles(root: string): { paths: string[]; unreadable: string[] } {
  const paths: string[] = [];
  const unreadable: string[] = [];
  const walk = (dir: string, top: boolean): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (top) throw new Error(`cannot read ${dir}: ${e instanceof Error ? e.message : String(e)}`);
      unreadable.push(dir);
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path, false);
      else if (e.isFile() && e.name.endsWith(".jsonl")) paths.push(path);
    }
  };
  walk(root, true);
  return { paths, unreadable };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

interface Usage {
  id: string;
  sessionId: string;
  cwd: string | null;
  model: string;
  at: number;
  fast: boolean;
  tokens: SpendTokens;
}

/** The usage an assistant transcript line records, or null; nothing else of the line is kept. */
function usageOf(line: string, stem: string): Usage | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.type !== "assistant") return null;
  const m = o.message as Record<string, unknown> | undefined;
  const u = m?.usage as Record<string, unknown> | undefined;
  if (typeof u !== "object" || u === null || typeof m?.id !== "string") return null;
  const at = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : Number.NaN;
  if (Number.isNaN(at)) return null;
  const cc = u.cache_creation as Record<string, unknown> | undefined;
  const hasSplit = typeof cc === "object" && cc !== null;
  return {
    id: m.id,
    sessionId: typeof o.sessionId === "string" && o.sessionId !== "" ? o.sessionId : stem,
    cwd: typeof o.cwd === "string" ? o.cwd : null,
    model: typeof m.model === "string" ? m.model : "unknown",
    at,
    fast: u.speed === "fast",
    tokens: {
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cacheWrite5m: hasSplit
        ? num(cc.ephemeral_5m_input_tokens)
        : num(u.cache_creation_input_tokens),
      cacheWrite1h: hasSplit ? num(cc.ephemeral_1h_input_tokens) : 0,
      cacheRead: num(u.cache_read_input_tokens),
    },
  };
}

const KINDS = ["input", "output", "cacheWrite5m", "cacheWrite1h", "cacheRead"] as const;

/**
 * Reads the usage records appended to every Claude transcript under `root` since the last pass and
 * adds them to the store, one row per file, session, local day and model, with the session's owner
 * and repo as decided now. A file is read on from where the last pass stopped; its first read
 * starts at the local day 6 days ago. Claude Code writes one line per content block, each
 * repeating the message id and usage so far, so a message counts once: a repeat adds only what
 * its counts grew by, on this pass or a later one. A file that shrank is read again from its start
 * and replaces its earlier rows. Starts no process and calls no model.
 *
 * Throws when `root` cannot be read (nothing is recorded, readAt is kept) or, after reading the
 * rest, when some transcripts could not be read (their offsets are kept).
 */
export function readSessionSpend(i: {
  config: CcConfig;
  store: Store;
  root: string;
  now: number;
}): {
  files: number;
  added: number;
} {
  const { config, store, root, now } = i;
  const tz = config.operator.timezone;
  const day = dayFormatter(tz);
  const weekStart = weekStartOf(now, tz);
  const attribute = attribution(config, store);
  let files = 0;
  let added = 0;
  let budget = SESSION_SPEND_PASS_BYTES;
  const { paths, unreadable } = transcriptFiles(root);
  const failed = [...unreadable];
  for (const path of paths) {
    let st: { size: number; mtimeMs: number };
    try {
      st = statSync(path);
    } catch {
      failed.push(path);
      continue;
    }
    const prev = store.sessionSpendFile(path);
    if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) continue;
    if (!prev && st.mtimeMs < weekStart) {
      // older than the week: nothing in it is shown; read only what is appended from now on
      store.addSessionSpend(
        { path, offset: st.size, size: st.size, mtime: st.mtimeMs, last: null },
        [],
      );
      continue;
    }
    if (budget <= 0) break;
    files++;
    const stem = basename(path, ".jsonl");
    let offset = prev ? prev.offset : offsetSince(path, weekStart, { maxBytes: st.size });
    let last: SessionSpendLastUsage | null = prev?.last ?? null;
    let reset = false;
    const rows = new Map<string, SessionSpendRecord>();
    const add = (
      key: { sessionId: string; day: string; model: string; cwd: string | null },
      tokens: SpendTokens,
      fast: boolean,
      at: number,
      messages: number,
    ) => {
      const k = `${key.sessionId}\0${key.day}\0${key.model}`;
      const cost = tokensCostUsd(key.model, tokens, fast);
      const row = rows.get(k);
      if (row) {
        for (const kind of KINDS) row[kind] += tokens[kind];
        row.costUsd = row.costUsd === null || cost === null ? null : row.costUsd + cost;
        row.messages += messages;
        row.lastAt = Math.max(row.lastAt, at);
        return;
      }
      const { owner, repo } = attribute(key.sessionId, key.cwd);
      rows.set(k, {
        path,
        sessionId: key.sessionId,
        day: key.day,
        model: key.model,
        owner,
        repo,
        ...tokens,
        costUsd: cost,
        messages,
        lastAt: at,
      });
    };
    let unread = false;
    for (;;) {
      let error = false;
      const r = readNewLines(path, offset, {
        onError: () => {
          error = true;
        },
      });
      if (error && r.lines.length === 0 && r.nextOffset === offset && !r.reset) {
        unread = true;
        break;
      }
      if (r.reset) {
        reset = true;
        last = null;
        rows.clear();
      }
      for (const line of r.lines) {
        const u = usageOf(line, stem);
        if (u === null) continue;
        if (last !== null && u.id === last.id) {
          // a later line of the message last counted: add only what its counts grew by
          const grown = { ...last.tokens };
          let any = false;
          for (const kind of KINDS) {
            const more = u.tokens[kind] - last.tokens[kind];
            grown[kind] = Math.max(0, more);
            if (more > 0) {
              any = true;
              last.tokens[kind] = u.tokens[kind];
            }
          }
          if (any) add({ ...last, cwd: u.cwd }, grown, last.fast, u.at, 0);
          continue;
        }
        const d = day(u.at);
        add(
          { sessionId: u.sessionId, day: d, model: u.model, cwd: u.cwd },
          u.tokens,
          u.fast,
          u.at,
          1,
        );
        added++;
        last = {
          id: u.id,
          sessionId: u.sessionId,
          day: d,
          model: u.model,
          fast: u.fast,
          tokens: { ...u.tokens },
        };
      }
      budget -= r.nextOffset - (r.reset ? 0 : offset);
      if (r.nextOffset === offset && !r.reset) break;
      offset = r.nextOffset;
      if (budget <= 0) break;
    }
    if (unread && rows.size === 0 && !reset) {
      failed.push(path);
      continue;
    }
    store.addSessionSpend(
      {
        path,
        offset,
        // a pass that stopped short reads on next time, even when the file has not changed
        size: budget <= 0 || unread ? -1 : st.size,
        mtime: st.mtimeMs,
        last,
      },
      [...rows.values()],
      reset,
    );
    if (unread) failed.push(path);
  }
  store.setSetting(SESSION_SPEND_READ_SETTING, String(now));
  if (failed.length > 0)
    throw new Error(
      `${failed.length} of the transcripts under ${root} could not be read: ${failed.slice(0, 3).join(", ")}`,
    );
  return { files, added };
}

/** The repo of a folder by its git checkout: the main checkout's folder name; cached, no git run. */
const repoCache = new Map<string, string | null>();
function repoOfCwd(cwd: string): string | null {
  const cached = repoCache.get(cwd);
  if (cached !== undefined) return cached;
  let found: string | null = null;
  for (let d = resolve(cwd); ; d = dirname(d)) {
    const git = join(d, ".git");
    try {
      const st = statSync(git);
      if (st.isDirectory()) found = basename(d);
      else {
        const m = readFileSync(git, "utf8").match(/^gitdir:\s*(.+)$/m);
        const gitdir = m?.[1]?.trim();
        if (gitdir) {
          const abs = isAbsolute(gitdir) ? gitdir : resolve(d, gitdir);
          const at = abs.lastIndexOf("/.git");
          found = at === -1 ? basename(d) : basename(abs.slice(0, at));
        }
      }
      break;
    } catch {
      // no .git here: look further up
    }
    if (dirname(d) === d) break;
  }
  repoCache.set(cwd, found);
  return found;
}

interface Attribution {
  owner: SpendOwner;
  repo: string | null;
}

/**
 * Decides a session's owner and repo from the runs, the seats and the folder it ran in, as they
 * are now; the rows keep the answer. Cached for one pass.
 */
function attribution(config: CcConfig, store: Store) {
  const crew = config.crew;
  const crewRoots = crew
    ? [crew.worktrees, `${crew.worktrees}-sessions`, ...crew.sessions.map((s) => s.checkout)].map(
        realish,
      )
    : [];
  const seatRepo = new Map(
    (crew?.sessions ?? []).flatMap((s) => s.seats.map((seat) => [seat.id, s.repoId] as const)),
  );
  const cache = new Map<string, Attribution>();
  return (sessionId: string, cwd: string | null): Attribution => {
    const key = `${sessionId}\0${cwd ?? ""}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const known = store.sessionSpendOwner(sessionId);
    let out: Attribution;
    if (known) {
      out = {
        owner: crewSeatDef(config, known.agentId).loop === "watch" ? "flight" : "crew",
        repo: known.repoId ?? seatRepo.get(known.agentId) ?? (cwd ? repoOfCwd(cwd) : null),
      };
    } else {
      const real = cwd ? realish(cwd) : null;
      out = {
        owner:
          real !== null && crewRoots.some((root) => isInside(real, root)) ? "crew" : "operator",
        repo: cwd ? repoOfCwd(cwd) : null,
      };
    }
    cache.set(key, out);
    return out;
  };
}

const cell = (): SpendCell => ({ tokens: 0, costUsd: 0 });
const addTo = (c: SpendCell, r: SessionSpendRecord): void => {
  c.tokens += r.input + r.output;
  c.costUsd += r.costUsd ?? 0;
};

/**
 * Every Claude session on this Mac over the last SESSION_SPEND_WEEK_DAYS local days, by local day
 * and repo, split into the operator's sessions, the crew and FLIGHT. Each stored row falls in
 * exactly one group, the one recorded when its lines were read (a later config change moves
 * nothing), so the rows add up to `total`, the sum of every stored row in the window.
 */
export function sessionSpendSplit(config: CcConfig, store: Store, now: number): SessionSpendSplit {
  const tz = config.operator.timezone;
  const days = lastDays(dayFormatter(tz)(now), SESSION_SPEND_WEEK_DAYS);
  const records = store.sessionSpendSince(days[0] as string);
  const rows = new Map<string, SessionSpendRow>();
  const total = cell();
  let unpricedTokens = 0;
  for (const r of records) {
    const { owner, repo } = r;
    const key = `${r.day}\0${repo ?? ""}`;
    let row = rows.get(key);
    if (!row) {
      row = { day: r.day, repo, operator: cell(), crew: cell(), flight: cell(), total: cell() };
      rows.set(key, row);
    }
    addTo(row[owner], r);
    addTo(row.total, r);
    addTo(total, r);
    if (r.costUsd === null) unpricedTokens += r.input + r.output;
  }
  const readAt = store.getSetting(SESSION_SPEND_READ_SETTING);
  return {
    rows: [...rows.values()].sort(
      (a, b) =>
        b.day.localeCompare(a.day) ||
        b.total.costUsd - a.total.costUsd ||
        b.total.tokens - a.total.tokens,
    ),
    total,
    unpricedTokens,
    readAt: readAt === null ? null : Number(readAt),
  };
}

/** Each of `sessionIds`' tokens and ~cost today and over the last 7 local days; absent: no usage. */
export function sessionSpendFor(
  store: Store,
  sessionIds: string[],
  now: number,
  tz: string,
): Map<string, SessionSpendCell> {
  const today = dayFormatter(tz)(now);
  const days = lastDays(today, SESSION_SPEND_WEEK_DAYS);
  const out = new Map<string, SessionSpendCell>();
  for (const r of store.sessionSpendOf(sessionIds, days[0] as string)) {
    let c = out.get(r.sessionId);
    if (!c) {
      c = { today: cell(), week: cell(), unpriced: false };
      out.set(r.sessionId, c);
    }
    addTo(c.week, r);
    if (r.day === today) addTo(c.today, r);
    if (r.costUsd === null && r.input + r.output > 0) c.unpriced = true;
  }
  return out;
}
