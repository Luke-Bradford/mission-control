import type { ConfigView } from "@mc/core";
import { navigate, setupPath } from "../router.ts";

export function FirstRun({ config }: { config: ConfigView }) {
  const crew = !!config.crew?.worktrees;
  const steps = [
    ["Time zone", true],
    ["Accounts", config.accounts.length > 0],
    ["Crew folder", crew],
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
          {!done && (label === "Accounts" || label === "First repo") && (
            <button
              type="button"
              className="sm"
              onClick={() => navigate(setupPath(label === "Accounts" ? "accounts" : "repos"))}
            >
              Open
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
