import { AsyncLocalStorage } from "node:async_hooks";

/** Private in-process context. No header or producer input can install a callback or identity. */
const dispatchGuard = new AsyncLocalStorage<{
  guard: () => void;
  identity?: string;
  active: boolean;
}>();
export async function withinBriefDispatch<T>(
  guard: () => void,
  run: () => Promise<T>,
  identity?: string,
): Promise<T> {
  const context = { guard, identity, active: true };
  try {
    return await dispatchGuard.run(context, run);
  } finally {
    context.active = false;
  }
}
export const checkBriefDispatch = (): void => {
  const context = dispatchGuard.getStore();
  if (context?.active) context.guard();
};
export const boundBriefGuard = (): (() => void) | undefined => {
  const context = dispatchGuard.getStore();
  return context?.active
    ? () => {
        if (context.active) context.guard();
      }
    : undefined;
};
export const boundBriefIdentity = (): string | undefined => {
  const context = dispatchGuard.getStore();
  return context?.active ? context.identity : undefined;
};
/** After the explicit effect commits, subsequent engine work uses its normal current guards. */
export const withoutBriefDispatch = <T>(run: () => T): T => {
  const context = dispatchGuard.getStore();
  if (!context) return run();
  context.active = false;
  return dispatchGuard.exit(run);
};
