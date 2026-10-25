import { vi } from "vitest";

vi.mock("three", async (original) => {
  const { vi } = await import("vitest");
  const state = { render: vi.fn(), dispose: vi.fn(), fail: false };
  return {
    ...(await original<typeof import("three")>()),
    WebGLRenderer: class {
      static state = state;
      domElement = document.createElement("canvas");
      render = state.render;
      dispose = state.dispose;
      constructor() {
        if (state.fail) throw new Error("No WebGL");
      }
      setPixelRatio() {}
      setSize() {}
    },
  };
});

import * as THREE from "three";
export const renderer = (
  THREE.WebGLRenderer as unknown as {
    state: { render: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; fail: boolean };
  }
).state;
