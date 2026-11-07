import type { FlightSummaryView } from "@mc/core";
import { MarkdownInline } from "../../components/Markdown.tsx";
import type { FlightRun } from "../Situation.tsx";
import { SUMMARY_EMPTY } from "../Summary.tsx";

/** The most lines Doing now shows. */
export const DOING_MAX = 5;

export interface DoingLine {
  key: string;
  lead: string;
  rest: string;
}

/**
 * Three to five lines: FLIGHT's headline, then its active ledger entries. A stopped FLIGHT is doing
 * nothing, and its last headline is marked as the last known.
 */
export function doingLines(run: FlightRun, summary: FlightSummaryView | undefined): DoingLine[] {
  const headline = summary?.headline.trim() || null;
  const active = (summary?.now ?? []).filter((i) => i.status === "active");
  const lines: DoingLine[] = [];
  if (run.kind === "down") {
    lines.push({ key: "stopped", lead: "Nothing.", rest: "FLIGHT is stopped." });
    if (headline) lines.push({ key: "headline", lead: "Last headline:", rest: headline });
  } else {
    lines.push({
      key: "headline",
      lead: headline ? "Headline" : "No headline",
      rest: headline ?? SUMMARY_EMPTY,
    });
  }
  for (const i of active) {
    lines.push({ key: `${i.kind}:${i.key}`, lead: i.title, rest: i.next ?? "" });
  }
  return lines.slice(0, DOING_MAX);
}

export function DoingNowList({ lines }: { lines: DoingLine[] }) {
  return (
    <ul className="fp-lines" id="doing">
      {lines.map((l) => (
        <li key={l.key}>
          <span className="fp-w">
            <b>{l.lead}</b> <MarkdownInline text={l.rest} max={140} />
          </span>
        </li>
      ))}
    </ul>
  );
}
