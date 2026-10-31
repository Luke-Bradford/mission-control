import { PROMPT_SECTIONS, type PromptSection, type PromptWakeCost } from "@mc/core";
import "./PromptCost.css";

export const NO_SECTION_DATA = "No section data for this run";

export const PROMPT_SECTION_LABEL: Record<PromptSection, string> = {
  role: "Role prompt",
  rules: "Repo rules",
  orders: "Standing orders",
  lessons: "Lessons",
  ticket: "Ticket",
  digest: "Wake digest",
  tool_results: "Tool results",
};

/** One token count with thousands separators. */
const count = (n: number): string => n.toLocaleString("en-GB");

export const promptTotal = (cost: PromptWakeCost): number =>
  cost.sections.reduce((sum, s) => sum + s.tokens, 0);

/**
 * One prompt's estimated tokens by section: a stacked bar, then each section's label and count
 * and the total. The legend lists every section, so a zero still reads as a zero. `empty` is the
 * line shown for a prompt with no tokens recorded.
 */
export function PromptCostBar({
  cost,
  empty = NO_SECTION_DATA,
}: {
  cost: PromptWakeCost;
  empty?: string;
}) {
  const total = promptTotal(cost);
  if (total === 0) return <p className="pb note">{empty}</p>;
  const tokens = (section: PromptSection): number =>
    cost.sections.find((s) => s.section === section)?.tokens ?? 0;
  return (
    <div className="prompt-cost">
      <div
        className="prompt-cost-bar"
        role="img"
        aria-label={`Prompt tokens by section, ${count(total)} in all`}
      >
        {PROMPT_SECTIONS.map((section) => (
          <i
            key={section}
            data-section={section}
            title={`${PROMPT_SECTION_LABEL[section]} · ${count(tokens(section))} tokens`}
            style={{ width: `${(tokens(section) / total) * 100}%` }}
          />
        ))}
      </div>
      <ul className="prompt-cost-legend" aria-label="Tokens by section">
        {PROMPT_SECTIONS.map((section) => (
          <li key={section} data-section={section}>
            <span className="prompt-cost-swatch" aria-hidden="true" />
            <span className="prompt-cost-name">{PROMPT_SECTION_LABEL[section]}</span>
            <b className="num">{count(tokens(section))}</b>
          </li>
        ))}
      </ul>
      <p className="prompt-cost-total s">
        <b className="num">{count(total)} tokens</b>
        <span className="muted"> · estimated from the prompt's size (about 4 bytes a token)</span>
      </p>
    </div>
  );
}
