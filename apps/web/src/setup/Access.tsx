import type { NotificationCategory, NotificationEvent, NotificationPreferences } from "@mc/core";
import { useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import { deliverNotification, enableBrowser, permissionState } from "../browserNotifications.ts";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { Panel } from "../hud/Panel.tsx";
import { toast } from "../shell/Toast.tsx";

const NOTIFY: [NotificationCategory, string][] = [
  ["people", "People asking me something in Teams or GitHub"],
  ["decisions", "Decisions waiting for me"],
  ["stalls", "Stalls and stuck runs"],
  ["prs", "PRs waiting on me"],
  ["capcom", "Anything tagged @CAPCOM"],
  ["awayDigest", "The away-mode digest when I come back"],
  ["quota", "Quota above 90%"],
  ["agentMessages", "Every agent message"],
];

const SAMPLES = [
  {
    text: "Example colleague asked you in Product rollout: per-client lanes before the Example customer pilot?",
    actions: ["Read the brief", "Open in Teams", "Later"],
  },
  {
    text: "Decision for you: lanes per customer, or one global list? (GUIDO-3, NW #2358)",
    actions: ["Read the brief", "Discuss", "Later"],
  },
  {
    text: "GUIDO-2's full-suite run has printed nothing for 11 min and holds the test lock.",
    actions: ["Stop the run", "Open"],
  },
];

const AUTO_APPROVE = [
  "GitHub comments",
  "Labels",
  "Board moves and Priority changes",
  "Starting and stopping agents",
  "Switching accounts",
];

type Edits = Partial<Omit<NotificationPreferences, "categories" | "quietHours">> & {
  categories?: Partial<NotificationPreferences["categories"]>;
  quietHours?: Partial<NotificationPreferences["quietHours"]>;
};

function applyEdits(base: NotificationPreferences, edits: Edits): NotificationPreferences {
  return {
    ...base,
    ...edits,
    categories: { ...base.categories, ...edits.categories },
    quietHours: { ...base.quietHours, ...edits.quietHours },
  };
}

function Preferences({ initial }: { initial: NotificationPreferences }) {
  const [edits, setEdits] = useState<Edits>({});
  const prefs = applyEdits(initial, edits);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [permission, setPermission] = useState(permissionState);
  async function save() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const latest = await apiGet<NotificationPreferences>(RESOURCES.notificationPreferences.path);
      await apiPost<NotificationPreferences>(
        ACTIONS.notificationPreferences,
        applyEdits(latest, edits),
      );
      setEdits({});
      hub.refetch(RESOURCES.notificationPreferences.path);
      hub.refetch(RESOURCES.notificationEvents.path);
      setMessage("Preferences saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "server unreachable");
    } finally {
      setBusy(false);
    }
  }
  async function enable(test: boolean) {
    setBusy(true);
    setError("");
    try {
      setPermission(await enableBrowser());
      if (test) {
        const event = await apiPost<NotificationEvent>(ACTIONS.notificationTest, {});
        deliverNotification(event, prefs);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "server unreachable");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="pb access-preferences">
      <label>
        <input
          type="checkbox"
          checked={prefs.enabled !== false}
          disabled={busy}
          onChange={(e) => setEdits({ ...edits, enabled: e.target.checked })}
        />{" "}
        Enable notifications
      </label>
      {NOTIFY.map(([key, label]) => (
        <label key={key} className="block s">
          <input
            type="checkbox"
            checked={prefs.categories[key]}
            disabled={busy}
            onChange={(e) =>
              setEdits({ ...edits, categories: { ...edits.categories, [key]: e.target.checked } })
            }
          />{" "}
          {label}
        </label>
      ))}
      <div className="row s">
        <span>Quiet hours</span>
        <label>
          Start{" "}
          <input
            aria-label="Quiet hours start"
            type="time"
            value={prefs.quietHours.start}
            disabled={busy}
            onChange={(e) =>
              setEdits({ ...edits, quietHours: { ...edits.quietHours, start: e.target.value } })
            }
            required
          />
        </label>
        <span>–</span>
        <label>
          End{" "}
          <input
            aria-label="Quiet hours end"
            type="time"
            value={prefs.quietHours.end}
            disabled={busy}
            onChange={(e) =>
              setEdits({ ...edits, quietHours: { ...edits.quietHours, end: e.target.value } })
            }
            required
          />
        </label>
        <span className="muted">{prefs.quietHours.timezone} · stalls still notify</span>
      </div>
      <label>
        <input
          type="checkbox"
          checked={prefs.softChime}
          disabled={busy}
          onChange={(e) => setEdits({ ...edits, softChime: e.target.checked })}
        />{" "}
        Soft chime
      </label>
      <div className="row">
        <button
          type="button"
          disabled={busy || !prefs.quietHours.start || !prefs.quietHours.end}
          onClick={() => void save()}
        >
          Save preferences
        </button>
        <button type="button" disabled={busy} onClick={() => void enable(false)}>
          Enable browser notifications
        </button>
        <button type="button" disabled={busy} onClick={() => void enable(true)}>
          Send a test notification
        </button>
      </div>
      <p className="note">
        Browser notifications{" "}
        {permission === "denied"
          ? "denied: allow them in browser settings; notifications appear in the app."
          : permission === "unsupported"
            ? "unsupported: notifications appear in the app."
            : permission === "granted"
              ? "permitted while this browser is open."
              : "need permission; notifications appear in the app until enabled."}{" "}
        Soft chime plays only when browser audio is permitted.
      </p>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

/** Setup › Access and notifications (catalogue 2.7.6). */
export function Access() {
  const resource = useResource<NotificationPreferences>(RESOURCES.notificationPreferences);
  return (
    <>
      <Panel title="Auto-approve" sub="outward writes wait for you until switched on" phase="P2">
        <div className="pb">
          {AUTO_APPROVE.map((label) => (
            <label key={label} className="block s">
              <input type="checkbox" disabled /> {label}
            </label>
          ))}
        </div>
      </Panel>
      <Panel
        className="wide"
        title="Devices"
        sub="Mission Control runs on the Mac; other devices arrive with Tailscale"
      >
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>Device</th>
                <th>Role</th>
                <th>Connects by</th>
                <th>Notifications</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Mac</td>
                <td>runs Mission Control and the agents</td>
                <td>this machine</td>
                <td>—</td>
                <td>now</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="note pb">Other devices arrive with Tailscale (phase 4).</p>
      </Panel>
      <Panel title="Notify me about" sub="in this open browser on this machine">
        {resource.data ? (
          <Preferences initial={resource.data} />
        ) : (
          <p className="pb">
            {resource.loading ? "Loading preferences…" : "No preferences loaded."}
          </p>
        )}
        {resource.error && (
          <div className="pb">
            <p role="alert">{resource.error.message}</p>
            <button
              type="button"
              onClick={() => hub.refetch(RESOURCES.notificationPreferences.path)}
            >
              Retry
            </button>
          </div>
        )}
        <p className="note pb">
          Keep this browser open for delivery. No closed-tab remote push delivery.
        </p>
      </Panel>
      <Panel title="What a notification looks like" sub="samples">
        <div className="pb">
          {SAMPLES.map((sample) => (
            <div className="notif" key={sample.text}>
              <b>Mission Control</b>
              <span className="s">{sample.text}</span>
              <div className="row">
                {sample.actions.map((action) => (
                  <button
                    type="button"
                    className="sm"
                    key={action}
                    onClick={() =>
                      toast(`Fictional sample: ${action} does not operate on a live item.`)
                    }
                  >
                    {action}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}
