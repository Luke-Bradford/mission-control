import type { ConfigView, Crew, MapSnapshot, RepoView } from "@mc/core";
import { useMemo, useState } from "react";
import { callSign } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { HistoryLens, ReviewLens } from "../lenses/lenses.tsx";
import { mapRepoOptions } from "../map/repos.ts";
import { MAP_REPO_KEY, readKey } from "../storage.ts";
import "./qa-hotspots.css";

/** Where to spend QA effort: the files that keep changing and being fixed, and that keep getting findings. */
export function QaHotspots() {
  const repos = useResource<RepoView[]>(RESOURCES.repos);
  const config = useResource<ConfigView>(RESOURCES.config);
  const crew = useResource<Crew>(RESOURCES.crew);
  const mapped = useMemo(
    () =>
      repos.data ? mapRepoOptions(repos.data, config.data, crew.data).filter((o) => o.mapped) : [],
    [repos.data, config.data, crew.data],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const remembered = readKey(MAP_REPO_KEY);
  const repo =
    mapped.find((o) => o.id === picked)?.id ??
    mapped.find((o) => o.id === remembered)?.id ??
    mapped[0]?.id ??
    null;
  const failed = repos.error ?? config.error;
  if (repos.data === undefined || config.data === undefined)
    return failed ? (
      <p className="s crit-t">Could not load repos: {failed.message}</p>
    ) : (
      <p className="s">Loading repos…</p>
    );
  if (!repo)
    return (
      <p className="s fg2">
        No repo has a crew session yet, so there is no history or review heat to show.
      </p>
    );
  return (
    <div className="qa-hotspots">
      <div className="toolbar">
        <label className="note">
          Repo{" "}
          <select value={repo} onChange={(e) => setPicked(e.target.value)}>
            {mapped.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <RepoHotspots
        key={repo}
        repo={repo}
        github={repos.data.find((entry) => entry.id === repo)?.github}
        names={Object.fromEntries((crew.data?.rows ?? []).map((row) => [row.id, callSign(row)]))}
      />
    </div>
  );
}

function RepoHotspots({
  repo,
  github,
  names,
}: {
  repo: string;
  github: string | undefined;
  names: Record<string, string>;
}) {
  const map = useResource<MapSnapshot>(RESOURCES.repoMap(repo));
  const [focus, setFocus] = useState<string | null>(null);
  if (!map.data)
    return map.error ? (
      <p className="s crit-t">
        Could not read the map for {repo}: {map.error.message}
      </p>
    ) : (
      <p className="s">Loading the repo map…</p>
    );
  return (
    <div className="qa-hotspots-panels">
      <HistoryLens snapshot={map.data} focus={focus} onFocus={setFocus} github={github} />
      <ReviewLens snapshot={map.data} names={names} onFocus={setFocus} />
    </div>
  );
}
