import type { AttentionItem, FlightLedgerView, FlightSummaryView } from "@mc/core";
import { ownerLabel, useNeedsYou } from "../attention.ts";
import { useSecond, useTz } from "../clock.ts";
import { MarkdownInline } from "../components/Markdown.tsx";
import { RESOURCES, useResource } from "../data.ts";
import { dur, rel } from "../fmt.ts";
import { openItem } from "../shell/overlays.ts";
import { useSessionScope } from "../shell/session.ts";

const SHOWN = 3;

function checkpoint(due: number, now: number): string {
  return due <= now ? `overdue ${dur(now - due)}` : `in ${dur(due - now)}`;
}

/** The compact roll-up needed to run a stand-up without opening a detail tab. */
export function ControlQueue({ onOpenQueue }: { onOpenQueue: () => void }) {
  const summary = useResource<FlightSummaryView>(RESOURCES.flightSummary).data;
  const ledger = useResource<FlightLedgerView>(RESOURCES.flightLedgerOpen).data;
  const attention = useResource<AttentionItem[]>(RESOURCES.attention).data;
  const now = useSecond();
  const tz = useTz();
  const { inRepo } = useSessionScope();
  const needsYou = useNeedsYou().length;
  const seen = new Set<string>();
  const scopedAttention = (attention ?? [])
    .filter((item) => item.repoId === null || inRepo(item.repoId))
    .sort((a, b) => b.at - a.at)
    .filter((item) => {
      const duplicate = seen.has(item.key);
      seen.add(item.key);
      return !duplicate;
    });
  const handling = scopedAttention.filter((item) => item.flightTriage === "handling");
  const risks = scopedAttention.filter((item) => item.flightTriage !== "handling");
  const watches = (ledger?.entries ?? [])
    .filter(
      (entry) => entry.kind === "watch" && entry.status !== "done" && entry.status !== "dropped",
    )
    .sort((a, b) => a.createdAt - b.createdAt);
  const next = summary?.next ?? [];

  return (
    <div className="flight-control-stack">
      <section className="flight-control-group" aria-labelledby="flight-clear-now">
        <div className="flight-control-heading">
          <h3 id="flight-clear-now">Clear now</h3>
          {/* Needs you is the header's count; this list also holds what others are clearing. */}
          <span>
            <span className={needsYou > 0 ? "warn-t" : undefined}>
              {needsYou} {needsYou === 1 ? "needs" : "need"} you
            </span>
            {risks.length !== needsYou && ` · ${risks.length} in this list`}
          </span>
        </div>
        {risks.length === 0 ? (
          <p className="note">No known blocker or decision is waiting.</p>
        ) : (
          <ul className="flight-control-list">
            {risks.slice(0, SHOWN).map((item) => (
              <li key={item.key}>
                <div>
                  <span className="flight-control-meta">
                    <span
                      className={`flight-owner ${
                        item.kind === "stalled" || item.kind === "error"
                          ? "crit"
                          : (item.owner ?? "operator") === "operator"
                            ? "warn"
                            : ""
                      }`}
                    >
                      {ownerLabel(item.owner ?? "operator")}
                    </span>
                    {item.at > 0 && tz !== null && <span>{rel(item.at, now, tz)}</span>}
                  </span>
                  <span className="flight-control-text">
                    <MarkdownInline text={item.text} max={90} />
                  </span>
                </div>
                <button
                  type="button"
                  className="sm ghost flight-link"
                  onClick={() => openItem(item.key)}
                >
                  Open
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {handling.length > 0 && (
        <section className="flight-control-group" aria-labelledby="flight-handling-now">
          <div className="flight-control-heading">
            <h3 id="flight-handling-now">FLIGHT is handling</h3>
            <span>{handling.length} owned</span>
          </div>
          <ul className="flight-control-list">
            {handling.slice(0, SHOWN).map((item) => (
              <li key={item.key}>
                <div>
                  <b>{item.text}</b>
                  {(item.brief?.assessment ?? item.brief?.context) && (
                    <span className="s fg2">{item.brief?.assessment ?? item.brief?.context}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flight-control-group" aria-labelledby="flight-next-up">
        <div className="flight-control-heading">
          <h3 id="flight-next-up">Next up</h3>
          <button type="button" className="sm ghost flight-link" onClick={onOpenQueue}>
            Open plan
          </button>
        </div>
        {next.length === 0 ? (
          <p className="note">No ordered commitment is recorded.</p>
        ) : (
          <ol className="flight-control-list numbered">
            {next.slice(0, SHOWN).map((item) => (
              <li key={`${item.kind}:${item.key}`}>
                <div>
                  <b>{item.title}</b>
                  <span className="s fg2">
                    {item.next ?? "Next action not recorded"}
                    {item.due === null
                      ? " · no checkpoint"
                      : tz === null
                        ? ""
                        : ` · ${checkpoint(item.due, now)}`}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="flight-control-group" aria-labelledby="flight-watch-ahead">
        <div className="flight-control-heading">
          <h3 id="flight-watch-ahead">Watch / investigate</h3>
          <span>{watches.length} tracked</span>
        </div>
        {watches.length === 0 ? (
          <p className="note">No spike or revisit is being tracked.</p>
        ) : (
          <ul className="flight-control-list">
            {watches.slice(0, SHOWN).map((item) => (
              <li key={item.key}>
                <div>
                  <b>{item.title}</b>
                  <span className="s fg2">{item.next ?? "Follow-up action not recorded"}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
