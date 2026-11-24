import {
  type AttentionItem,
  type FlightLedgerEntry,
  type FlightSummaryView,
  type FlightView,
  isOperatorItem,
} from "@mc/core";
import { elapsed, percent } from "../../fmt.ts";
import type { FlightRun } from "../Situation.tsx";

/** What a vital with no source today shows in place of a figure. */
export const NOT_MEASURED = "not measured yet";

/** green, amber, red, or none: the hub has nothing to measure it with. */
export type VitalState = "ok" | "warn" | "crit" | "none";

/** The word that goes with each colour, so colour is never the only sign. */
export const VITAL_WORD: Record<VitalState, string> = {
  ok: "Good",
  warn: "Watch",
  crit: "Bad",
  none: "No data",
};

/** One measure: its value, the bands it is judged by, and where the figure comes from. */
export interface Vital {
  id: string;
  label: string;
  state: VitalState;
  /** The figure in words; NOT_MEASURED when `state` is none. */
  value: string;
  /** Where green ends and red starts, in words. These are draft bands, until a week of data agrees them. */
  band: string;
  /** What the figure is read from. */
  source: string;
  /** When the source last changed (epoch ms), or null for a figure worked out afresh on each load. */
  checkedAt: number | null;
}

export interface VitalInputs {
  now: number;
  run: FlightRun;
  view: FlightView | undefined;
  summary: FlightSummaryView | undefined;
  attention: readonly AttentionItem[] | undefined;
  /** FLIGHT's open ledger entries. */
  ledger: readonly FlightLedgerEntry[] | undefined;
}

const MIN = 60_000;

/** The measures that have no source yet, listed so the page says so and the report can name them. */
export const UNMEASURED: readonly { id: string; label: string; source: string }[] = [
  {
    id: "load",
    label: "Load balance across the crew",
    source: "needs time in a turn per seat, which the hub does not total yet",
  },
  {
    id: "main-ci",
    label: "CI on main alone",
    source: "needs a branch on each CI run, which the hub does not store yet",
  },
  {
    id: "journal",
    label: "Journal age",
    source: "needs the hub-written journal, which does not exist yet",
  },
  {
    id: "streams",
    label: "Age of FLIGHT's now, next and at risk",
    source: "needs workstreams, which do not exist yet",
  },
];

/** Picks green, amber or red from two limits: at or under `ok` is green, over `crit` is red. */
export function band(value: number, ok: number, crit: number): VitalState {
  return value <= ok ? "ok" : value <= crit ? "warn" : "crit";
}

const noData = (id: string, label: string, bandText: string, source: string): Vital => ({
  id,
  label,
  state: "none",
  value: NOT_MEASURED,
  band: bandText,
  source,
  checkedAt: null,
});

const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

/** The most recent day's median wait that has one. */
function latestWait(
  view: FlightView | undefined,
  key: "operatorMedianMs" | "blockerMedianMs",
): number | null {
  const days = view?.wakeWaits?.byDay ?? [];
  for (let i = days.length - 1; i >= 0; i--) {
    const v = days[i]?.[key];
    if (v !== null && v !== undefined) return v;
  }
  return view?.wakeWaits?.[key] ?? null;
}

