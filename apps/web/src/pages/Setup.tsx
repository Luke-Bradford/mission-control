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
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { rel } from "../fmt.ts";
import { Seg } from "../hud/Seg.tsx";
import { navigate, type SetupTab, setupPath } from "../router.ts";
import { Access } from "../setup/Access.tsx";
import { Accounts } from "../setup/Accounts.tsx";
import { Loops } from "../setup/Loops.tsx";
import { Repos } from "../setup/Repos.tsx";
import { Roles } from "../setup/Roles.tsx";
import { Sessions } from "../setup/Sessions.tsx";
import { Sources } from "../setup/Sources.tsx";
import { BuildChips } from "../shell/buildStatus.tsx";
import { toast } from "../shell/Toast.tsx";

const TAB_LABEL: Record<SetupTab, string> = {
  sessions: "Sessions",
  repos: "Repos",
  loops: "Loops",
  accounts: "Accounts",
  roles: "Roles, guard and test lock",
  sources: "Sources",
  access: "Access and notifications",
};
const TABS = (Object.keys(TAB_LABEL) as SetupTab[]).map((t) => ({ value: t, label: TAB_LABEL[t] }));

const UPDATE_CONFIRM = "Update to the latest main and restart? Crew runs resume after the restart.";
const UPDATING = "Updating… the HUD reconnects when the hub is back.";
const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;

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
  if (!v) return null;
  const behind =
    v.behind === null
      ? " · could not compare with main"
      : v.behind > 0
        ? ` · ${commits(v.behind)} behind main`
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
              : `${commits(out.behind)} behind main.`,
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
    }
    setBusy(false);
  }
  return (
    <>
      <span className="s fg2">{`Version ${v.sha.slice(0, 7) || "—"}${behind}${checked}`}</span>
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
    </>
  );
}

/** Setup (catalogue §2.7), read-only except Repos, where a repo is added to config.yaml. */
export function Setup({ tab }: { tab: SetupTab }) {
  const { data: config, error } = useResource<ConfigView>(RESOURCES.config);
  return (
    <section id="page-setup">
      <div className="toolbar">
        <h2>Setup</h2>
        <Seg label="Setup" options={TABS} value={tab} onChange={(t) => navigate(setupPath(t))} />
        <BuildChips panel={`setup-${tab}`} />
        <span className="spacer" />
        <UpdateControl />
      </div>
      <div className="sgrid">
        {tab === "sources" ? (
          <Sources config={config} error={error} />
        ) : tab === "repos" ? (
          <Repos />
        ) : tab === "roles" ? (
          <Roles />
        ) : tab === "access" ? (
          <Access />
        ) : !config ? (
          <p className="muted s">
            {error ? `Could not load the config: ${error.message}` : "Loading…"}
          </p>
        ) : tab === "sessions" ? (
          <Sessions config={config} />
        ) : tab === "loops" ? (
          <Loops config={config} />
        ) : (
          <Accounts config={config} />
        )}
      </div>
    </section>
  );
}
