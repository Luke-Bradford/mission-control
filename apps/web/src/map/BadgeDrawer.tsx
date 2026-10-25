import type { MapSeat, MapSnapshot } from "@mc/core";
import { useEffect, useRef, useState } from "react";
import { useNow } from "../clock.ts";
import {
  age,
  type BadgeKind,
  badgeModels,
  currentFindings,
  questionLanes,
  recentFailures,
} from "./cards.ts";
import { pinToken } from "./model.ts";

const titles: Record<BadgeKind, string> = {
  questions: "Conversation lane",
  failures: "Refused and failed calls",
  review: "Review findings",
  tests: "Local tests",
  ci: "CI at head SHA",
  waiting: "Waiting",
};

export function BadgeDrawer({
  snapshot,
  seat,
  kind,
  onClose,
}: {
  snapshot: MapSnapshot;
  seat: MapSeat;
  kind: BadgeKind;
  onClose: () => void;
}) {
  const now = useNow();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const badge = badgeModels(seat, now).find((b) => b.kind === kind);
  return (
    <div
      role="dialog"
      aria-label={titles[kind]}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <button type="button" onClick={onClose}>
        Close
      </button>
      <h3 ref={heading} tabIndex={-1}>
        {titles[kind]}
      </h3>
      <p>
        {seat.seat}
        {seat.ticket !== null && ` · #${seat.ticket}`}
      </p>
      {badge ? (
        <>
          <p>
            {badge.text} · {badge.age}
          </p>
          {kind === "questions" && <QuestionLane key={seat.seat} seat={seat} now={now} />}
          {kind === "failures" && (
            <>
              <p className="map-note">
                Last 10 minutes, newest first. Refused: CLI permissions or the hub guard said no.
                Failed: the call ran and errored. Calls cut off by a stopped run are excluded.
              </p>
              {recentFailures(seat, now).map((failure, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the contract has no call id; simultaneous identical failures must remain distinct.
                <div className="map-finding" key={`${failure.at}-${index}`}>
                  <strong>
                    {failure.refused ? "Refused" : "Failed"} · {failure.tool}
                  </strong>
                  <p>{age(failure.at, now)}</p>
                  <p className="map-reason">{failure.why}</p>
                </div>
              ))}
            </>
          )}
          {kind === "review" && (
            <>
              <p className="map-note">Latest review only. Findings have no inferred fixed state.</p>
              {currentFindings(snapshot, seat).map((finding) => (
                <Finding
                  key={`${finding.file}-${finding.line}-${finding.summary}`}
                  finding={finding}
                />
              ))}
              {!currentFindings(snapshot, seat).length && <p>No findings.</p>}
            </>
          )}
          {kind === "tests" && seat.badges.tests && (
            <>
              <p>
                {seat.badges.tests.runner === "vitest" ? "Parsed Vitest summary" : "Tests: unknown"}
              </p>
              <p className="map-note">
                Test results come from runner output. A tool error is not a test failure.
              </p>
            </>
          )}
          {kind === "ci" && seat.badges.ci && (
            <>
              <p className="map-reason">Head SHA: {seat.badges.ci.sha}</p>
              {seat.badges.ci.checks.map((check) => (
                <div className="map-finding" key={`${check.kind}-${check.workflow}-${check.name}`}>
                  <strong>
                    {check.name} · {check.state}
                  </strong>
                  {check.workflow && <p>{check.workflow}</p>}
                  <p>
                    {check.conclusion}
                    {check.attempt !== null && ` · attempt ${check.attempt}`}
                  </p>
                </div>
              ))}
              {!seat.badges.ci.checks.length && <p>No checks reported at this head.</p>}
            </>
          )}
          {kind === "waiting" && seat.badges.waiting && (
            <p className="map-reason">{seat.badges.waiting.reason}</p>
          )}
        </>
      ) : (
        <p>
          No current{" "}
          {kind === "failures"
            ? "refused or failed calls in the last 10 minutes"
            : titles[kind].toLowerCase()}
          .
        </p>
      )}
    </div>
  );
}

function QuestionLane({ seat, now }: { seat: MapSeat; now: number }) {
  const lanes = questionLanes(seat);
  const [picked, setPicked] = useState(lanes[0]?.key ?? "");
  const [ticket, setTicket] = useState("all");
  const lane = lanes.find((l) => l.key === picked) ?? lanes[0];
  const questions = lane?.questions ?? [];
  const tickets = [...new Set(questions.map((q) => q.ticket))];
  const selectedTicket = tickets.some((t) => String(t) === ticket) ? ticket : "all";
  return (
    <>
      <label>
        Lane{" "}
        <select
          aria-label="Conversation lane"
          value={lane?.key ?? ""}
          onChange={(e) => {
            setPicked(e.target.value);
            setTicket("all");
          }}
        >
          {lanes.map((l) => (
            <option key={l.key} value={l.key}>
              {l.ends.join(" ↔ ")}
            </option>
          ))}
        </select>
      </label>
      <label>
        Ticket{" "}
        <select
          aria-label="Lane ticket"
          value={selectedTicket}
          onChange={(e) => setTicket(e.target.value)}
        >
          <option value="all">All tickets</option>
          {tickets.map((t) => (
            <option key={String(t)} value={String(t)}>
              {t === null ? "No ticket" : `#${t}`}
            </option>
          ))}
        </select>
      </label>
      {questions
        .filter((q) => selectedTicket === "all" || String(q.ticket) === selectedTicket)
        .map((q) => (
          <div className="map-finding" key={q.id}>
            <strong>
              {q.from} → {q.to}
            </strong>
            <p>
              Question {q.id}
              {q.ticket !== null && ` · #${q.ticket}`} · awaiting reply · {age(q.since, now)}
            </p>
          </div>
        ))}
    </>
  );
}

export function Finding({ finding }: { finding: MapSnapshot["findings"][number] }) {
  return (
    <div className="map-finding">
      <strong style={{ color: `var(${pinToken(finding.severity)})` }}>
        ▲ {finding.severity} · {finding.seat} · round {finding.round}
      </strong>
      <p>
        {finding.file}:{finding.line} · {finding.summary}
      </p>
      <p>{finding.scenario}</p>
      <p>Fix: {finding.fix}</p>
    </div>
  );
}
