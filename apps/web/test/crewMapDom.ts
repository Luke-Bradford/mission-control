import { vi } from "vitest";

/** A 2D context that accepts every call: the map's drawing is judged by what it reports, not by pixels. */
function quietContext(): CanvasRenderingContext2D {
  const gradient = { addColorStop: () => undefined };
  const own: Record<string, unknown> = {};
  return new Proxy(own, {
    get: (target, key: string) => {
      if (key in target) return target[key];
      if (key === "measureText") return () => ({ width: 6 });
      if (key.startsWith("create")) return () => gradient;
      if (key === "getLineDash") return () => [];
      return () => undefined;
    },
    set: (target, key: string, value) => {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

export type DomHarness = {
  /** Run every frame the map asked for, `frames` times over. */
  frames: (count?: number) => void;
  /** How many frames are waiting for the browser right now. */
  pending: () => number;
  /** Tell the map's size observer the stage is now this big. */
  resize: (width: number, height: number) => void;
  setReducedMotion: (reduced: boolean) => void;
  setHidden: (hidden: boolean) => void;
  restore: () => void;
};

/** What jsdom lacks and the map needs: a canvas, observers, a frame clock and a motion setting. */
export function installMapDom(size = { width: 360, height: 356 }): DomHarness {
  const queue = new Map<number, FrameRequestCallback>();
  let next = 1;
  let wall = 0;
  const observers = new Set<(width: number, height: number) => void>();
  let reduced = false;
  const motion = new Set<() => void>();
  let hidden = false;

  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queue.set(next, cb);
    return next++;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => void queue.delete(id));
  vi.stubGlobal(
    "Path2D",
    class {
      moveTo() {}
      lineTo() {}
      quadraticCurveTo() {}
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
      }
      observe() {
        const fire = (width: number, height: number) =>
          this.cb(
            [{ contentRect: { width, height } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        observers.add(fire);
        setTimeout(() => fire(size.width, size.height), 0);
      }
      disconnect() {}
      unobserve() {}
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private readonly cb: IntersectionObserverCallback;
      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb;
      }
      observe() {
        setTimeout(
          () =>
            this.cb(
              [{ isIntersecting: true } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver,
            ),
          0,
        );
      }
      disconnect() {}
      unobserve() {}
    },
  );
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(() => quietContext() as never);
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    get matches() {
      return reduced;
    },
    addEventListener: (_: string, fn: () => void) => motion.add(fn),
    removeEventListener: (_: string, fn: () => void) => motion.delete(fn),
  }));
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });

  return {
    frames(count = 1) {
      for (let i = 0; i < count; i++) {
        const due = [...queue];
        queue.clear();
        wall += 16;
        for (const [, cb] of due) cb(wall);
      }
    },
    pending: () => queue.size,
    resize(width, height) {
      for (const fire of observers) fire(width, height);
    },
    setReducedMotion(value) {
      reduced = value;
      for (const fn of motion) fn();
    },
    setHidden(value) {
      hidden = value;
      document.dispatchEvent(new Event("visibilitychange"));
    },
    restore() {
      getContext.mockRestore();
      vi.unstubAllGlobals();
      Reflect.deleteProperty(document, "hidden");
    },
  };
}

/**
 * The least the map needs to mount without crashing in a page test that does not look at it: a
 * canvas that takes every call and observers that never fire. The map then draws nothing.
 */
export function installMapStubs(): void {
  if (!vi.isMockFunction(HTMLCanvasElement.prototype.getContext))
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => quietContext() as never,
    );
  const watcher = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  for (const name of ["ResizeObserver", "Path2D"] as const)
    if (!(name in globalThis)) vi.stubGlobal(name, watcher);
}
