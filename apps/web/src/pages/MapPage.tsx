import type { ConfigView, Crew, RepoView } from "@mc/core";
import { useEffect, useMemo } from "react";
import { RESOURCES, useResource } from "../data.ts";
import { LiveCrewMap } from "../map/CrewMap.tsx";
import { defaultMapRepo, mapRepoOptions } from "../map/repos.ts";
import { followLink, mapPath, navigate, setupPath } from "../router.ts";
import { useSessionScope } from "../shell/session.ts";
import { MAP_REPO_KEY, readKey, writeKey } from "../storage.ts";

/**
 * The Crew Activity Map, one repo at a time (`/map/:repo`): the repo's files in 3D with the crew
 * working in them, live. `/map` alone goes to the session's repo, the busiest, the last one picked
 * or the first with a crew session.
 */
export function MapPage({ repoId }: { repoId: string | null }) {
  const repos = useResource<RepoView[]>(RESOURCES.repos);
  const config = useResource<ConfigView>(RESOURCES.config);
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const scope = useSessionScope();
  const options = useMemo(
    () => (repos.data ? mapRepoOptions(repos.data, config.data, crew) : []),
    [repos.data, config.data, crew],
  );
  const loaded = repos.data !== undefined && config.data !== undefined;
  const target =
    repoId === null && loaded
      ? defaultMapRepo(options, crew, scope.repo ?? "", readKey(MAP_REPO_KEY) ?? "")
      : null;
  useEffect(() => {
    if (target) navigate(mapPath(target), { replace: true });
  }, [target]);
  const option = options.find((o) => o.id === repoId);
  useEffect(() => {
    if (option?.mapped) writeKey(MAP_REPO_KEY, option.id);
  }, [option]);
  const failed = repos.error ?? config.error;
  return (
    <section id="page-map" className="map-page">
      <header className="map-head">
        <h1>Crew activity map</h1>
        <label className="map-field">
          Repo
          <select
            aria-label="Map repo"
            value={option ? option.id : ""}
            disabled={!options.length}
            onChange={(e) => navigate(mapPath(e.target.value))}
          >
            {!option && <option value="">{loaded ? "Pick a repo" : "Loading repos…"}</option>}
            {options.map((o) => (
              <option key={o.id} value={o.id} disabled={!o.mapped}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <span className="map-scope">
          Crew seats only · one repo at a time · history stays in each agent's own view
        </span>
      </header>
      {failed && !loaded ? (
        <div className="map-wait">
          <p role="alert">Repos unavailable: {failed.message}</p>
        </div>
      ) : !loaded || target ? (
        <div className="map-wait">
          <p role="status">Loading repos…</p>
        </div>
      ) : repoId === null ? (
        <div className="map-wait">
          <p role="status">
            No repo has a crew session yet, so there is nothing to map. Add one in{" "}
            <a href={setupPath("sessions")} onClick={(e) => followLink(e, setupPath("sessions"))}>
              Setup · Sessions
            </a>
            .
          </p>
        </div>
      ) : !option ? (
        <div className="map-wait">
          <p role="status">{repoId} is not a configured repo.</p>
        </div>
      ) : !option.mapped ? (
        <div className="map-wait">
          <p role="status">
            {option.label}. The map shows crew seats' work from a crew session's checkout; pick a
            repo with crew seats.
          </p>
        </div>
      ) : (
        <LiveCrewMap key={option.id} repo={option.id} />
      )}
    </section>
  );
}
