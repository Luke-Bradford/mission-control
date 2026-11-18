import { type ComponentProps, createContext, useContext } from "react";
import { Panel } from "../hud/Panel.tsx";

/**
 * The panel ids a tab shows from the groups that predate the tabs; null shows every panel. A group
 * renders all its panels and this leaves out the ones that belong on another tab.
 */
export const VisiblePanels = createContext<ReadonlySet<string> | null>(null);

/** Whether the tab being shown holds the panel `id`. */
export function useShows(id: string): boolean {
  const visible = useContext(VisiblePanels);
  return visible === null || visible.has(id);
}

/** `Panel` that stays out of the way when its id is not on the tab being shown. */
export function TPanel(props: ComponentProps<typeof Panel>) {
  const visible = useContext(VisiblePanels);
  if (visible !== null && props.id !== undefined && !visible.has(props.id)) return null;
  return <Panel {...props} />;
}
