import type { ConfigView } from "@mc/core";
import { Fragment } from "react";

/** One coloured run of text on a YAML line: key, value, comment, or plain (indent, punctuation). */
interface Seg {
  cls: "yk" | "yv" | "yc" | null;
  text: string;
}
type Line = Seg[];

// Strings YAML would read as something else (bool, null, number) or that hold `:` / `#` are quoted.
const PLAIN = /^[A-Za-z_./~@][\w ./~@-]*$/;
const RESERVED = /^(true|false|yes|no|on|off|null|~)$/i;

/** A string as a YAML scalar: plain when that reads back as the same string, else JSON-quoted. */
export function scalar(s: string): string {
  return PLAIN.test(s) && !RESERVED.test(s) && !s.endsWith(" ") ? s : JSON.stringify(s);
}

const comment = (depth: number, text: string): Line => [
  { cls: null, text: "  ".repeat(depth) },
  { cls: "yc", text: `# ${text}` },
];

/** `key: value  # comment` at `depth`; `item` starts a list entry (`- key: value`). */
function kv(
  depth: number,
  key: string,
  value?: string | number,
  note?: string,
  item = false,
): Line {
  const line: Line = [
    { cls: null, text: "  ".repeat(depth) + (item ? "- " : "") },
    { cls: "yk", text: `${scalar(key)}:` },
  ];
  if (value !== undefined) {
    line.push({ cls: null, text: " " }, { cls: "yv", text: String(value) });
  }
  if (note) line.push({ cls: null, text: "  " }, { cls: "yc", text: `# ${note}` });
  return line;
}

/**
 * ConfigView in the config file's own snake_case shape, so it reads like config.yaml. Built from
 * what /api/config returns.
 */
export function yamlLines(c: ConfigView): Line[] {
  const L: Line[] = [
    comment(0, "~/.config/mission-control/config.yaml (or $MC_CONFIG) · read-only view"),
    comment(0, "what the server loaded at start: edit the file and restart · forms: Plan 2"),
    kv(0, "operator"),
    kv(1, "id", scalar(c.operator.id)),
    kv(1, "timezone", scalar(c.operator.timezone)),
  ];

  L.push(c.accounts.length ? kv(0, "accounts") : kv(0, "accounts", "[]"));
  for (const a of c.accounts) {
    L.push(
      kv(1, "id", scalar(a.id), undefined, true),
      kv(2, "vendor", a.vendor),
      kv(2, "alert_at", a.alertAt, "% of a window: notify you (Plan 4)"),
      kv(2, "stop_at", a.stopAt, "% of a window: no new runs (Plan 3); forecast shown now"),
    );
  }

  L.push(c.repos.length ? kv(0, "repos") : kv(0, "repos", "[]"));
  for (const r of c.repos) {
    L.push(
      kv(1, "id", scalar(r.id), undefined, true),
      kv(2, "github", scalar(r.github)),
      kv(2, "project", r.project, "GitHub Projects (v2) number"),
      kv(2, "status_map", undefined, "the project's Status option → ticket state"),
    );
    for (const [status, state] of Object.entries(r.statusMap)) {
      L.push(kv(3, status, scalar(state)));
    }
    // /api/config sends [] both when the key is absent (the server default applies) and when it is
    // set to []: it cannot be rendered faithfully, so say so rather than show a value.
    L.push(
      r.needsYouLabels === null
        ? comment(2, "needs_you_labels: unset (default [needs-design])")
        : kv(2, "needs_you_labels", `[${r.needsYouLabels.map(scalar).join(", ")}]`),
    );
  }

  L.push(c.loops.length ? kv(0, "loops") : kv(0, "loops", "[]"));
  for (const l of c.loops) {
    L.push(
      kv(1, "id", scalar(l.id), undefined, true),
      kv(2, "repo_id", scalar(l.repoId)),
      kv(2, "kind", l.kind),
      kv(2, "account_id", scalar(l.accountId)),
    );
    if (l.logsDir !== null) L.push(kv(2, "logs_dir", scalar(l.logsDir)));
    L.push(
      kv(2, "state_dir", scalar(l.stateDir)),
      kv(2, "worktree", scalar(l.worktree)),
      kv(2, "launchd_label", scalar(l.launchdLabel)),
    );
  }

  L.push(
    kv(0, "poll"),
    kv(1, "usage_minutes", c.poll.usageMinutes, "account usage samples"),
    kv(1, "github_seconds", c.poll.githubSeconds, "boards and escalations"),
  );
  return L;
}

/** A read-only, scrolling code block: line numbers, then syntax-coloured YAML. */
export function ConfigYaml({ config }: { config: ConfigView }) {
  const lines = yamlLines(config);
  return (
    <section className="yaml" aria-label="config.yaml, read-only">
      <div className="yln" aria-hidden="true">
        {lines.map((_, i) => i + 1).join("\n")}
      </div>
      <div className="ytx" data-testid="config-yaml">
        {lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and never reorder
          <Fragment key={i}>
            {i > 0 && "\n"}
            {line.map((s, j) =>
              s.cls ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
                <span key={j} className={s.cls}>
                  {s.text}
                </span>
              ) : (
                s.text
              ),
            )}
          </Fragment>
        ))}
      </div>
    </section>
  );
}
