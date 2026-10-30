import {
  type ConfigView,
  PREVIEW_SERVER,
  UP_TO_DATE_MAIN,
  UPDATE_UNAVAILABLE,
  type VersionInfo,
} from "@mc/core";
import { useState } from "react";
import { ApiError, apiPost } from "../api.ts";
import { useNow, useTz } from "../clock.ts";
import { CrewPauseControl } from "../components/CrewPause.tsx";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { plural, rel, shortSha } from "../fmt.ts";
import { navigate, type SetupTab, setupPath } from "../router.ts";
import { Access } from "../setup/Access.tsx";
import { Accounts } from "../setup/Accounts.tsx";
import { Loops } from "../setup/Loops.tsx";
import { Repos } from "../setup/Repos.tsx";
import { Roles } from "../setup/Roles.tsx";
import { Sessions } from "../setup/Sessions.tsx";
import { Sources } from "../setup/Sources.tsx";
import { UpdateLogModal } from "../setup/UpdateLog.tsx";
import { BuildChips } from "../shell/buildStatus.tsx";
import { toast } from "../shell/Toast.tsx";
import "../setup/setup.css";

const TAB_LABEL: Record<SetupTab, string> = {
  sessions: "Sessions",
  repos: "Repos",
  loops: "Loops",
  accounts: "Accounts",
  roles: "Roles, guard and test lock",
  sources: "Sources",
  access: "Access and notifications",
};

/** The approved Setup information architecture. Legacy paths below remain valid deep links. */
const SECTIONS = [
  { tab: "accounts", label: "Accounts" },
  { tab: "repos", label: "Repos & seats" },
  { tab: "roles", label: "Roles" },
  { tab: "loops", label: "Loops" },
  { tab: "sources", label: "Sources" },
  { tab: "access", label: "Safety" },
] as const;

const sectionFor = (tab: SetupTab): SetupTab => {
  if (tab === "sessions") return "repos";
  return tab;
};

const UPDATE_CONFIRM = "Update to the latest main and restart? Crew runs resume after the restart.";
const UPDATING = "Updating… the HUD reconnects when the hub is back.";

