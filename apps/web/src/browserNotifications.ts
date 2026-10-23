import type { NotificationEvent, NotificationPreferences } from "@mc/core";
import { useEffect, useRef } from "react";
import { RESOURCES, useResource } from "./data.ts";
import { navigate } from "./router.ts";
import { toast } from "./shell/Toast.tsx";

export type BrowserPermission = NotificationPermission | "unsupported";
export const permissionState = (): BrowserPermission =>
  typeof Notification === "undefined" ? "unsupported" : Notification.permission;

let audio: AudioContext | undefined;
export async function enableBrowser(): Promise<BrowserPermission> {
  // Resume audio only inside the operator's enable/test gesture.
  if (typeof AudioContext !== "undefined") {
    try {
      audio ??= new AudioContext();
      void audio.resume().catch(() => {});
    } catch {
      // Browser notifications remain available when audio is blocked.
    }
  }
  return permissionState() === "default" ? Notification.requestPermission() : permissionState();
}

export function notificationTarget(event: NotificationEvent): string {
  return event.category === "quota"
    ? "/telemetry"
    : event.category === "agentMessages" || event.category === "capcom"
      ? "/comms"
      : "/flight";
}

export function showNotification(event: NotificationEvent, prefs: NotificationPreferences): void {
  if (permissionState() === "granted") {
    try {
      const notification = new Notification("Mission Control", {
        body: event.text,
        tag: event.id,
        silent: true,
      });
      notification.onclick = () => {
        window.focus();
        navigate(notificationTarget(event));
        notification.close();
      };
    } catch {
      toast(event.text);
    }
  } else {
    toast(event.text);
  }
  if (prefs.softChime && event.softChime !== false && audio?.state === "running") {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.frequency.value = 660;
    gain.gain.setValueAtTime(0.035, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.25);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start();
    oscillator.stop(audio.currentTime + 0.25);
  }
}

export function createDelivery(show = showNotification) {
  const seen = new Set<string>();
  const deliver = (event: NotificationEvent, prefs: NotificationPreferences) => {
    if (seen.has(event.id)) return;
    seen.add(event.id);
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: prefs.quietHours.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(event.at);
    const { start, end } = prefs.quietHours;
    const quiet =
      start < end ? time >= start && time < end : start > end && (time >= start || time < end);
    if (
      !event.test &&
      (prefs.enabled === false ||
        !prefs.categories[event.category] ||
        (quiet && event.category !== "stalls"))
    )
      return;
    show(event, prefs);
  };
  return Object.assign(deliver, {
    remember(events: NotificationEvent[]) {
      for (const event of events) seen.add(event.id);
    },
  });
}

export const deliverNotification = createDelivery();

export function BrowserNotifications() {
  const prefs = useResource<NotificationPreferences>(RESOURCES.notificationPreferences);
  const events = useResource<NotificationEvent[]>(RESOURCES.notificationEvents);
  const initialized = useRef(false);
  useEffect(() => {
    // Seed history as soon as the first feed arrives, even if preferences are still loading.
    if (!initialized.current && events.data && !events.loading && !events.error) {
      deliverNotification.remember(events.data);
      initialized.current = true;
    }
    // Cached data remains present during refreshes and after failures; it is not current.
    if (
      !prefs.data ||
      !events.data ||
      prefs.loading ||
      events.loading ||
      prefs.error ||
      events.error
    )
      return;
    for (const event of events.data) deliverNotification(event, prefs.data);
  }, [prefs.data, prefs.loading, prefs.error, events.data, events.loading, events.error]);
  return null;
}
