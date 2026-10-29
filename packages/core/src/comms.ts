/** Shared stored-Comms contract.  Keep the wire values here: seats and the hub use the same set. */
export const COMMS_LABELS = ["question", "handoff", "blocker"] as const;
export const COMMS_REACTIONS = ["seen", "on_it", "done", "cant"] as const;
export const COMMS_CREW = "crew";
export const COMMS_RATE_LIMIT_COUNT = 30;
export const COMMS_RATE_LIMIT_WINDOW_MS = 10 * 60_000;
export const COMMS_CANT_REASON_MAX = 80;
/** A labelled question or blocker waits this long for its addressee before FLIGHT is told. */
export const COMMS_FLIGHT_ESCALATION_MS = 15 * 60_000;
/** FLIGHT has this additional time to settle an escalated Comms item before CAPCOM decides. */
export const COMMS_CAPCOM_ESCALATION_MS = 30 * 60_000;
/** One ticket conversation is chatter once both participants have exceeded this many rounds. */
export const COMMS_CHATTER_ROUNDS = 6;
/** The rolling conversation window used to spot a pair stuck in a ticket discussion. */
export const COMMS_CHATTER_WINDOW_MS = 2 * 60 * 60_000;
/** The only ticket references accepted at Comms boundaries. */
export const COMMS_REF = /^(?:#\d+|PR \d+)$/;
/** A hub-set ticket keeps the repository alongside its issue number. */
export const COMMS_TICKET = /^[^#]+#[1-9]\d*$/;

export const COMMS_TEXT_MAX = 32_000;
export const COMMS_MESSAGE_MAX = COMMS_TEXT_MAX;
export const COMMS_MESSAGE_BODY_LIMIT = COMMS_MESSAGE_MAX * 6 + 1024;
export const commsCutMarker = (kept: number, total: number): string =>
  `\n[stored text cut at ${kept} of ${total} characters]`;

export type CommsLabel = (typeof COMMS_LABELS)[number];
export type CommsReactionKind = (typeof COMMS_REACTIONS)[number];
export interface CommsSendInput {
  to: string;
  text: string;
  label?: CommsLabel;
  ref?: string;
  replyTo?: string;
  /** A run-specific delivery stays pending for this run when its seat takes other work. */
  targetRunId?: string;
}
export interface CommsReaction {
  messageId: string;
  actor: string;
  reaction: CommsReactionKind;
  reason: string | null;
  at: number;
}
export interface CommsMessage {
  id: string;
  at: number;
  from: string;
  to: string;
  text: string;
  ticket: string | null;
  label: CommsLabel | null;
  ref: string | null;
  replyTo: string | null;
  mentions: string[];
  reactions: CommsReaction[];
  pinned?: boolean;
  operator: boolean;
}
export interface CommsContact {
  id: string;
  lastMessage: CommsMessage | null;
  count: number;
  unread: number;
}
export interface CommsMention {
  message: CommsMessage;
  seen: boolean;
}
export interface CommsLinkCount {
  from: string;
  to: string;
  count: number;
  tokens: number;
}
export interface CommsTicketContext {
  ref: string;
  linkedPr: string | null;
  title: string | null;
  status: string | null;
  owner: string | null;
  repoId: string | null;
  issueNumber: number | null;
}
export interface CommsMessagesResponse {
  messages: CommsMessage[];
  cursor?: string | null;
  unread?: number;
}
export interface CommsAgentResponse extends CommsMessagesResponse {
  inbox: CommsMessage[];
  contacts: CommsContact[];
  inboxCursor?: string | null;
  inboxUnread?: number;
  /** The agent's unread lines to the operator since CAPCOM's last prompt, transcript replies included. */
  directUnread?: number;
}
export interface CommsTicketResponse extends CommsMessagesResponse {
  ticket: CommsTicketContext;
}
export interface CommsMentionsResponse {
  mentions: CommsMention[];
}
export interface CommsPinsResponse {
  messages: CommsMessage[];
}
export interface CommsLinksResponse {
  links: CommsLinkCount[];
}
export interface CommsOpenItem {
  id: string;
  label: "question" | "blocker";
  from: string;
  to: string;
  ticket: string | null;
  waitedMs: number;
  nextStep: "flight" | "flight-not-triaging";
  nextAt: number;
}
