import type { FlightSummaryView } from "@mc/core";
import { MarkdownInline } from "../../components/Markdown.tsx";
import { elapsed } from "../../fmt.ts";
import type { FlightRun } from "../Situation.tsx";
import { SUMMARY_EMPTY } from "../Summary.tsx";
import { ScrollList } from "./ScrollList.tsx";

/** The most lines Doing now shows. */
export const DOING_MAX = 5;

export interface DoingLine {
  key: string;
  lead: string;
  rest: string;
  /** How long the line has stood, in words ("12m"); "age not known" when the hub does not say. */
  age: string;
}

export const AGE_UNKNOWN = "age not known";

const ageText = (min: number | null | undefined): string =>
  min == null ? AGE_UNKNOWN : elapsed(min * 60_000);

/**
 * Three to five lines: FLIGHT's headline, then its open ledger entries, each with its age. An entry
 * the ledger has closed (done or dropped) is not in the list, so its line is gone. A stopped FLIGHT is doing
 * nothing, and its last headline is marked as the last known.
 */
export function doingLines(run: FlightRun, summary: FlightSummaryView | undefined): DoingLine[] {
  const headline = summary?.headline.trim() || null;
  const active = (summary?.now ?? []).filter((i) => i.status === "active");
  const lines: DoingLine[] = [];
  if (run.kind === "down") {
    lines.push({ key: "stopped", lead: "Nothing.", rest: "FLIGHT is stopped.", age: "" });
    if (headline)
      lines.push({
        key: "headline",
        lead: "Last headline:",
        rest: headline,
        age: ageText(summary?.headlineAgeMin),
      });
  } else {
    lines.push({
      key: "headline",
      lead: headline ? "Headline" : "No headline",
      rest: headline ?? SUMMARY_EMPTY,
      age: headline ? ageText(summary?.headlineAgeMin) : AGE_UNKNOWN,
    });
  }
  for (const i of active) {
    lines.push({
      key: `${i.kind}:${i.key}`,
      lead: i.title,
      rest: i.next ?? "",
      age: ageText(i.ageMin),
    });
  }
  return lines.slice(0, DOING_MAX);
}

export function DoingNowList({ lines }: { lines: DoingLine[] }) {
  return (
    <ScrollList row="li">
      <ul className="fp-lines fp-doing" id="doing">
        {lines.map((l) => (
          <li key={l.key}>
            <span className="fp-w">
              <b>{l.lead}</b> <MarkdownInline text={l.rest} max={140} />
            </span>
            <span className="fp-age">{l.age}</span>
          </li>
        ))}
      </ul>
    </ScrollList>
  );
}
