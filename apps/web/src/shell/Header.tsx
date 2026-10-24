import {
  type AttentionItem,
  type AwaySettings,
  type ConfigView,
  type Crew,
  LOCK_HEADER_TITLE,
  lockHeaderText,
  type MachineSample,
} from "@mc/core";
import { type ReactNode, useEffect, useMemo, useSyncExternalStore } from "react";
import { operatorItems } from "../attention.ts";
import { useSecond } from "../clock.ts";
import { useTestLock } from "../components/LockLines.tsx";
import { needsLamp } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { waitingAsks } from "../flight/conversation.ts";
import type { FlightView } from "../flight/flightTypes.ts";
import { hms, MONTHS } from "../fmt.ts";
import { Lamp } from "../hud/Lamp.tsx";
import { followLink, navigate, PAGE_PATHS, type Page } from "../router.ts";
import { useSeatName } from "../seatName.ts";
import { currentTheme, nextTheme, setTheme, subscribeTheme, type ThemeChoice } from "../theme.ts";
import { LiveIndicator } from "./LiveIndicator.tsx";
import { openAway, useDock } from "./overlays.ts";
import { resetSession, SESSION_ALL, useSession, useSessions } from "./session.ts";
import { toast } from "./Toast.tsx";

const TABS: readonly { page: Page; label: string; needs?: (i: AttentionItem) => boolean }[] = [
  { page: "overview", label: "Overview" },
  { page: "flight", label: "FLIGHT", needs: (i) => i.kind === "decision" || i.kind === "person" },
  { page: "board", label: "Board", needs: (i) => i.kind === "pr" || i.escalationId !== null },
  { page: "agent", label: "Agent" },
  { page: "comms", label: "Comms", needs: () => true },
  { page: "telemetry", label: "Telemetry" },
];

/** The top bar (catalogue §1.1), in the mockup's order. */
export function Header({ page }: { page: Page }) {
  const attention = operatorItems(useResource<AttentionItem[]>(RESOURCES.attention).data ?? []);
  return (
    <header className="top">
      <span className="brand">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle className="ring" cx="10" cy="10" r="8.5" fill="none" strokeWidth="1.5" />
          <path
            className="ring"
            d="M10 3.5v3M10 13.5v3M3.5 10h3M13.5 10h3"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <circle className="dot" cx="10" cy="10" r="2.2" />
        </svg>
        Mission Control
      </span>
      <SessionSelect />
      <nav className="tabs" aria-label="Pages">
        {TABS.map((t) => (
          <Tab key={t.page} to={PAGE_PATHS[t.page]} on={page === t.page}>
            {t.label}
            {t.needs && <NeedsLamp items={attention.filter(t.needs)} />}
          </Tab>
        ))}
      </nav>
      <span className="spacer" />
      <LiveIndicator />
      <Met />
      <MachineButton />
      <NeedsButton items={attention} />
      <AwayButton />
      <ThemeButton />
      <button
        type="button"
        className={`ghost iconbtn${page === "setup" ? " on" : ""}`}
        title="Setup: sessions, loops, accounts, guard, access and notifications"
        aria-label="Setup"
        onClick={() => navigate(PAGE_PATHS.setup)}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M2 4h12M2 8h12M2 12h12"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <circle className="knob" cx="5" cy="4" r="1.7" stroke="currentColor" strokeWidth="1.5" />
          <circle className="knob" cx="11" cy="8" r="1.7" stroke="currentColor" strokeWidth="1.5" />
          <circle className="knob" cx="7" cy="12" r="1.7" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      <DockButton />
    </header>
  );
}

function Tab({ to, on, children }: { to: string; on: boolean; children: ReactNode }) {
  return (
    <a
      href={to}
      className={on ? "on" : undefined}
      aria-current={on ? "page" : undefined}
      onClick={(e) => followLink(e, to)}
    >
      {children}
    </a>
  );
}

/** A tab's lamp; tab lamps never pulse (catalogue 1.1): the Needs-you button carries the pulse. */
function NeedsLamp({ items }: { items: AttentionItem[] }) {
  const lamp = needsLamp(items, false);
  return lamp ? <Lamp {...lamp} /> : null;
}

function SessionSelect() {
  const sessions = useSessions();
  const [session, setSession] = useSession();
  const configLoaded = useResource<ConfigView>(RESOURCES.config).data !== undefined;
  // A chosen session that has since been removed falls back to all sessions, not empty pages.
  useEffect(() => {
    if (configLoaded && session !== SESSION_ALL && !sessions.some((s) => s.id === session)) {
      resetSession();
    }
  }, [configLoaded, session, sessions]);
  return (
    <select
      id="sess"
      aria-label="Session"
      value={session}
      onChange={(e) => setSession(e.target.value)}
    >
      <option value={SESSION_ALL}>All sessions</option>
      {sessions.map((r) => (
        <option key={r.id} value={r.id}>
          {`s/${r.id}`}
        </option>
      ))}
    </select>
  );
}

/** Mission elapsed time: since the first run started today (operator's timezone). */
function Met() {
  const now = useSecond();
  const first = useResource<Crew>(RESOURCES.crew).data?.firstRunToday ?? null;
  return (
    <span className="met" title="Mission elapsed time: since the first agent started today">
      MET <b className="num">{first === null ? "—" : hms(now - first)}</b>
    </span>
  );
}

const LOCK_STALLED_TITLE = "The run holding the lock is stalled";

const pct = (n: number | null): string => (n === null ? "—" : `${Math.round(n)}%`);

