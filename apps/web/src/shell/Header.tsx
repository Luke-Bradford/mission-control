import {
  type AwaySettings,
  type ConfigView,
  type Crew,
  type LimitRow,
  LOCK_HEADER_TITLE,
  lockHeaderText,
  type MachineSample,
} from "@mc/core";
import { type ReactNode, useEffect, useSyncExternalStore } from "react";
import { useNeedsCount } from "../attention.ts";
import { useSecond } from "../clock.ts";
import { useTestLock } from "../components/LockLines.tsx";
import { needsLamp, useSeatName } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { DEMO_MARKER_TEXT, useDemo } from "../demo/mode.ts";
import { hhmm, hms, MONTHS, percent, swapOfRam } from "../fmt.ts";
import { Lamp } from "../hud/Lamp.tsx";
import { FULL_WIDTH_PAGES, followLink, navigate, PAGE_PATHS, type Page } from "../router.ts";
import { currentTheme, nextTheme, setTheme, subscribeTheme, type ThemeChoice } from "../theme.ts";
import { LiveIndicator } from "./LiveIndicator.tsx";
import { useOperatorUnread } from "./operatorMessages.ts";
import { openAway, useDock } from "./overlays.ts";
import { resetSession, SESSION_ALL, useSession, useSessions } from "./session.ts";
import { toast } from "./Toast.tsx";

/** The page tabs carry no lamps except Needs you, the one lamp, which is itself a page. */
const TABS: readonly { page: Page; label: string; to: string }[] = [
  { page: "overview", label: "Overview", to: PAGE_PATHS.overview },
  { page: "needs", label: "Needs you", to: PAGE_PATHS.needs },
  { page: "flight", label: "Flight", to: PAGE_PATHS.flight },
  { page: "board", label: "Board", to: PAGE_PATHS.board },
  { page: "agent", label: "Agents", to: PAGE_PATHS.agent },
  { page: "map", label: "Map", to: PAGE_PATHS.map },
  { page: "comms", label: "Comms", to: PAGE_PATHS.comms },
  { page: "qa", label: "QA", to: PAGE_PATHS.qa },
  { page: "telemetry", label: "Telemetry", to: PAGE_PATHS.telemetry },
  { page: "audit", label: "Audit", to: PAGE_PATHS.audit },
];

/** The top bar (catalogue §1.1), in the mockup's order. */
export function Header({ page }: { page: Page }) {
  const unread = useOperatorUnread().length;
  const demo = useDemo();
  return (
    <header className="top">
      {demo ? <DemoMarker /> : <span className="brand">MISSION CONTROL</span>}
      <nav className="tabs" aria-label="Pages">
        {TABS.map((t) =>
          t.page === "needs" ? (
            <NeedsTab key={t.label} on={page === "needs"} />
          ) : (
            <Tab key={t.label} to={t.to} on={page === t.page}>
              {t.label}
            </Tab>
          ),
        )}
      </nav>
      <span className="spacer" />
      <div className="top-status">
        <Usage />
        <Clock />
        <MachineButton />
        <SessionSelect />
        <AwayButton />
        <ThemeButton />
        <SetupButton on={page === "setup"} />
        <DockButton page={page} unread={unread} />
      </div>
      <span className="sr-only">
        <LiveIndicator />
        <Met />
      </span>
    </header>
  );
}

/** Says on every page that the crew is simulated: the word, not only the colour. */
function DemoMarker() {
  return (
    <span
      className="brand demo-marker"
      role="img"
      aria-label={DEMO_MARKER_TEXT}
      title={DEMO_MARKER_TEXT}
    >
      DEMO
    </span>
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
    return rows.length > 0 ? percent(Math.max(...rows.map((row) => row.used))) : "—";
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
  return <time className="top-clock">{tz ? hhmm(now, tz) : "—"}</time>;
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

const gb = (n: number | null | undefined): string =>
  n == null ? "—" : String(Math.round((n / 2 ** 30) * 10) / 10);

function MachineButton() {
  const nameOf = useSeatName();
  const view = useResource<{ latest: MachineSample | null; warning?: string | null }>(
    RESOURCES.machine,
  ).data;
  const m = view?.latest ?? null;
  const warning = view?.warning ?? null;
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
  const status = `CPU ${percent(m?.cpuPct ?? null)}, RAM ${percent(ram)}, ${lockText}`;
  const held = warning === null ? null : `Holding new work: ${warning}`;
  const label = `Machine status: ${status}${held === null ? "" : `. ${held}`}. Opens Overview.`;
  const detail =
    m && (m.swapUsedBytes != null || m.diskFreeBytes !== null)
      ? `Swap ${swapOfRam(m.swapUsedBytes, m.memTotalBytes)}, Disk ${gb(m.diskFreeBytes)} GB free`
      : null;
  const lockExplanation = holderStalled
    ? `${LOCK_STALLED_TITLE}. ${LOCK_HEADER_TITLE}.`
    : LOCK_HEADER_TITLE;
  return (
    <button
      type="button"
      className={`mach-btn iconbtn${held !== null || (holderStalled && lock && lock.waiting.length > 0) ? " hot" : ""}`}
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
        {held !== null && <span>{held}</span>}
        {detail !== null && <span>{detail}</span>}
        <span>{lockExplanation}</span>
      </span>
    </button>
  );
}

/** The Needs you tab: the page's name, a lamp and the count, so a waiting ask shows on every page. */
function NeedsTab({ on }: { on: boolean }) {
  const { state, items, n } = useNeedsCount();
  const notAcked = items.filter((i) => !i.acked).length;
  const lamp = state === "ready" ? needsLamp(items, notAcked > 0) : null;
  const shown = state === "ready" ? String(n) : state === "loading" ? "…" : "—";
  const name =
    state === "ready"
      ? n === 0
        ? "Needs you: nothing waiting"
        : `Needs you: ${n} waiting`
      : state === "loading"
        ? "Needs you: loading"
        : "Needs you: count unavailable";
  return (
    <a
      href={PAGE_PATHS.needs}
      className={`${on ? "on " : ""}needs-tab${n ? " has" : ""}`}
      aria-current={on ? "page" : undefined}
      aria-label={name}
      title={`Everything waiting on you${notAcked > 0 ? ` · ${notAcked} not acknowledged` : ""}`}
      onClick={(e) => followLink(e, PAGE_PATHS.needs)}
    >
      {lamp ? (
        <Lamp {...lamp} title={false} />
      ) : (
        <Lamp kind="off" label="nothing needs you" title={false} />
      )}
      Needs you <b data-metric="needsYou">{shown}</b>
    </a>
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

/**
 * FLIGHT's chat: a dock toggle where mounted, otherwise its full Comms view. Its badge counts the
 * unread messages addressed to the operator (CAPCOM); the Needs you tab owns the waiting count.
 */
function DockButton({ page, unread }: { page: Page; unread: number }) {
  const dock = useDock();
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
      className={`iconbtn${inComms || (!fullWidth && dock.visible && !dock.collapsed) ? " on" : ""}`}
      title={title}
      aria-label={unread > 0 ? `FLIGHT chat, ${unread} unread to you` : "FLIGHT chat"}
      aria-pressed={inComms ? true : fullWidth ? undefined : dock.visible && !dock.collapsed}
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
      {unread > 0 && <span className="dock-unread">{unread}</span>}
    </button>
  );
}
