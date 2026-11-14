import { agentPath, navigate, route } from "../router.ts";
import { setSelectedAgent } from "../shell/selection.ts";

/**
 * Choose a seat: the address holds it and Back returns to the one before. From a bare `/agent`
 * (the tab's own address, which shows `shown`) that seat is written into the address first, so
 * Back lands on it and not on a bare address that now shows the new choice.
 */
export function chooseSeat(id: string, shown: string | null): void {
  const on = route(window.location.pathname, window.location.search);
  if (on?.page === "agent" && on.id === null && shown !== null && shown !== id)
    navigate(agentPath(shown), { replace: true });
  setSelectedAgent(id);
  navigate(agentPath(id));
}
