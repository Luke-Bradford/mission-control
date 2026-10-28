import { randomUUID } from "node:crypto";
import type {
  AttentionItem,
  NotificationCategory,
  NotificationEvent,
  NotificationPreferences,
} from "@mc/core";
import { z } from "zod";
import { activeAway } from "./away.ts";
import type { ChangeBus } from "./bus.ts";
import type { CcConfig } from "./config.ts";
import { FLIGHT_DOWN_ITEMS } from "./hud.ts";
import type { Store } from "./store.ts";

const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const NotificationPreferencesBody = z.strictObject({
  enabled: z.boolean().optional(),
  categories: z.strictObject({
    asks: z.boolean(),
    flightDown: z.boolean(),
    people: z.boolean(),
    decisions: z.boolean(),
    stalls: z.boolean(),
    prs: z.boolean(),
    capcom: z.boolean(),
    awayDigest: z.boolean(),
    quota: z.boolean(),
  }),
  quietHours: z.strictObject({
    start: clockTime,
    end: clockTime,
    timezone: z
      .string()
      .max(100)
      .refine((timezone) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: timezone });
          return true;
        } catch {
          return false;
        }
      }),
    stallsBypass: z.literal(true),
  }),
  softChime: z.boolean(),
}) satisfies z.ZodType<NotificationPreferences>;

/** Saved preferences of any category set: a newer or older hub's choices still read. */
const StoredPreferences = NotificationPreferencesBody.extend({
  categories: z.record(z.string(), z.boolean()),
});

const defaultNotificationPreferences = (timezone: string): NotificationPreferences => ({
  enabled: true,
  categories: {
    asks: true,
    flightDown: true,
    people: false,
    decisions: false,
    stalls: false,
    prs: false,
    capcom: false,
    awayDigest: true,
    quota: false,
  },
  quietHours: { start: "19:00", end: "08:00", timezone, stallsBypass: true },
  softChime: true,
});

/**
 * Categories whose default did not change when briefed asks came in: a saved choice for one of
 * them (an away-digest opt-out, a quota opt-in) was the operator's own.
 */
const KEPT_FROM_BEFORE_ASKS: readonly NotificationCategory[] = ["awayDigest", "quota"];

/**
 * The categories to use from saved ones. Saved before briefed asks (no `asks` key), the rest were
 * the old notify-everything defaults: today's defaults apply to them. Otherwise each known saved
 * choice is kept and a category added since takes its default.
 */
function storedCategories(
  saved: Record<string, boolean>,
  defaults: NotificationPreferences["categories"],
): NotificationPreferences["categories"] {
  const categories = { ...defaults };
  const kept =
    "asks" in saved ? (Object.keys(defaults) as NotificationCategory[]) : KEPT_FROM_BEFORE_ASKS;
  for (const c of kept) {
    const on = saved[c];
    if (typeof on === "boolean") categories[c] = on;
  }
  return categories;
}

/** Categories that notify through quiet hours. */
const BYPASS_QUIET: ReadonlySet<NotificationCategory> = new Set(["stalls", "flightDown"]);

/** An item FLIGHT has briefed for the operator (a brief with no `for` predates triage, and was). */
const briefedAsk = (item: AttentionItem): boolean =>
  item.brief !== undefined && item.brief.for !== "flight";

const categoryOf = (item: AttentionItem): NotificationCategory | null => {
  if (FLIGHT_DOWN_ITEMS.has(item.key)) return "flightDown";
  if (briefedAsk(item)) return "asks";
  switch (item.kind) {
    case "tag":
      return "capcom";
    case "person":
      return "people";
    case "decision":
    case "question":
    case "approval":
      return "decisions";
    case "stalled":
    case "lock":
    case "blocked":
    case "parked":
      return "stalls";
    case "pr":
    case "review":
    case "ready":
      return "prs";
    default:
      return null;
  }
};

/**
 * How an item is told apart from the one last notified. An ask is its question: a refreshed brief
 * with the same ask is not new, and its `at` is left out because it can move with the item.
 */
function versionOf(category: NotificationCategory, item: AttentionItem): string {
  if (category === "asks")
    return JSON.stringify([category, item.kind, item.brief?.ask ?? item.text]);
  if (category === "stalls") return JSON.stringify([item.kind, item.at]);
  return JSON.stringify([item.kind, item.text, item.at]);
}

/** Bumped when versionOf changes: the first reconcile after adopts versions without notifying. */
const VERSION_FORMAT = 2;

function quietAt(p: NotificationPreferences, at: number): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: p.quietHours.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const time = `${parts.find((p) => p.type === "hour")?.value}:${parts.find((p) => p.type === "minute")?.value}`;
  const { start, end } = p.quietHours;
  return start < end ? time >= start && time < end : start > end && (time >= start || time < end);
}

