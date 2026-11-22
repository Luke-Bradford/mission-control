import { useState } from "react";
import { apiPost } from "../api.ts";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { toast } from "../shell/Toast.tsx";

type Value = string | number | boolean | string[] | Record<string, string> | null;
type Settings = {
  base: string;
  values: Record<string, Value>;
  repos: Record<string, Record<string, Value>>;
};

const ROWS = [
  ["operator.timezone", "Time zone", "text", "Operator"],
  ["operator.github_logins", "GitHub logins", "list", "Operator"],
  ["poll.usage_minutes", "Usage poll", "number", "Polling"],
  ["poll.github_seconds", "GitHub poll", "number", "Polling"],
  ["poll.board_minutes", "Board poll", "number", "Polling"],
  ["crew.worktrees", "Crew folder", "text", "Crew"],
  ["crew.max_seats", "Maximum seats", "number", "Crew", "now"],
  ["crew.max_open_runs_per_seat", "Open runs per seat", "number", "Crew", "now"],
  ["crew.lane", "Crew lane", "text", "Crew", "now"],
  ["crew.lane_default", "Default lane", "text", "Crew", "now"],
] as const;

const textValue = (value: Value | undefined, kind: string) =>
  kind === "list" && Array.isArray(value) ? value.join("\n") : value == null ? "" : String(value);
const parseValue = (text: string, kind: string): Value =>
  kind === "number"
    ? Number(text)
    : kind === "list"
      ? text
          .split("\n")
          .map((v) => v.trim())
          .filter(Boolean)
      : text;

/** Hub-wide configuration. Server validation remains the authority for each setting. */
export function HubSettings() {
  const settings = useResource<Settings>(RESOURCES.hubSettings);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  if (!settings.data)
    return (
      <p className="muted s">{settings.error ? settings.error.message : "Loading hub settings…"}</p>
    );
  async function save(key: string, kind: string) {
    setSaving(key);
    try {
      await apiPost(ACTIONS.hubSettings, {
        base: settings.data?.base,
        key,
        value: parseValue(drafts[key] ?? textValue(settings.data?.values[key], kind), kind),
      });
      toast("Setting saved.");
      hub.refetch(RESOURCES.hubSettings.path);
      hub.refetch(RESOURCES.config.path);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(null);
    }
  }
  return (
    <section aria-label="Hub settings" className="setup-hub">
      {(["Operator", "Polling", "Crew"] as const).map((group) => (
        <fieldset className="fgroup" key={group}>
          <legend>{group}</legend>
          {ROWS.filter(([, , , rowGroup]) => rowGroup === group).map(
            ([key, label, kind, , applies]) => {
              const value = drafts[key] ?? textValue(settings.data?.values[key], kind);
              return (
                <div className="row" key={key}>
                  <label className="ffield" htmlFor={`hub-setting-${key}`}>
                    <span>{label}</span>
                    {kind === "list" ? (
                      <textarea
                        id={`hub-setting-${key}`}
                        aria-label={label}
                        value={value}
                        onChange={(e) => setDrafts({ ...drafts, [key]: e.target.value })}
                      />
                    ) : (
                      <input
                        id={`hub-setting-${key}`}
                        aria-label={label}
                        type={kind === "number" ? "number" : "text"}
                        value={value}
                        onChange={(e) => setDrafts({ ...drafts, [key]: e.target.value })}
                      />
                    )}
                  </label>
                  <span className="muted s">
                    {applies === "now" ? "Applies now" : "Applies after a restart"}
                  </span>
                  <button
                    className="sm"
                    type="button"
                    disabled={saving === key}
                    onClick={() => void save(key, kind)}
                    aria-label={`Save ${label}`}
                  >
                    {saving === key ? "Saving…" : "Save"}
                  </button>
                </div>
              );
            },
          )}
        </fieldset>
      ))}
    </section>
  );
}
