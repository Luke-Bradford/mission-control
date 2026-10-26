import type { CommsThreadMessage } from "@mc/core";
import { commsContactPath } from "../router.ts";
import { contactSummaries } from "./model.ts";

export function AgentContacts({
  agentId,
  messages,
  selected,
  onNavigate,
}: {
  agentId: string;
  messages: CommsThreadMessage[];
  selected: string | null;
  onNavigate: (path: string) => void;
}) {
  const contacts = contactSummaries(agentId, messages);
  return (
    <aside className="comms-contacts">
      <button type="button" disabled>
        Inbox · what it reads
      </button>
      <p className="note">Not available yet.</p>
      <button type="button" className={selected === null ? "on" : ""}>
        All messages
      </button>
      {contacts.map((contact) => (
        <button
          type="button"
          className={selected === contact.id ? "on" : ""}
          key={contact.id}
          onClick={() => onNavigate(commsContactPath(agentId, contact.id))}
        >
          {`${contact.id} · ${contact.count}`}
          <small>{contact.latest.text}</small>
        </button>
      ))}
    </aside>
  );
}
