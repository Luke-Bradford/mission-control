import type { ConfigView, HubSettingsView } from "@mc/core";
import { RESOURCES, useResource } from "../data.ts";
import { addRepoPath, navigate, setupPath } from "../router.ts";
import { SettingRow } from "./HubSettings.tsx";

/** What a new hub still needs, in the order it can be done: the crew folder comes before the first repo. */
export function FirstRun({ config }: { config: ConfigView }) {
  const settings = useResource<HubSettingsView>(RESOURCES.hubSettings).data;
  const zone = settings?.values["operator.timezone"];
  const crew = settings?.values["crew.worktrees"];
  const steps = [
    ["Time zone", typeof zone === "string" && zone !== ""],
    ["Accounts", config.accounts.length > 0],
    ["Crew folder", !!config.crew?.worktrees],
    ["First repo", config.repos.length > 0],
  ] as const;
  if (steps.every(([, done]) => done)) return null;
  return (
    <section className="setup-first-run" aria-label="First run">
      <h3>Finish setup</h3>
      {steps.map(([label, done]) => (
        <div key={label}>
          <span role="img" aria-label={done ? `${label} done` : `${label} to do`}>
            {done ? "✓" : "○"}
          </span>{" "}
          {label}{" "}
          {!done && settings && label === "Time zone" && (
            <SettingRow settingKey="operator.timezone" value={zone} base={settings.base} />
          )}
          {!done && settings && label === "Crew folder" && (
            <SettingRow settingKey="crew.worktrees" value={crew} base={settings.base} />
          )}
          {!done && (label === "Accounts" || label === "First repo") && (
            <button
              type="button"
              className="sm"
              onClick={() => navigate(label === "Accounts" ? setupPath("accounts") : addRepoPath())}
            >
              Open
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