function MachineButton() {
  const nameOf = useSeatName();
  const m = useResource<{ latest: MachineSample | null }>(RESOURCES.machine).data?.latest ?? null;
  const lock = useTestLock();
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const holderStalled =
    lock?.holder != null &&
    crew?.rows.find((r) => r.id === lock.holder?.seatId)?.hudState === "stalled";
  // Blocked: the holder is stalled and someone is queued behind it.
  const blocked = holderStalled && (lock?.waiting.length ?? 0) > 0;
  const lockText =
    lock === undefined
      ? "Lock: —"
      : lockHeaderText(
          lock.holder === null ? null : nameOf(lock.holder.seatId),
          lock.waiting.length,
        );
  const ram =
    m && m.memUsedBytes !== null && m.memTotalBytes > 0
      ? (100 * m.memUsedBytes) / m.memTotalBytes
      : null;
  return (
    <button
      type="button"
      className={`mach-btn${blocked ? " hot" : ""}`}
      title="Machine and test lock (on Overview)"
      onClick={() => {
        navigate(PAGE_PATHS.overview);
        // once the Overview has rendered
        setTimeout(() => document.getElementById("machP")?.scrollIntoView?.({ block: "nearest" }));
      }}
    >
      <span className="num">{`CPU ${pct(m?.cpuPct ?? null)}`}</span>
      <span className="num">{`RAM ${pct(ram)}`}</span>
      <span title={holderStalled ? LOCK_STALLED_TITLE : LOCK_HEADER_TITLE}>{lockText}</span>
    </button>
  );
}

function NeedsButton({ items }: { items: AttentionItem[] }) {
  const notAcked = items.filter((i) => !i.acked).length;
  const unacked = notAcked > 0;
  const lamp = needsLamp(items, unacked);
  // The accessible name starts with the visible "Needs you {n}" (WCAG 2.5.3), then says more.
  const n = items.length;
  const what = n === 0 ? "nothing" : `${n} ${n === 1 ? "thing" : "things"}`;
  const label = `Needs you ${n}: ${what}${unacked ? ", some not yet acknowledged" : ""}. Opens Comms.`;
  return (
    <button
      type="button"
      className={`needs-btn${items.length ? " has" : ""}`}
      title={`Everything waiting on you (on Comms)${unacked ? ` · ${notAcked} not acknowledged` : ""}`}
      aria-label={label}
      onClick={() => navigate(PAGE_PATHS.comms)}
    >
      {lamp ? (
        <Lamp {...lamp} title={false} />
      ) : (
        <Lamp kind="off" label="nothing needs you" title={false} />
      )}
      Needs you <b>{items.length}</b>
    </button>
  );
}

/** `until` is a calendar date (`YYYY-MM-DD`): shown as that date, whatever the zone. */
function untilShort(until: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(until);
  const month = MONTHS[Number(m?.[2]) - 1];
  return m && month ? `${Number(m[3])} ${month}` : null;
}

function AwayButton() {
  const away = useResource<AwaySettings>(RESOURCES.away).data;
  const on = away?.on === true;
  const until = on ? untilShort(away.until) : null;
  return (
    <button
      type="button"
      className={on ? "warn" : "ghost"}
      title="Away mode: what Mission Control may do while you're away"
      onClick={openAway}
    >
      {on ? `Away · ${until ?? "on"}` : "Away mode"}
    </button>
  );
}

const THEME_NAME: Record<ThemeChoice, string> = {
  system: "follow the system",
  light: "light",
  dark: "dark",
};
const THEME_TOAST: Record<ThemeChoice, string> = {
  system: "follows the system",
  light: "light",
  dark: "dark",
};

function ThemeButton() {
  // a store read, so a change between the first render and the subscription is not missed
  const choice = useSyncExternalStore(subscribeTheme, currentTheme);
  const label = `Theme: ${THEME_NAME[choice]}. Click to change.`;
  return (
    <button
      type="button"
      className="ghost iconbtn"
      title={label}
      aria-label={label}
      onClick={() => {
        const next = nextTheme(choice);
        setTheme(next);
        toast(`Theme: ${THEME_TOAST[next]}.`);
      }}
    >
      <ThemeIcon choice={choice} />
    </button>
  );
}

function ThemeIcon({ choice }: { choice: ThemeChoice }) {
  const line = { stroke: "currentColor", strokeWidth: 1.5, fill: "none" } as const;
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      {choice === "light" && (
        <>
          <circle cx="8" cy="8" r="3" {...line} />
          <path
            d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3"
            {...line}
            strokeLinecap="round"
          />
        </>
      )}
      {choice === "dark" && (
        <path
          d="M13 9.8A5.5 5.5 0 0 1 6.2 3 5.5 5.5 0 1 0 13 9.8z"
          {...line}
          strokeLinejoin="round"
        />
      )}
      {choice === "system" && (
        <>
          <rect x="1.8" y="2.5" width="12.4" height="8.5" rx="1.5" {...line} />
          <path d="M5.5 14h5M8 11v3" {...line} strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

/** FLIGHT's chat: toggles the dock; an amber badge counts the asks FLIGHT has put to you. */
function DockButton() {
  const dock = useDock();
  const attention = useResource<AttentionItem[]>(RESOURCES.attention).data;
  const decisions = useResource<FlightView>(RESOURCES.flight).data?.decisions;
  const waiting = useMemo(
    () => waitingAsks(attention ?? [], decisions ?? []).length,
    [attention, decisions],
  );
  return (
    <button
      type="button"
      className={`iconbtn${dock.visible ? " on" : ""}`}
      title="Show or hide FLIGHT's chat (f)"
      aria-label={waiting > 0 ? `FLIGHT chat, ${waiting} waiting on you` : "FLIGHT chat"}
      aria-pressed={dock.visible}
      onClick={dock.toggle}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M2.5 3h11v7.5H8l-3 2.5v-2.5H2.5z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
      {waiting > 0 && <span className="dock-unread">{waiting}</span>}
    </button>
  );
}