/** Local events only: delivery to devices is a separate transport. */
export class LocalNotifications {
  private readonly state: {
    seen: Record<string, string>;
    events: NotificationEvent[];
    away: boolean;
    /** versionOf's format the seen versions were written in; absent before VERSION_FORMAT 2. */
    format?: number;
  };
  private publishing = false;
  private readonly store: Store;
  private readonly config: CcConfig;
  private readonly bus: ChangeBus;
  private readonly now: () => number;

  constructor(store: Store, config: CcConfig, bus: ChangeBus, now: () => number) {
    this.store = store;
    this.config = config;
    this.bus = bus;
    this.now = now;
    this.state = JSON.parse(
      store.getSetting("notification-events") ?? '{"seen":{},"events":[],"away":false}',
    );
  }

  preferences(): NotificationPreferences {
    const defaults = defaultNotificationPreferences(this.config.operator.timezone);
    const raw = this.store.getSetting("notification-preferences");
    if (raw === null) return defaults;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      // emit runs from a timer: a bad setting must not throw there
      return defaults;
    }
    const parsed = NotificationPreferencesBody.safeParse(json);
    if (parsed.success) return { ...parsed.data, enabled: parsed.data.enabled ?? true };
    const stored = StoredPreferences.safeParse(json);
    return stored.success
      ? {
          ...stored.data,
          enabled: stored.data.enabled ?? true,
          categories: storedCategories(stored.data.categories, defaults.categories),
        }
      : defaults;
  }

  setPreferences(p: NotificationPreferences): void {
    this.store.setSetting("notification-preferences", JSON.stringify(p));
    this.bus.emit("settings");
  }

  events(): NotificationEvent[] {
    return this.state.events;
  }

  private save(): void {
    this.store.setSetting("notification-events", JSON.stringify(this.state));
  }

  private emit(
    category: NotificationCategory,
    text: string,
    test = false,
  ): NotificationEvent | null {
    const p = this.preferences();
    if (
      !test &&
      (p.enabled === false ||
        !p.categories[category] ||
        (!BYPASS_QUIET.has(category) && quietAt(p, this.now())))
    )
      return null;
    const event: NotificationEvent = {
      id: randomUUID(),
      category,
      at: this.now(),
      text,
      softChime: p.softChime,
      ...(test ? { test: true } : {}),
    };
    this.state.events = [...this.state.events, event].slice(-100);
    this.save();
    this.publishing = true;
    try {
      this.bus.emit("attention");
    } finally {
      this.publishing = false;
    }
    return event;
  }

  test(): NotificationEvent {
    return this.emit("people", "Mission Control · Test notification", true) as NotificationEvent;
  }

  reconcile(items: AttentionItem[]): void {
    if (this.publishing) return;
    const seen: Record<string, string> = {};
    const adopt = this.state.format !== VERSION_FORMAT;
    const p = this.preferences();
    const quiet = quietAt(p, this.now());
    for (const item of items) {
      const category = categoryOf(item);
      if (category === null || (item.owner !== undefined && item.owner !== "operator")) continue;
      const version = versionOf(category, item);
      const previous = this.state.seen[item.key];
      // Updating to a new version format must not replay every open item.
      if (adopt && previous !== undefined) {
        seen[item.key] = version;
        continue;
      }
      if (previous === version || item.acked) {
        seen[item.key] = version;
        continue;
      }
      // An ask held back by quiet hours stays unseen, so it notifies once they end.
      if (category === "asks" && quiet && p.enabled !== false && p.categories.asks) {
        if (previous !== undefined) seen[item.key] = previous;
        continue;
      }
      seen[item.key] = version;
      this.emit(category, category === "asks" ? (item.brief?.ask ?? item.text) : item.text);
    }
    for (const account of this.config.accounts) {
      for (const window of ["5h", "7d"] as const) {
        const sample = this.store.latestUsage(account.id, window);
        if (!sample || sample.pct <= 90 || sample.resetAt <= this.now()) continue;
        const key = `quota:${account.id}:${window}`;
        const version = String(sample.resetAt);
        seen[key] = version;
        if (this.state.seen[key] !== version)
          this.emit("quota", `Quota above 90% · ${account.id} · ${window}`);
      }
    }
    const away = activeAway(this.store, this.now(), this.config.operator.timezone) !== null;
    if (this.state.away && !away) this.emit("awayDigest", "The away-mode digest when I come back");
    this.state.away = away;
    this.state.seen = seen;
    this.state.format = VERSION_FORMAT;
    this.save();
  }
}
