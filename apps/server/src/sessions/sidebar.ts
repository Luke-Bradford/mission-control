import {
  type CmuxSessionRow,
  SESSION_NOTICE_TITLE,
  SESSIONS_CMUX_WRITES_SETTING,
  type SessionCheckResult,
  type SessionNoticeKind,
  SIDEBAR_CI_TEXT,
  SIDEBAR_KEY_PREFIX,
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
  cmux: Pick<Cmux, "statuses" | "setStatus" | "clearStatus" | "linkPr" | "notify">;
  store: Pick<Store, "getSetting">;
  /** Preview hubs read sessions but must never write to the operator's cmux. */
  writes?: boolean;
  costToday?: (row: CmuxSessionRow) => number | null;
  lastCheck?: (row: CmuxSessionRow) => SessionCheckResult | null;
  log?: (line: string) => void;
};

export function createSessionSidebar(deps: Deps) {
  const values = new Map<string, Map<string, string>>();
  const urls = new Map<string, string | null>();
  const states = new Map<string, CmuxSessionRow["state"]>();
  const appAnswers = new Map<string, boolean | null>();
  let timer: NodeJS.Timeout | null = null;
  let inFlight = Promise.resolve();
  const writesOn = () => deps.writes !== false && cmuxWritesOn(deps.store);
  const mutate = async (write: () => Promise<void>) => {
    if (!writesOn()) return false;
    await write();
    return true;
  };
  const set = async (id: string, key: string, value: string | null) => {
    const previous = values.get(id) ?? new Map<string, string>();
    if (previous.get(key) === value) return;
    if (value === null) {
      if (!previous.has(key)) return;
      if (!(await mutate(() => deps.cmux.clearStatus(id, key)))) return;
      previous.delete(key);
    } else {
      if (!(await mutate(() => deps.cmux.setStatus(id, key, value)))) return;
      previous.set(key, value);
    }
    values.set(id, previous);
  };
  const reconcile = async () => {
    if (!writesOn()) return;
    const view = await deps.sessions.view();
    if (!view.ok) return;
    const live = new Set(view.sessions.map((row) => row.id));
    for (const id of values.keys()) if (!live.has(id)) values.delete(id);
    for (const id of states.keys()) if (!live.has(id)) states.delete(id);
    for (const id of appAnswers.keys()) if (!live.has(id)) appAnswers.delete(id);
    for (const id of urls.keys()) if (!live.has(id)) urls.delete(id);
    for (const row of view.sessions) {
      try {
        if (!values.has(row.id)) {
          const existing = await deps.cmux.statuses(row.id);
          values.set(
            row.id,
            new Map(Object.entries(existing).filter(([key]) => key.startsWith(SIDEBAR_KEY_PREFIX))),
          );
        }
        const previousState = states.get(row.id);
        const previousAnswer = appAnswers.get(row.id);
        const app = row.app;
        states.set(row.id, row.state);
        appAnswers.set(row.id, app?.answers ?? null);
        if (row.owner === "operator" && previousState !== undefined) {
          if (row.state === "waiting" && previousState !== "waiting")
            await mutate(() =>
              deps.cmux.notify(
                row.id,
                SESSION_NOTICE_TITLE.waiting,
                `"${row.name}" has a question for you.`,
              ),
            );
          else if (previousState === "working" && row.state === "idle")
            await mutate(() =>
              deps.cmux.notify(
                row.id,
                SESSION_NOTICE_TITLE.finished,
                `"${row.name}" finished and is idle.`,
              ),
            );
          else if (previousAnswer === true && app?.answers === false)
            await mutate(() =>
              deps.cmux.notify(
                row.id,
                SESSION_NOTICE_TITLE.appStopped,
                `Its app at ${app.url} stopped answering.`,
              ),
            );
        }
        const url = row.pr?.url ?? null;
        if (urls.get(row.id) !== url && url !== null)
          await mutate(() => deps.cmux.linkPr(row.id, url));
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
  const tick = () => {
    const next = inFlight.then(reconcile, reconcile);
    inFlight = next.catch(() => {});
    return next;
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
      await mutate(() => deps.cmux.notify(id, SESSION_NOTICE_TITLE[kind], body));
    },
    reset() {
      values.clear();
      urls.clear();
      states.clear();
      appAnswers.clear();
    },
  };
}
