import type { CommsThreadMessage } from "@mc/core";
import { useTz } from "../clock.ts";
import { hhmm } from "../fmt.ts";
import { commsAgentPath, commsContactPath, commsInboxPath } from "../router.ts";
import { contactSummaries } from "./model.ts";

export function AgentContacts({
  agentId,
  messages,
  selected,
  inbox,
  onNavigate,
}: {
  agentId: string;
  messages: CommsThreadMessage[];
  selected: string | null;
  inbox: boolean;
  onNavigate: (path: string) => void;
}) {
  const contacts = contactSummaries(agentId, messages);
  const tz = useTz();
  return (
    <aside className="comms-contacts">
      <button
        type="button"
        className={inbox ? "on" : ""}
        onClick={() => onNavigate(commsInboxPath(agentId))}
      >
        Inbox · what it reads
      </button>
      <p className="note">Not available yet.</p>
      <button
        type="button"
        className={selected === null && !inbox ? "on" : ""}
        onClick={() => onNavigate(commsAgentPath(agentId))}
      >
        All messages
      </button>
      {contacts.map((contact) => (
        <button
          type="button"
          className={selected === contact.id ? "on" : ""}
          key={contact.id}
          onClick={() => onNavigate(commsContactPath(agentId, contact.id))}
        >
          {`${contact.id} · ${contact.count}${tz && contact.latest.at !== null ? ` · ${hhmm(contact.latest.at, tz)}` : ""}`}
          <small>{contact.latest.text}</small>
        </button>
      ))}
    </aside>
  );
}
