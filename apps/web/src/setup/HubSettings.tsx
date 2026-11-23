import {
  APPLIES_TEXT,
  CHOICE_LABELS,
  HUB_SETTINGS,
  type HubSettingDef,
  type HubSettingKey,
  type HubSettingsView,
} from "@mc/core";
import { useState } from "react";
import { apiPost } from "../api.ts";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { toast } from "../shell/Toast.tsx";

type Value = unknown;
/** Hub-wide keys; the `repo.*` ones live on each repo card. */
const HUB_KEYS = (Object.keys(HUB_SETTINGS) as HubSettingKey[]).filter(
  (key) => !key.startsWith("repo."),
);
/** Operator and Crew answer "how is this hub set up" first; the detail groups follow. */
const GROUP_ORDER = ["Operator", "Crew", "Polling", "Updates", "Audit", "Machine limits"];
const GROUPS = [...new Set(HUB_KEYS.map((key) => HUB_SETTINGS[key].group))].sort(
  (a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b),
);

/** A map as `Column: state` lines. */
export const mapToText = (value: Value): string =>
  value && typeof value === "object"
    ? Object.entries(value as Record<string, string>)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n")
    : "";
export function textOf(value: Value, def: HubSettingDef): string {
  if (value == null) return "";
  if (def.kind === "list") return Array.isArray(value) ? value.join("\n") : "";
  if (def.kind === "map") return mapToText(value);
  return String(value);
}
/** The draft as the server takes it; an empty box removes an optional setting. */
export function draftValue(text: string, def: HubSettingDef): Value {
  const trimmed = text.trim();
  if (def.kind === "bool") return text === "true";
  if (trimmed === "") return def.kind === "list" ? [] : null;
  if (def.kind === "number") return Number(trimmed);
  if (def.kind === "list")
    return text
      .split("\n")
      .map((v) => v.trim())
      .filter(Boolean);
  if (def.kind === "map")
    return Object.fromEntries(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const at = line.lastIndexOf(":");
          return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
        }),
    );
  return trimmed;
}

/** One setting: its field, unit, when it applies, and Save. */
export function SettingRow({
  settingKey,
  value,
  repoId,
  base,
}: {
  settingKey: HubSettingKey;
  value: Value;
  repoId?: string;
  base: string;
}) {
  const def = HUB_SETTINGS[settingKey];
  const id = `hub-setting-${repoId ?? "hub"}-${settingKey}`;
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = draft ?? textOf(value, def);
  const save = async () => {
    const next = draftValue(shown, def);
    if (def.kind === "number" && typeof next === "number" && !Number.isFinite(next)) {
      setError(`${def.label} must be a finite number.`);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await apiPost(ACTIONS.hubSettings, {
        base,
        key: settingKey,
        ...(repoId === undefined ? {} : { repoId }),
        value: next,
      });
      toast(`${def.label} saved. ${APPLIES_TEXT[def.applies]}.`);
      setDraft(null);
      hub.refetch(RESOURCES.hubSettings.path);
      hub.refetch(RESOURCES.config.path);
      hub.refetch(RESOURCES.crewChanges.path);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="row">
      <div className="ffield">
        <label htmlFor={id}>{def.label}</label>
        {def.kind === "list" || def.kind === "map" ? (
          <textarea
            id={id}
            value={shown}
            placeholder={def.kind === "map" ? "Column: state" : "One per line"}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
          />
        ) : def.kind === "choice" ? (
          <select
            id={id}
            value={shown}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
          >
            <option value="">Not set</option>
            {def.choices?.map((choice) => (
              <option key={choice} value={choice}>
                {CHOICE_LABELS[choice] ?? choice}
              </option>
            ))}
          </select>
        ) : def.kind === "bool" ? (
          <input
            id={id}
            type="checkbox"
            checked={shown === "true"}
            onChange={(e) => {
              setDraft(String(e.target.checked));
              setError(null);
            }}
          />
        ) : (
          <input
            id={id}
            type="text"
            inputMode={def.kind === "number" ? "decimal" : undefined}
            value={shown}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
          />
        )}
        {def.unit && <span className="fhint muted xs">{def.unit}</span>}
        {error && (
          <span id={`${id}-error`} role="alert" className="crit-t s">
            {error}
          </span>
        )}
      </div>
      <span className="muted s">{APPLIES_TEXT[def.applies]}</span>
      <button
        className="sm"
        type="button"
        disabled={saving}
        aria-label={`Save ${def.label}`}
        onClick={() => void save()}
      >
        {saving ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

/** Hub-wide configuration. Server validation remains the authority for each setting. */
export function HubSettings() {
  const settings = useResource<HubSettingsView>(RESOURCES.hubSettings);
  if (!settings.data)
    return (
      <p className="muted s">{settings.error ? settings.error.message : "Loading hub settings…"}</p>
    );
  const { base, values } = settings.data;
  return (
    <section aria-label="Hub settings" className="setup-hub">
      {GROUPS.map((group) => (
        <fieldset className={`fgroup${group === "Crew" ? " hub-crew" : ""}`} key={group}>
          <legend>{group}</legend>
          {HUB_KEYS.filter((key) => HUB_SETTINGS[key].group === group).map((key) => (
            <SettingRow key={key} settingKey={key} value={values[key]} base={base} />
          ))}
        </fieldset>
      ))}
    </section>
  );
}
