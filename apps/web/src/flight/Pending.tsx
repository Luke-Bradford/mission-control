import { hub, type ResourceRef } from "../data.ts";

/**
 * What a panel shows until its data is here: a named loading line, or what failed with a Retry. The
 * dash is for a field that is unknown, never for a request still in flight or one that failed.
 */
export function Pending({
  what,
  error,
  resource,
}: {
  /** The data in words, such as "decisions". */
  what: string;
  error: Error | null;
  resource: ResourceRef;
}) {
  if (error === null)
    return (
      <p className="pb note" role="status" aria-busy="true">
        Loading {what}…
      </p>
    );
  return (
    <div className="pb">
      <p className="note err" role="alert">
        Could not load {what}: {error.message}
      </p>
      <button type="button" className="sm" onClick={() => hub.refetch(resource.path)}>
        Retry
      </button>
    </div>
  );
}
