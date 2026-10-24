import {
  FLIGHT_MEMORY_BODY_MAX,
  FLIGHT_MEMORY_KINDS,
  FLIGHT_MEMORY_SOURCE_MAX,
  FLIGHT_MEMORY_TOPIC_MAX,
  type FlightMemoryNote,
  type FlightState,
} from "@mc/core";
import { z } from "zod";

export const FlightMemoryTopic = z
  .string()
  .regex(/^[^\p{Cc}\p{Cf}\u2028\u2029]*$/u)
  .overwrite((topic) => topic.replace(/\s+/gu, " ").trim())
  .min(1)
  .max(FLIGHT_MEMORY_TOPIC_MAX);
export const FlightMemoryInput = z.object({
  topic: FlightMemoryTopic,
  kind: z.enum(FLIGHT_MEMORY_KINDS),
  body: z.string().max(FLIGHT_MEMORY_BODY_MAX),
  source: z.string().trim().min(1).max(FLIGHT_MEMORY_SOURCE_MAX),
});

const namesIn = (text: string, name: string): boolean => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const before = name.startsWith("#") ? "[#0-9]" : "[\\w#/-]";
  return new RegExp(`(?<!${before})${escaped}(?![\\w/-])`, "i").test(text);
};

/** Match complete identifiers, so #12 never links a note about #123. */
export function linkedMemory(notes: FlightMemoryNote[], state: FlightState): FlightMemoryNote[] {
  const signals = state.signals;
  const evidence = [
    ...signals.map((s) => `${s.key} ${s.evidence}`),
    ...state.questions.map((q) => `${q.seat} ${q.ticket ?? ""} ${q.text}`),
  ].join("\n");
  const names = new Set<string>(evidence.match(/#[1-9][0-9]*\b/g) ?? []);
  for (const seat of state.seats) {
    if (namesIn(evidence, seat.id)) names.add(seat.id);
  }
  for (const signal of signals) {
    for (const check of signal.checks ?? []) names.add(check);
    if (signal.kind === "flaky_test") {
      const key = signal.key.slice(signal.key.indexOf(":") + 1);
      names.add(key);
    }
  }
  for (const name of evidence.match(/\b[\w./-]+\.(?:test|spec)\.[\w]+\b/g) ?? []) names.add(name);
  for (const pr of state.prs) {
    for (const name of pr.failingChecks) if (namesIn(evidence, name)) names.add(name);
  }
  return notes.filter((note) => [...names].some((name) => namesIn(note.topic, name)));
}
