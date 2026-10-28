import {
  type AttentionItem,
  type AwaySettings,
  type ConfigView,
  type Crew,
  type LimitRow,
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
import { FULL_WIDTH_PAGES, followLink, navigate, PAGE_PATHS, type Page } from "../router.ts";
import { useSeatName } from "../seatName.ts";
import { currentTheme, nextTheme, setTheme, subscribeTheme, type ThemeChoice } from "../theme.ts";
import { LiveIndicator } from "./LiveIndicator.tsx";
import { openAway, useDock } from "./overlays.ts";
import { resetSession, SESSION_ALL, useSession, useSessions } from "./session.ts";
import { toast } from "./Toast.tsx";

const TABS: readonly {
  page: Page;
  label: string;
  to: string;
  needs?: (i: AttentionItem) => boolean;
}[] = [
  { page: "overview", label: "Overview", to: PAGE_PATHS.overview },
  { page: "flight", label: "Flight", to: PAGE_PATHS.flight },
  {
    page: "board",
    label: "Board",
    to: PAGE_PATHS.board,
    needs: (i) => i.kind === "pr" || i.escalationId !== null,
  },
  { page: "agent", label: "Agents", to: PAGE_PATHS.agent },
  { page: "map", label: "Map", to: PAGE_PATHS.map },
  { page: "comms", label: "Comms", to: PAGE_PATHS.comms, needs: () => true },
  { page: "telemetry", label: "Telemetry", to: PAGE_PATHS.telemetry },
];

/** The top bar (catalogue §1.1), in the mockup's order. */
export function Header({ page }: { page: Page }) {
  const attention = operatorItems(useResource<AttentionItem[]>(RESOURCES.attention).data ?? []);
  return (
    <header className="top">
      <span className="brand">MISSION CONTROL</span>
      <nav className="tabs" aria-label="Pages">
        {TABS.map((t) => (
          <Tab key={t.label} to={t.to} on={page === t.page}>
            {t.label}
            {t.needs && <NeedsLamp items={attention.filter(t.needs)} />}
          </Tab>
        ))}
      </nav>
      <span className="spacer" />
      <div className="top-status">
        <Usage />
        <Clock />
        <MachineButton />
        <SessionSelect />
        <NeedsButton items={attention} />
        <AwayButton />
        <ThemeButton />
        <SetupButton on={page === "setup"} />
        <DockButton page={page} />
      </div>
      <span className="sr-only">
        <LiveIndicator />
        <Met />
      </span>
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

/** Configuration stays out of the operational page tabs. */
function SetupButton({ on }: { on: boolean }) {
  return (
    <button
      type="button"
      className={`ghost iconbtn${on ? " on" : ""}`}
      title="Setup: sessions, loops, accounts, guard, access and notifications"
      aria-label="Setup"
      aria-pressed={on}
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
  );
}

/** Compact provider usage in the approved top bar. A missing reading stays an honest dash. */
function Usage() {
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const limits = useResource<LimitRow[]>(RESOURCES.limits).data ?? [];
  const used = (vendor: "claude" | "codex") => {
    const ids = new Set(config?.accounts.filter((a) => a.vendor === vendor).map((a) => a.id) ?? []);
    const rows = limits.filter((row) => ids.has(row.accountId) && row.window === "7d");
    return rows.length > 0 ? `${Math.round(Math.max(...rows.map((row) => row.used)))}%` : "—";
  };
  return (
    <span
      className="usage"
      role="img"
      aria-label={`Claude ${used("claude")}; Codex ${used("codex")}`}
    >
      <span>
        CLAUDE <b className="usage-claude">{used("claude")}</b>
      </span>
      <span>
        CODEX <b className="usage-codex">{used("codex")}</b>
      </span>
    </span>
  );
}

function Clock() {
  const now = useSecond();
  const tz = useResource<ConfigView>(RESOURCES.config).data?.operator.timezone;
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: tz,
  }).format(now);
  return <time className="top-clock">{time}</time>;
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

/** Kept as a keyboard and assistive shortcut; the approved shell keeps status in Overview. */
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
    crew?.rows.find((row) => row.id === lock.holder?.seatId)?.hudState === "stalled";
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
  const status = `CPU ${pct(m?.cpuPct ?? null)}, RAM ${pct(ram)}, ${lockText}`;
  const label = `Machine status: ${status}. Opens Overview.`;
  const lockExplanation = holderStalled
    ? `${LOCK_STALLED_TITLE}. ${LOCK_HEADER_TITLE}.`
    : LOCK_HEADER_TITLE;
  return (
    <button
      type="button"
      className={`mach-btn iconbtn${holderStalled && lock && lock.waiting.length > 0 ? " hot" : ""}`}
      aria-label={label}
      aria-describedby="machine-tooltip"
      onClick={() => {
        navigate(PAGE_PATHS.overview);
        setTimeout(() => document.getElementById("machP")?.scrollIntoView?.({ block: "nearest" }));
      }}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect
          x="2"
          y="2.5"
          width="12"
          height="8.5"
          rx="1.25"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M5.5 13.5h5M8 11v2.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
      <span id="machine-tooltip" className="mach-tooltip" role="tooltip">
        <span>{status}</span>
        <span>{lockExplanation}</span>
      </span>
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

/** FLIGHT's chat: a dock toggle where mounted, otherwise its full Comms view. */
function DockButton({ page }: { page: Page }) {
  const dock = useDock();
  const attention = useResource<AttentionItem[]>(RESOURCES.attention).data;
  const decisions = useResource<FlightView>(RESOURCES.flight).data?.decisions;
  const waiting = useMemo(
    () => waitingAsks(attention ?? [], decisions ?? []).length,
    [attention, decisions],
  );
  const inComms = page === "comms";
  const fullWidth = FULL_WIDTH_PAGES.has(page);
  const title = inComms
    ? "FLIGHT chat is open in Comms"
    : fullWidth
      ? "Open FLIGHT chat in Comms (f)"
      : "Show or hide FLIGHT's chat (f)";
  return (
    <button
      type="button"
      className={`iconbtn${inComms || (!fullWidth && dock.visible) ? " on" : ""}`}
      title={title}
      aria-label={waiting > 0 ? `FLIGHT chat, ${waiting} waiting on you` : "FLIGHT chat"}
      aria-pressed={inComms ? true : fullWidth ? undefined : dock.visible}
      onClick={() => {
        if (fullWidth) navigate(PAGE_PATHS.comms);
        // Comms already is FLIGHT's full conversation; the dock is not mounted here.
        else if (!inComms) dock.toggle();
      }}
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
