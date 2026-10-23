import { randomUUID } from "node:crypto";
import type {
  AttentionItem,
  NotificationCategory,
  NotificationEvent,
  NotificationPreferences,
} from "@mc/core";
import { z } from "zod";
import type { ChangeBus } from "./bus.ts";
import type { CcConfig } from "./config.ts";
import type { Store } from "./store.ts";

const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const NotificationPreferencesBody = z.strictObject({
  enabled: z.boolean().optional(),
  categories: z.strictObject({
    people: z.boolean(),
    decisions: z.boolean(),
    stalls: z.boolean(),
    prs: z.boolean(),
    capcom: z.boolean(),
    awayDigest: z.boolean(),
    quota: z.boolean(),
    agentMessages: z.boolean(),
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

const defaultNotificationPreferences = (timezone: string): NotificationPreferences => ({
  enabled: true,
  categories: {
    people: true,
    decisions: true,
    stalls: true,
    prs: true,
    capcom: true,
    awayDigest: true,
    quota: false,
    agentMessages: false,
  },
  quietHours: { start: "19:00", end: "08:00", timezone, stallsBypass: true },
  softChime: true,
});

const categoryOf = (item: AttentionItem): NotificationCategory | null => {
  switch (item.kind) {
    case "tag":
      return "capcom";
    case "message":
      return "agentMessages";
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
    const raw = this.store.getSetting("notification-preferences");
    const parsed = raw === null ? null : NotificationPreferencesBody.safeParse(JSON.parse(raw));
    return parsed?.success
      ? { ...parsed.data, enabled: parsed.data.enabled ?? true }
      : defaultNotificationPreferences(this.config.operator.timezone);
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
        (category !== "stalls" && quietAt(p, this.now())))
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
    for (const item of items) {
      const category = categoryOf(item);
      if (category === null || (item.owner !== undefined && item.owner !== "operator")) continue;
      const version =
        category === "stalls"
          ? JSON.stringify([item.kind, item.at])
          : JSON.stringify([item.kind, item.text, item.at]);
      seen[item.key] = version;
      if (this.state.seen[item.key] !== version && !item.acked) this.emit(category, item.text);
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
    const away = JSON.parse(this.store.getSetting("away") ?? '{"on":false}').on === true;
    if (this.state.away && !away) this.emit("awayDigest", "The away-mode digest when I come back");
    this.state.away = away;
    this.state.seen = seen;
    this.save();
  }
}
