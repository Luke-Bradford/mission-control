import { DONE_RANGES } from "@mc/core";
import { copyText } from "../clipboard.ts";
import { ExternalLink } from "../components/ExternalLink.tsx";
import { Seg } from "../hud/Seg.tsx";
import { BuildChips } from "../shell/buildStatus.tsx";
import type { Lane } from "./lanes.ts";

export type BoardLayout = "together" | "apart";

export type DoneRange = (typeof DONE_RANGES)[number];

export const copyQuery = (q: string): Promise<void> =>
  copyText(q, "Query copied.", "Copy was blocked here; select the query and copy it.");

export function Toolbar({
  lanes,
  lane,
  onLane,
  priorities,
  priority,
  onPriority,
  agentOnly,
  onAgentOnly,
  mineOnly,
  onMineOnly,
  doneDays,
  onDoneDays,
  onBrief,
  layout,
  onLayout,
}: {
  lanes: Lane[];
  lane: Lane;
  onLane: (id: string) => void;
  priorities: string[];
  priority: string;
  onPriority: (p: string) => void;
  agentOnly: boolean;
  onAgentOnly: (on: boolean) => void;
  mineOnly: boolean;
  onMineOnly: (on: boolean) => void;
  doneDays: DoneRange;
  onDoneDays: (d: DoneRange) => void;
  onBrief: () => void;
  /** Together / Apart; null where it does not apply (not All repos, or fewer than two repos). */
  layout: BoardLayout | null;
  onLayout: (l: BoardLayout) => void;
}) {
  return (
    <div className="toolbar" id="boardToolbar">
      <BuildChips panel="boardToolbar" />
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a legend and a border */}
      <div className="lanes" role="group" aria-label="Saved views">
        {lanes.map((l) => (
          <button
            key={l.id}
            type="button"
            className={`sm${l.id === lane.id ? " on" : ""}`}
            aria-pressed={l.id === lane.id}
            onClick={() => onLane(l.id)}
          >
            {l.name}
          </button>
        ))}
      </div>
      <span className="query">
        <code>{lane.query}</code>
        <button
          type="button"
          className="sm ghost"
          title="Copy the GitHub query"
          onClick={() => void copyQuery(lane.query)}
        >
          Copy
        </button>
      </span>
      {lane.url && <ExternalLink url={lane.url}>Open in GitHub ↗</ExternalLink>}
      <span className="spacer" />
      <label className="s fg2" htmlFor="fPrio">
        Priority
      </label>
      <select id="fPrio" value={priority} onChange={(e) => onPriority(e.target.value)}>
        <option value="">Any</option>
        {priorities.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={`sm${agentOnly ? " on" : ""}`}
        aria-pressed={agentOnly}
        onClick={() => onAgentOnly(!agentOnly)}
      >
        Has an agent
      </button>
      <button
        type="button"
        className={`sm${mineOnly ? " on" : ""}`}
        aria-pressed={mineOnly}
        onClick={() => onMineOnly(!mineOnly)}
      >
        Needs me
      </button>
      {layout !== null && (
        <Seg
          label="Repos"
          options={[
            { value: "together", label: "Together" },
            { value: "apart", label: "Apart" },
          ]}
          value={layout}
          onChange={onLayout}
        />
      )}
      <Seg
        label="How far back Done goes"
        options={DONE_RANGES.map((d) => ({ value: String(d), label: `Done ${d}d` }))}
        value={String(doneDays)}
        onChange={(v) => onDoneDays(Number(v) as DoneRange)}
      />
      <button type="button" className="sm primary" onClick={onBrief}>
        Standup brief
      </button>
    </div>
  );
}
