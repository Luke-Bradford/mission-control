import type { CommsThreadMessage, FlightView, MapSeat, MapSnapshot } from "@mc/core";
import { useEffect, useRef, useState } from "react";
import { useNow } from "../clock.ts";
import { RESOURCES, useResource } from "../data.ts";
import {
  age,
  type BadgeKind,
  badgeModels,
  currentFindings,
  questionLanes,
  recentFailures,
} from "./cards.ts";
import { pinToken } from "./model.ts";
import type { MessageArc } from "./motion.ts";

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
  conversation,
}: {
  snapshot: MapSnapshot;
  seat?: MapSeat;
  kind: BadgeKind;
  onClose: () => void;
  conversation?: Pick<MessageArc, "from" | "to" | "ticket">;
}) {
  const now = useNow();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const badge = seat ? badgeModels(seat, now).find((b) => b.kind === kind) : undefined;
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
        {conversation ? `${conversation.from} ↔ ${conversation.to}` : seat?.seat}
        {!conversation && seat?.ticket != null && ` · #${seat.ticket}`}
      </p>
      {badge && seat ? (
        <>
          <p>
            {badge.text} · {badge.age}
          </p>
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
              {currentFindings(snapshot, seat).map((finding, index) => (
                <Finding
                  // biome-ignore lint/suspicious/noArrayIndexKey: the contract identifies findings by position; duplicate locations and summaries are valid.
                  key={`${finding.file}-${finding.line}-${finding.summary}-${index}`}
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
      ) : kind === "questions" ? (
        <p>No pending questions.</p>
      ) : (
        <p>
          No current{" "}
          {kind === "failures"
            ? "refused or failed calls in the last 10 minutes"
            : titles[kind].toLowerCase()}
          .
        </p>
      )}
      {kind === "questions" && (
        <QuestionLane key={seat?.seat} seat={seat} conversation={conversation} now={now} />
      )}
    </div>
  );
}

function QuestionLane({
  seat,
  now,
  conversation,
}: {
  seat?: MapSeat;
  now: number;
  conversation?: Pick<MessageArc, "from" | "to" | "ticket">;
}) {
  const displayId = seat?.seat;
  const needsFlight =
    displayId === "FLIGHT" || conversation?.from === "FLIGHT" || conversation?.to === "FLIGHT";
  const flightId = useResource<FlightView>(needsFlight ? RESOURCES.flight : null).data?.seat?.id;
  const id = displayId === "FLIGHT" ? flightId : displayId;
  const activity = useResource<{ messages: CommsThreadMessage[] }>(id ? RESOURCES.comms(id) : null);
  const displayEnd = (end: string) => (end === flightId ? "FLIGHT" : end === "MC" ? "HUB" : end);
  const thread = (activity.data?.messages ?? []).map((message) => ({
    ...message,
    from: displayEnd(message.from),
    to: displayEnd(message.to),
  }));
  const laneEnds = (from: string, to: string) =>
    [displayEnd(from), displayEnd(to)].sort() as [string, string];
  const lanes = (seat ? questionLanes(seat) : []).map((lane) => {
    const ends = laneEnds(...lane.ends);
    return { ...lane, ends, key: JSON.stringify(ends) };
  });
  const initial = conversation ? JSON.stringify(laneEnds(conversation.from, conversation.to)) : "";
  if (conversation && !lanes.some((l) => l.key === initial))
    lanes.push({
      key: initial,
      ends: laneEnds(conversation.from, conversation.to),
      questions: [],
    });
  // Answered questions leave the pending badge; retain their lanes in the open thread.
  for (const message of thread) {
    if (message.from !== displayId && message.to !== displayId) continue;
    const ends = [message.from, message.to].sort() as [string, string];
    const key = JSON.stringify(ends);
    if (!lanes.some((l) => l.key === key)) lanes.push({ key, ends, questions: [] });
  }
  const [picked, setPicked] = useState(initial || lanes[0]?.key || "");
  const [ticket, setTicket] = useState(conversation ? String(conversation.ticket) : "all");
  const lane = lanes.find((l) => l.key === picked) ?? lanes[0];
  const questions = lane?.questions ?? [];
  const messages = thread
    .filter((m) => JSON.stringify([m.from, m.to].sort()) === lane?.key)
    // Comms tickets are `repo#7`; questions carry the issue number alone.
    .map((m) => ({
      ...m,
      ticket: m.ticket === null ? null : m.ticket.slice(m.ticket.lastIndexOf("#") + 1),
    }))
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  const tickets = [
    ...new Set([
      ...(conversation ? [conversation.ticket === null ? null : String(conversation.ticket)] : []),
      ...questions.map((q) => (q.ticket === null ? null : String(q.ticket))),
      ...messages.map((m) => m.ticket),
    ]),
  ];
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
      {activity.loading && <p role="status">Loading conversation…</p>}
      {activity.error && <p role="alert">Could not load conversation: {activity.error.message}</p>}
      {activity.data && (
        <>
          <ol aria-label="Lane messages">
            {messages
              .filter((m) => selectedTicket === "all" || String(m.ticket) === selectedTicket)
              .map((m) => (
                <li className="map-finding" key={m.id}>
                  <strong>
                    {m.from} → {m.to}
                  </strong>
                  <p>
                    {m.ticket !== null && `#${m.ticket} · `}
                    {m.at === null ? "Time unknown" : age(m.at, now)}
                  </p>
                  <p className="map-reason">{m.text}</p>
                </li>
              ))}
          </ol>
          {!messages.some(
            (m) => selectedTicket === "all" || String(m.ticket) === selectedTicket,
          ) && <p>No messages in this lane.</p>}
        </>
      )}
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
