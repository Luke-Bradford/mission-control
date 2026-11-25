import {
  type CmuxSessionRow,
  SESSION_NOTICE_TITLE,
  SESSIONS_CMUX_WRITES_SETTING,
  type SessionCheckResult,
  type SessionNoticeKind,
  SIDEBAR_CI_TEXT,
  SIDEBAR_KEYS,
  SIDEBAR_REVIEW_TEXT,
} from "@mc/core";
import type { Cmux } from "../runtime/cmux.ts";
import type { Store } from "../store.ts";
import type { SessionsService } from "./sessions.ts";

export const SIDEBAR_TICK_MS = 5000;
export const cmuxWritesOn = (store: Pick<Store, "getSetting">) =>
  store.getSetting(SESSIONS_CMUX_WRITES_SETTING) !== "off";

type Deps = {
  sessions: Pick<SessionsService, "view">;
  cmux: Pick<Cmux, "setStatus" | "clearStatus" | "linkPr" | "notify">;
  store: Pick<Store, "getSetting">;
  costToday?: (row: CmuxSessionRow) => number | null;
  lastCheck?: (row: CmuxSessionRow) => SessionCheckResult | null;
  log?: (line: string) => void;
};

export function createSessionSidebar(deps: Deps) {
  const values = new Map<string, Map<string, string>>();
  const urls = new Map<string, string | null>();
  const states = new Map<string, CmuxSessionRow["state"]>();
  let timer: NodeJS.Timeout | null = null;
  const set = async (id: string, key: string, value: string | null) => {
    const previous = values.get(id) ?? new Map<string, string>();
    if (previous.get(key) === value) return;
    if (value === null) {
      if (!previous.has(key)) return;
      await deps.cmux.clearStatus(id, key);
      previous.delete(key);
    } else {
      await deps.cmux.setStatus(id, key, value);
      previous.set(key, value);
    }
    values.set(id, previous);
  };
  const tick = async () => {
    if (!cmuxWritesOn(deps.store)) return;
    const view = await deps.sessions.view();
    if (!view.ok) return;
    const live = new Set(view.sessions.map((row) => row.id));
    for (const id of values.keys()) if (!live.has(id)) values.delete(id);
    for (const row of view.sessions) {
      try {
        const url = row.pr?.url ?? null;
        if (urls.get(row.id) !== url && url !== null) await deps.cmux.linkPr(row.id, url);
        urls.set(row.id, url);
        await set(row.id, SIDEBAR_KEYS.ci, row.pr?.ci ? SIDEBAR_CI_TEXT[row.pr.ci] : null);
        await set(
          row.id,
          SIDEBAR_KEYS.review,
          row.pr?.review ? SIDEBAR_REVIEW_TEXT[row.pr.review] : null,
        );
        const cost = deps.costToday?.(row) ?? null;
        await set(row.id, SIDEBAR_KEYS.cost, cost === null ? null : `~$${cost.toFixed(2)} today`);
        const check = deps.lastCheck?.(row) ?? null;
        await set(
          row.id,
          SIDEBAR_KEYS.check,
          check === null
            ? null
            : check.ok
              ? "Checks passed"
              : `Checks failed: ${(check.command ?? "").slice(0, 80)}`,
        );
      } catch (error) {
        deps.log?.(`cmux sidebar ${row.id}: ${String(error)}`);
      }
    }
  };
  return {
    tick,
    start() {
      if (timer === null) timer = setInterval(() => void tick(), SIDEBAR_TICK_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    async notify(id: string, kind: SessionNoticeKind, body: string) {
      if (cmuxWritesOn(deps.store)) await deps.cmux.notify(id, SESSION_NOTICE_TITLE[kind], body);
    },
    reset() {
      values.clear();
      urls.clear();
      states.clear();
    },
  };
}
