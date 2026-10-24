import type { Message } from "./envelope.ts";
import type { Inbox } from "./inbox.ts";

export function mayAutoReply(to: Message): boolean {
  return !to.auto;
}

export function outgoingRate(now: () => number): { allow(): boolean } {
  let sent: number[] = [];
  return {
    allow() {
      const at = now();
      sent = sent.filter((time) => time > at - 60_000);
      if (sent.length >= 10) return false;
      sent.push(at);
      return true;
    },
  };
}

export function similarOpen(room: string, body: string, inbox: Inbox): string | undefined {
  const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
  return inbox
    .threads(room)
    .find(
      (thread) =>
        !thread.closed && thread.question && normalize(thread.question.body) === normalize(body),
    )?.thread;
}
