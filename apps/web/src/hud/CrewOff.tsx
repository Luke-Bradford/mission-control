import { RESOURCES, useResource } from "../data.ts";

/** `GET /api/crew/status`: `note` says why crew is off, when it is. */
interface CrewStatus {
  enabled: boolean;
  note: string | null;
}

/** The line where crew seats are listed when the server runs with crew off; nothing while on. */
export function CrewOff({ className = "note s" }: { className?: string }) {
  const status = useResource<CrewStatus>(RESOURCES.crewStatus).data;
  if (status?.enabled !== false) return null;
  return (
    <p className={className} role="status">
      {status.note ? `Crew is off: ${status.note}` : "Crew is off."}
    </p>
  );
}
