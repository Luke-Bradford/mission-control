import { AsyncLocalStorage } from "node:async_hooks";

/** Internal in-process dispatch context. No client header or payload can install a callback. */
const dispatchGuard = new AsyncLocalStorage<() => void>();
export const withinBriefDispatch = <T>(guard: () => void, run: () => T): T =>
  dispatchGuard.run(guard, run);
/** Shared handlers retain their existing auth and add this final precondition for a brief call. */
export const checkBriefDispatch = (): void => dispatchGuard.getStore()?.();

export const boundBriefGuard = (): (() => void) | undefined => dispatchGuard.getStore();
