import { prPill, type RunPr } from "@mc/core";
import { Pill } from "./Pill.tsx";
import { RepoRef } from "./RepoRef.tsx";

/**
 * A PR a run published: its repo chip and `PR #3240` linked to GitHub (plain text when no
 * https://github.com URL can be made), its title on hover, and a pill once it is merged or
 * closed. `bare` leaves the repo chip out, for a page that shows one repo.
 */
export function PrChip({ pr, bare }: { pr: RunPr; bare?: boolean }) {
  const pill = pr.state === "merged" || pr.state === "closed" ? prPill({ state: pr.state }) : null;
  return (
    <span className="rpr">
      <RepoRef
        repoId={pr.repoId}
        number={pr.number}
        kind="pr"
        bare={bare}
        title={pr.title ?? undefined}
        url={pr.url}
      />
      {pill && <Pill tone={pill.tone}>{pill.label}</Pill>}
    </span>
  );
}
