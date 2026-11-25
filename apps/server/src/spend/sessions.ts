import { readdirSync, readFileSync, statSync } from "node:fs";
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
import type { SessionSpendRecord } from "../store/session-spend.ts";
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

/** Every `*.jsonl` under `root`, at any depth; [] when `root` cannot be read. */
function transcriptFiles(root: string): string[] {
  try {
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => join(e.parentPath, e.name));
  } catch {
    return [];
  }
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

/**
 * Reads the usage records appended to every Claude transcript under `root` since the last pass and
 * adds them to the store, one row per session, local day and model. A file is read on from where
 * the last pass stopped; its first read starts at the local day 6 days ago. Claude Code writes one
 * line per content block, each repeating the message id and usage, so a message counts once, from
 * its last line read. Starts no process and calls no model. Never throws for a bad file.
 */
export function readSessionSpend(i: { store: Store; root: string; tz: string; now: number }): {
  files: number;
  added: number;
} {
  const { store, root, tz, now } = i;
  const day = dayFormatter(tz);
  const weekStart = weekStartOf(now, tz);
  let files = 0;
  let added = 0;
  let budget = SESSION_SPEND_PASS_BYTES;
  const paths = transcriptFiles(root);
  for (const path of paths) {
    let st: { size: number; mtimeMs: number };
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    const prev = store.sessionSpendFile(path);
    if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) continue;
    if (!prev && st.mtimeMs < weekStart) {
      // older than the week: nothing in it is shown; read only what is appended from now on
      store.addSessionSpend(
        { path, offset: st.size, size: st.size, mtime: st.mtimeMs, lastMessage: null },
        [],
      );
      continue;
    }
    if (budget <= 0) break;
    files++;
    const stem = basename(path, ".jsonl");
    let offset = prev ? prev.offset : offsetSince(path, weekStart, { maxBytes: st.size });
    let last = prev?.lastMessage ?? null;
    const rows = new Map<string, SessionSpendRecord>();
    let pending: Usage | null = null;
    const flush = () => {
      if (pending === null) return;
      const p = pending;
      pending = null;
      const d = day(p.at);
      const key = `${p.sessionId}\0${d}\0${p.model}`;
      const cost = tokensCostUsd(p.model, p.tokens, p.fast);
      const row = rows.get(key);
      if (row) {
        row.input += p.tokens.input;
        row.output += p.tokens.output;
        row.cacheWrite5m += p.tokens.cacheWrite5m;
        row.cacheWrite1h += p.tokens.cacheWrite1h;
        row.cacheRead += p.tokens.cacheRead;
        row.costUsd = row.costUsd === null || cost === null ? null : row.costUsd + cost;
        row.messages++;
        row.lastAt = Math.max(row.lastAt, p.at);
        if (p.cwd !== null) row.cwd = p.cwd;
      } else {
        rows.set(key, {
          sessionId: p.sessionId,
          day: d,
          model: p.model,
          cwd: p.cwd,
          ...p.tokens,
          costUsd: cost,
          messages: 1,
          lastAt: p.at,
        });
      }
      added++;
    };
    let failed = false;
    for (;;) {
      const r = readNewLines(path, offset, {
        onError: () => {
          failed = true;
        },
      });
      if (r.reset) {
        last = null;
        pending = null;
        rows.clear();
      }
      for (const line of r.lines) {
        const u = usageOf(line, stem);
        if (u === null) continue;
        if (u.id === last) {
          // a later line of the message being read: its usage is the fuller one
          if (pending?.id === u.id) pending = u;
          continue;
        }
        flush();
        pending = u;
        last = u.id;
      }
      budget -= r.nextOffset - (r.reset ? 0 : offset);
      if (r.nextOffset === offset && !r.reset) break;
      offset = r.nextOffset;
      if (budget <= 0) break;
    }
    flush();
    if (failed && rows.size === 0 && offset === (prev?.offset ?? offset)) continue;
    store.addSessionSpend(
      {
        path,
        offset,
        // a pass that stopped short reads on next time, even when the file has not changed
        size: budget <= 0 ? -1 : st.size,
        mtime: st.mtimeMs,
        lastMessage: last,
      },
      [...rows.values()],
    );
  }
  store.setSetting(SESSION_SPEND_READ_SETTING, String(now));
  return { files, added };
}

type Owner = "operator" | "crew" | "flight";

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

interface Classified {
  owner: Owner;
  repo: string | null;
}

/** Decides each session's owner and repo now, from the runs, the seats and the folder it ran in. */
function classifier(config: CcConfig, store: Store, records: readonly SessionSpendRecord[]) {
  const ids = [...new Set(records.map((r) => r.sessionId))];
  const owners = store.sessionSpendOwners(ids);
  const crew = config.crew;
  const crewRoots = crew
    ? [crew.worktrees, `${crew.worktrees}-sessions`, ...crew.sessions.map((s) => s.checkout)].map(
        realish,
      )
    : [];
  const seatRepo = new Map(
    (crew?.sessions ?? []).flatMap((s) => s.seats.map((seat) => [seat.id, s.repoId] as const)),
  );
  const cache = new Map<string, Classified>();
  return (r: SessionSpendRecord): Classified => {
    const key = `${r.sessionId}\0${r.cwd ?? ""}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const known = owners.get(r.sessionId);
    let out: Classified;
    if (known) {
      out = {
        owner: crewSeatDef(config, known.agentId).loop === "watch" ? "flight" : "crew",
        repo: known.repoId ?? seatRepo.get(known.agentId) ?? (r.cwd ? repoOfCwd(r.cwd) : null),
      };
    } else {
      const real = r.cwd ? realish(r.cwd) : null;
      out = {
        owner:
          real !== null && crewRoots.some((root) => isInside(real, root)) ? "crew" : "operator",
        repo: r.cwd ? repoOfCwd(r.cwd) : null,
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
 * and repo, split into the operator's sessions, the crew and FLIGHT. Each session falls in exactly
 * one group, so the rows add up to `total`, the sum of every stored row in the window.
 */
export function sessionSpendSplit(config: CcConfig, store: Store, now: number): SessionSpendSplit {
  const tz = config.operator.timezone;
  const days = lastDays(dayFormatter(tz)(now), SESSION_SPEND_WEEK_DAYS);
  const records = store.sessionSpendSince(days[0] as string);
  const classify = classifier(config, store, records);
  const rows = new Map<string, SessionSpendRow>();
  const total = cell();
  let unpricedTokens = 0;
  for (const r of records) {
    const { owner, repo } = classify(r);
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
