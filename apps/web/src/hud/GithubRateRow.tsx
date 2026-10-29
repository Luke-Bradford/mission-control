import {
  formatGithubRate,
  type GithubRateState,
  githubSlowedNotes,
  type HealthRow,
} from "@mc/core";
import { useNow, useTz } from "../clock.ts";
import { RESOURCES, useResource } from "../data.ts";
import "./GithubRateRow.css";

/** The GitHub API budget line, with the poll's `slowed: …` note beside it (Overview and Setup › Accounts). */
export function GithubRateRow() {
  const rate = useResource<GithubRateState>(RESOURCES.githubRate).data ?? null;
  const health = useResource<HealthRow[]>(RESOURCES.health).data ?? [];
  const tz = useTz();
  const now = useNow();
  return (
    <p className="s githubrate">
      {/* No zone yet: no reset time can be shown, so the row reads as no reading. */}
      <span>{formatGithubRate(tz ? rate : null, tz ?? "", now)}</span>
      {githubSlowedNotes(health).map((note) => (
        <span key={note} role="status" className="muted block">
          {note}
        </span>
      ))}
    </p>
  );
}
