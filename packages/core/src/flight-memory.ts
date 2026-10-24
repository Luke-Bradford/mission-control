import {
  FLIGHT_MEMORY_BODY_MAX,
  FLIGHT_MEMORY_KINDS,
  FLIGHT_MEMORY_SOURCE_MAX,
  FLIGHT_MEMORY_TOPIC_MAX,
  type FlightMemoryNote,
} from "./flight.ts";

/** Reject hidden separators before whitespace normalisation can conceal them. */
export function normaliseMemoryTopic(topic: string): string {
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(topic)) throw new Error("Invalid memory topic");
  const normalised = topic.replace(/\s+/gu, " ").trim();
  if (!normalised || normalised.length > FLIGHT_MEMORY_TOPIC_MAX)
    throw new Error("Invalid memory topic");
  return normalised;
}
export const memoryTopicKey = (topic: string): string => normaliseMemoryTopic(topic).toLowerCase();

/** Storage validation without depending on the server or its tool schemas. */
export function validateMemoryNote(note: FlightMemoryNote): FlightMemoryNote {
  const topic = normaliseMemoryTopic(note.topic);
  const source = note.source.trim();
  if (
    !FLIGHT_MEMORY_KINDS.includes(note.kind) ||
    note.body.length > FLIGHT_MEMORY_BODY_MAX ||
    !source ||
    source.length > FLIGHT_MEMORY_SOURCE_MAX ||
    !["flight", "operator"].includes(note.author)
  )
    throw new Error("Invalid memory note");
  return { ...note, topic, source };
}
