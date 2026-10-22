import {
  type ConfigView,
  FLOW_COLLECTOR_PREFIX,
  GITHUB_COLLECTOR_PREFIX,
  githubCollector,
  type HealthRow,
} from "@mc/core";
import { useEffect } from "react";
import { useNow, useTz } from "../clock.ts";
import { ConfigYaml } from "../components/config/ConfigYaml.tsx";
import { GLOSSARY_ID, Glossary } from "../components/config/Glossary.tsx";
import { RESOURCES, useResource } from "../data.ts";
import { rel } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";

const DASH = "—";

/** Setup › Sources (catalogue 2.7.5): GitHub's health, the config and glossary, and what is read. */
export function Sources({
  config,
  error,
}: {
  config: ConfigView | undefined;
  error: Error | null;
}) {
  const health = useResource<HealthRow[]>(RESOURCES.health).data;
  const tz = useTz();
  const now = useNow();
  const loaded = config !== undefined || error !== null;
  // `/setup/sources#glossary` (where the old /config and /settings#glossary links land) scrolls to
  // the glossary; again once the config has arrived, since the YAML above it moves it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `loaded` is the re-run trigger
  useEffect(() => {
    if (window.location.hash === `#${GLOSSARY_ID}`) {
      document.getElementById(GLOSSARY_ID)?.scrollIntoView?.();
    }
  }, [loaded]);

  // A row that is ok but carries a note is ok; only `ok: false` fails.
  const github = (health ?? []).filter(
    (h) =>
      h.collector.startsWith(GITHUB_COLLECTOR_PREFIX) ||
      h.collector.startsWith(FLOW_COLLECTOR_PREFIX),
  );
  const failing = github.filter((h) => !h.ok);
  const pill = !health ? (
    <Pill tone="neutral">{DASH}</Pill>
  ) : failing.length > 0 ? (
    <Pill tone="crit">Failing</Pill>
  ) : github.length === 0 ? (
    <Pill tone="neutral">Not polled yet</Pill>
  ) : (
    <Pill tone="ok">Connected</Pill>
  );
  const lastPoll = (repoId: string): string => {
    const at = health?.find((h) => h.collector === githubCollector(repoId))?.lastOkAt ?? null;
    if (at === null) return "never";
    return tz ? rel(at, now, tz) : DASH;
  };

  return (
    <>
      <Panel title="GitHub" sub="the record of work · read through your gh login" actions={pill}>
        <div className="pb">
          {failing.map((h) => (
            <p key={h.collector} className="crit-t s">
              {h.collector}: {h.error ?? "failing"}
            </p>
          ))}
          {config?.repos.map((r) => (
            <p key={r.id} className="s">
              {r.github} · project {r.project}{" "}
              <span className="muted xs">last poll {lastPoll(r.id)}</span>
            </p>
          ))}
          <p className="note">
            Writes (comments, labels, board moves, Priority) go through approvals; nothing posts on
            its own.
          </p>
        </div>
      </Panel>
      <Panel title="Microsoft Teams" sub="read-only" actions={<Pill tone="plain">P5</Pill>}>
        <div className="pb">
          <p className="s">Work only; arrives in phase 5.</p>
        </div>
      </Panel>
      <Panel title="Agents" sub="what each provider reports">
        <div className="pb">
          <p className="s">
            Claude (CLI transcripts): messages, tool calls, usage per call, run totals with cost,
            rate-limit events, subagent progress.
          </p>
          <p className="s">
            This Mac: CPU, memory, disk and per-process memory, read by mc-server.
          </p>
        </div>
      </Panel>
      <Panel title="config.yaml" sub="read-only: edit the file and restart the server">
        <div className="pb">
          {error && <p className="crit-t s">Could not load the config: {error.message}</p>}
          {config && <ConfigYaml config={config} />}
        </div>
      </Panel>
      <Glossary />
    </>
  );
}
