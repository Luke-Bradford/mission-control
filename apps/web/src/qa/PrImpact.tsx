import type { Crew, MapSnapshot, PullRequestView } from "@mc/core";
import { useMemo, useState } from "react";
import { callSign } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { ImpactLens, prSeats } from "../lenses/lenses.tsx";

/**
 * What a PR's changes reach through imports. The repo map is read only once the operator asks, and
 * is shared by the cards of the same repo. The seat that holds the PR's branch stands for its diff.
 */
export function PrImpact({ pr }: { pr: PullRequestView }) {
  const [asked, setAsked] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const map = useResource<MapSnapshot>(asked ? RESOURCES.repoMap(pr.repoId) : null);
  const crew = useResource<Crew>(asked ? RESOURCES.crew : null).data;
  const names = useMemo(
    () => Object.fromEntries((crew?.rows ?? []).map((row) => [row.id, callSign(row)])),
    [crew],
  );
  if (!asked)
    return (
      <button type="button" onClick={() => setAsked(true)}>
        Show impact
      </button>
    );
  const snapshot = map.data;
  if (!snapshot) {
    return map.error ? (
      <span className="warn-t">
        Impact unavailable: the map for {pr.repoId} could not be read ({map.error.message}).
      </span>
    ) : (
      <span className="fg2" role="status">
        Loading the repo map…
      </span>
    );
  }
  const seats = prSeats(snapshot, pr.branch);
  if (seats.length === 0)
    return (
      <span className="fg2">
        No crew seat holds {pr.branch}, so its changed files are not on the map.
      </span>
    );
  return (
    <div className="qa-impact">
      {seats
        .filter((seat) => seat.changedOn.length > 1)
        .map((seat) => (
          <p className="fg2" key={seat.seat}>
            {names[seat.seat] ?? seat.seat} has other unmerged branches; their changes are counted
            here too.
          </p>
        ))}
      <ImpactLens
        snapshot={snapshot}
        focus={focus}
        onFocus={setFocus}
        seats={seats.map((seat) => seat.seat)}
      />
    </div>
  );
}