/** A failed check: the 502 carries `checkedAt`, shown in relative time like the toolbar's. */
function checkError(err: unknown, now: number, tz: string | null): string {
  if (err instanceof ApiError && err.status === 502 && tz) {
    const at = (err.body as { checkedAt?: unknown } | undefined)?.checkedAt;
    if (typeof at === "number") return `Could not reach origin; last checked ${rel(at, now, tz)}.`;
    if (at === null) return "Could not reach origin; no earlier check.";
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * `Version {sha7} · {n} commits behind main · checked {when}`, [Check for updates] and [Update].
 * Check fetches origin/main now (disabled, with the reason as its title, on a preview or with no
 * updater; a failed fetch toasts the server's 502 in relative time). Update pulls main, builds and
 * restarts the hub on the operator's confirm, and is enabled only when main is ahead: disabled, with the
 * server's reason as its title, when there is nothing to pull or the hub may not update.
 */
function UpdateControl() {
  const { data: v } = useResource<VersionInfo>(RESOURCES.version);
  const tz = useTz();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  if (!v) return null;
  const behind =
    v.behind === null
      ? " · could not compare with main"
      : v.behind > 0
        ? ` · ${plural(v.behind, "commit")} behind main`
        : "";
  const checkOff = v.reason === PREVIEW_SERVER || v.reason === UPDATE_UNAVAILABLE;
  const checked = v.checkedAt !== null && tz ? ` · checked ${rel(v.checkedAt, now, tz)}` : "";
  async function check() {
    setChecking(true);
    try {
      const out = await apiPost<VersionInfo>(ACTIONS.versionCheck);
      hub.refetch(RESOURCES.version.path);
      // from the reason, not the count: 0 behind with an update waiting is not "up to date"
      toast(
        out.behind === null
          ? "Could not compare with main."
          : out.reason === UP_TO_DATE_MAIN
            ? UP_TO_DATE_MAIN
            : out.behind === 0
              ? "No new commits on main."
              : `${plural(out.behind, "commit")} behind main.`,
      );
    } catch (err) {
      toast(checkError(err, now, tz));
    }
    setChecking(false);
  }
  async function update() {
    if (!window.confirm(UPDATE_CONFIRM)) return;
    setBusy(true);
    try {
      const out = await apiPost<{ upToDate?: true; restarting?: true }>(ACTIONS.update);
      if (out.restarting) {
        // stays busy: the hub is going down, and the SSE reconnect brings the page back
        toast(UPDATING);
        return;
      }
      toast(UP_TO_DATE_MAIN);
      hub.refetch(RESOURCES.version.path);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
      // a failed step: its output is the why
      if (err instanceof ApiError && err.status === 500) setLogOpen(true);
    }
    setBusy(false);
  }
  return (
    <>
      <span className="s fg2">{`Version ${shortSha(v.sha) || "—"}${behind}${checked}`}</span>
      <button
        type="button"
        className="sm"
        disabled={checking || checkOff}
        title={checkOff ? (v.reason ?? undefined) : undefined}
        onClick={() => void check()}
      >
        Check for updates
      </button>
      <button
        type="button"
        className="sm"
        disabled={!v.canUpdate || busy}
        title={v.canUpdate ? undefined : (v.reason ?? undefined)}
        onClick={() => void update()}
      >
        Update
      </button>
      <button type="button" className="sm" onClick={() => setLogOpen(true)}>
        Update log
      </button>
      <UpdateLogModal open={logOpen} onClose={() => setLogOpen(false)} />
    </>
  );
}

/** Setup (catalogue §2.7): sessions, crew controls and hub settings. */
export function Setup({ tab }: { tab: SetupTab }) {
  const { data: config, error } = useResource<ConfigView>(RESOURCES.config);
  const section = sectionFor(tab);
  const loading = !config ? (
    <p className="muted s">{error ? `Could not load the config: ${error.message}` : "Loading…"}</p>
  ) : null;

  const body =
    // The legacy Sessions deep link keeps its original page. Sidebar routes remain narrowly
    // scoped so changing loop configuration never looks like it also changes source integrations.
    tab === "sessions" ? (
      config ? (
        <Sessions config={config} />
      ) : (
        loading
      )
    ) : tab === "sources" ? (
      <Sources config={config} error={error} />
    ) : tab === "access" ? (
      <Access />
    ) : tab === "accounts" ? (
      config ? (
        <Accounts config={config} />
      ) : (
        loading
      )
    ) : tab === "repos" ? (
      config ? (
        <Repos config={config} />
      ) : (
        loading
      )
    ) : tab === "roles" ? (
      <Roles />
    ) : config ? (
      <Loops config={config} />
    ) : (
      loading
    );
  return (
    <section id="page-setup" aria-label="Setup">
      <h1 className="sr-only">Setup</h1>
      <aside className="panel setup-sidebar">
        <div className="ph">
          <h2>Setup</h2>
          <span className="sub">dependency order</span>
        </div>
        <nav className="setup-nav" aria-label="Setup sections">
          {SECTIONS.map((item) => {
            const on = section === item.tab;
            return (
              <button
                type="button"
                key={item.tab}
                aria-current={on ? "page" : undefined}
                onClick={() => navigate(setupPath(item.tab))}
              >
                {item.label}
              </button>
            );
          })}
        </nav>
      </aside>
      <div className="panel setup-main">
        <div className="setup-content scroll">
          <div className="setup-title toolbar">
            <h2>{SECTIONS.find((item) => item.tab === section)?.label ?? TAB_LABEL[tab]}</h2>
            <BuildChips panel={`setup-${tab}`} />
            <span className="spacer" />
            <CrewPauseControl />
            <UpdateControl />
          </div>
          <div className="sgrid">{body}</div>
        </div>
      </div>
    </section>
  );
}