/** Every vital the hub can compute today, in the order the page shows them. */
export function computeVitals(inputs: VitalInputs): Vital[] {
  const { now, run, view, summary, attention, ledger } = inputs;
  const out: Vital[] = [];

  const SRC_FLIGHT = "FLIGHT's seat (GET /api/flight)";
  out.push(
    run.kind === "loading"
      ? noData(
          "running",
          "FLIGHT is running",
          "Running is good; held is watch; stopped is bad",
          SRC_FLIGHT,
        )
      : {
          id: "running",
          label: "FLIGHT is running",
          state: run.kind === "running" ? "ok" : run.kind === "held" ? "warn" : "crit",
          value: run.kind === "running" ? "Running" : run.kind === "held" ? "Held" : "Stopped",
          band: "Running is good; held is watch; stopped is bad",
          source: SRC_FLIGHT,
          checkedAt: view?.wake?.lastWakeAt ?? null,
        },
  );

  const perHour = view?.wakeHistory?.perHour.map((h) => h.n) ?? [];
  const wakeMedian = median(perHour);
  out.push(
    wakeMedian === null
      ? noData("wakes", "Wakes an hour", "Good up to 6, bad over 12", "wake history, last 24 hours")
      : {
          id: "wakes",
          label: "Wakes an hour",
          state: band(wakeMedian, 6, 12),
          value: `${Math.round(wakeMedian * 10) / 10} (median, last 24 hours)`,
          band: "Good up to 6, bad over 12",
          source: "wake history, last 24 hours",
          checkedAt: view?.wake?.lastWakeAt ?? null,
        },
  );

  const wh = view?.wakeHistory;
  out.push(
    !wh || wh.total === 0
      ? noData(
          "idle",
          "Wakes that led to nothing",
          "Good up to 25%, bad over 50%",
          "wake history, last 24 hours",
        )
      : {
          id: "idle",
          label: "Wakes that led to nothing",
          state: band(wh.idle / wh.total, 0.25, 0.5),
          value: `${percent((wh.idle / wh.total) * 100)} (${wh.idle} of ${wh.total})`,
          band: "Good up to 25%, bad over 50%",
          source: "wake history, last 24 hours",
          checkedAt: view?.wake?.lastWakeAt ?? null,
        },
  );

  for (const [id, label, key] of [
    ["operator-wait", "Wait for an operator message to wake FLIGHT", "operatorMedianMs"],
    ["blocker-wait", "Wait for a blocker to wake FLIGHT", "blockerMedianMs"],
  ] as const) {
    const ms = latestWait(view, key);
    const bandText = "Good up to 2 minutes, bad over 10";
    const source = "wake waits, median of the latest day with one";
    out.push(
      ms === null
        ? noData(id, label, bandText, source)
        : {
            id,
            label,
            state: band(ms, 2 * MIN, 10 * MIN),
            value: elapsed(ms),
            band: bandText,
            source,
            checkedAt: null,
          },
    );
  }

  const share = view?.wakeCost?.weekShare ?? null;
  out.push(
    share === null
      ? noData(
          "cost",
          "FLIGHT's share of crew cost",
          "Good up to 20%, bad over 35%",
          "cost, last 7 days",
        )
      : {
          id: "cost",
          label: "FLIGHT's share of crew cost",
          state: band(share, 0.2, 0.35),
          value: `${percent(share * 100)} over 7 days`,
          band: "Good up to 20%, bad over 35%",
          source: "cost, last 7 days",
          checkedAt: null,
        },
  );

  if (attention === undefined) {
    out.push(
      noData(
        "asks",
        "Asks waiting on the operator",
        "Good: none; bad: oldest over 4 hours",
        "Needs you",
      ),
    );
  } else {
    const asks = attention.filter(isOperatorItem);
    const oldest = asks.reduce((m, a) => Math.max(m, a.at > 0 ? now - a.at : 0), 0);
    out.push({
      id: "asks",
      label: "Asks waiting on the operator",
      state: asks.length === 0 ? "ok" : band(oldest, 60 * MIN, 4 * 60 * MIN),
      value: asks.length === 0 ? "none" : `${asks.length}, oldest ${elapsed(oldest)}`,
      band: "Good: none or under an hour; bad: oldest over 4 hours",
      source: "Needs you",
      checkedAt: null,
    });
  }

  const blocked = view?.blocked;
  if (blocked === undefined) {
    out.push(
      noData(
        "blocked",
        "Tickets waiting on other work",
        "Good: none; bad: longest over 12 hours",
        "ticket waits",
      ),
    );
  } else {
    const longest = blocked.reduce((m, b) => Math.max(m, b.waitedMin), 0);
    out.push({
      id: "blocked",
      label: "Tickets waiting on other work",
      state: blocked.length === 0 ? "ok" : band(longest, 4 * 60, 12 * 60),
      value: blocked.length === 0 ? "none" : `${blocked.length}, longest ${elapsed(longest * MIN)}`,
      band: "Good: none or under 4 hours; bad: longest over 12 hours",
      source: "ticket waits",
      checkedAt: null,
    });
  }

  const headAge = summary?.headlineAgeMin ?? null;
  out.push(
    headAge === null
      ? noData(
          "headline",
          "Age of FLIGHT's own note",
          "Good up to 1 hour, bad over 6 hours",
          "FLIGHT's headline",
        )
      : {
          id: "headline",
          label: "Age of FLIGHT's own note",
          state: band(headAge, 60, 360),
          value: elapsed(headAge * MIN),
          band: "Good up to 1 hour, bad over 6 hours",
          source: "FLIGHT's headline",
          checkedAt: now - headAge * MIN,
        },
  );

  const pointered = (ledger ?? []).filter((e) => (e.pointers?.length ?? 0) > 0);
  if (pointered.length === 0) {
    out.push(
      noData(
        "pointers",
        "Moved things FLIGHT has not read",
        "Good up to 30 minutes unread, bad over 4 hours",
        "FLIGHT's pointers",
      ),
    );
  } else {
    const unread = pointered.flatMap((e) =>
      (e.pointers ?? []).filter(
        (p) => p.changedAt !== null && (p.readAt === null || p.readAt < p.changedAt),
      ),
    );
    const oldest = unread.reduce((m, p) => Math.max(m, now - (p.changedAt ?? now)), 0);
    out.push({
      id: "pointers",
      label: "Moved things FLIGHT has not read",
      state: unread.length === 0 ? "ok" : band(oldest, 30 * MIN, 4 * 60 * MIN),
      value: unread.length === 0 ? "none" : `${unread.length}, oldest ${elapsed(oldest)}`,
      band: "Good: none or under 30 minutes; bad: oldest over 4 hours",
      source: "FLIGHT's pointers",
      checkedAt: null,
    });
  }

  const fails = summary?.metrics.ciFailures ?? null;
  out.push(
    fails === null
      ? noData("ci-failures", "CI failures", "Good up to 3 a day, bad over 10", "CI runs, last day")
      : {
          id: "ci-failures",
          label: "CI failures",
          state: band(fails, 3, 10),
          value: `${fails} in the last day`,
          band: "Good up to 3 a day, bad over 10",
          source: "CI runs, last day",
          checkedAt: summary?.metrics.since ?? null,
        },
  );

  return out;
}

/** Unmeasured rows in the same shape, for the table. */
export const unmeasuredVitals = (): Vital[] =>
  UNMEASURED.map((u) => noData(u.id, u.label, "Not set until there is data", u.source));
