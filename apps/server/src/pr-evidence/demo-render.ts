/** The one way a capture renders a page: in Demo, so neither side shows the live hub's data. */
import { hudRenderRequest, renderHudInHelper } from "../flight/hud-render.ts";

export type EvidenceHudRenderer = typeof renderHudInHelper;

/** `render` for the capture: Demo on, the given scheme and viewport, on the side's own origin. */
export function evidenceDemoRender(
  origin: string,
  path: string,
  scheme: "light" | "dark",
  viewport: { width: number; height: number },
  signal: AbortSignal,
  renderer: EvidenceHudRenderer = renderHudInHelper,
): Promise<Buffer> {
  const guard = hudRenderRequest(origin);
  return renderer(guard.page(path), guard, { demo: true, colorScheme: scheme, viewport, signal });
}
