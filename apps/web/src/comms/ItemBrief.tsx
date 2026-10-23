import type { AttentionBrief, BriefOption } from "@mc/core";
import { Markdown } from "../components/Markdown.tsx";

/** FLIGHT's brief on an item: what it is and what FLIGHT recommends (all inert text). */
export function ItemBrief({ brief }: { brief: AttentionBrief }) {
  return (
    <div className="brief">
      <div className="bsec">FLIGHT's brief</div>
      <div className="s qtext">
        <Markdown text={brief.context} />
      </div>
      <div className="bsec">FLIGHT recommends</div>
      <div className="s qtext">
        <Markdown text={brief.recommendation} />
      </div>
    </div>
  );
}

/**
 * One button per option. In the panel each is a card with its answer under the label (a plain card
 * when `live` is false); in a row it is a small button with the answer as its title.
 */
export function BriefOptions(p: {
  options: BriefOption[];
  live: boolean;
  disabled: boolean;
  title?: string;
  variant: "panel" | "row";
  onPick: (o: BriefOption) => void;
}) {
  if (p.options.length === 0) return null;
  if (p.variant === "row") {
    return (
      <div className="nopts">
        {p.options.map((o, i) => (
          <button
            type="button"
            className="sm"
            // Labels can repeat, so the text is no key; the list never reorders.
            // biome-ignore lint/suspicious/noArrayIndexKey: position is the only id, see above
            key={i}
            title={p.title ?? o.answer}
            disabled={p.disabled}
            onClick={() => p.onPick(o)}
          >
            {o.label}
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="optlist">
      {p.options.map((o, i) => (
        // Labels can repeat, so the text is no key; the list never reorders.
        // biome-ignore lint/suspicious/noArrayIndexKey: position is the only id, see above
        <OptionCard key={i} option={o} {...p} />
      ))}
    </div>
  );
}

function OptionCard(p: {
  option: BriefOption;
  live: boolean;
  disabled: boolean;
  title?: string;
  onPick: (o: BriefOption) => void;
}) {
  const content = (
    <>
      <b className="qtext">{p.option.label}</b>
      <span className="xs fg2">{p.option.answer}</span>
    </>
  );
  if (!p.live) return <div className="opt">{content}</div>;
  return (
    <button
      type="button"
      className="opt"
      aria-label={p.option.label}
      title={p.title}
      disabled={p.disabled}
      onClick={() => p.onPick(p.option)}
    >
      {content}
    </button>
  );
}
