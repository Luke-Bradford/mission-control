import type { ConfigView } from "@mc/core";

/** Reserve the mockup's eight rows until configuration can supply the actual roster. */
export const OVERVIEW_LOADING_ROWS = 8;

export function configuredAgents(config: ConfigView | undefined) {
  return [
    ...(config?.crew?.sessions ?? []).flatMap((session) =>
      session.seats.map((seat) => ({
        id: seat.id,
        name: seat.displayCallSign ?? seat.id,
        sessionId: session.id,
        repoId: session.repoId,
      })),
    ),
    ...(config?.loops ?? []).map((loop) => ({
      id: loop.id,
      name: loop.id,
      sessionId: null,
      repoId: loop.repoId,
    })),
  ];
}
