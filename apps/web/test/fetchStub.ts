import { act, waitFor } from "@testing-library/react";
import { expect, vi } from "vitest";

type Handler = (init: RequestInit | undefined) => { status: number; body: unknown };

/** Stub fetch by "METHOD path" (or path for GET); unknown requests are a 404. */
export function stubFetch(routes: Record<string, Handler | unknown>) {
  const fn = vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const r = routes[`${method} ${input}`] ?? (method === "GET" ? routes[input] : undefined);
    const out =
      typeof r === "function"
        ? (r as Handler)(init)
        : r === undefined
          ? { status: 404, body: { error: "not found" } }
          : { status: 200, body: r };
    return new Response(JSON.stringify(out.body), { status: out.status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Wait until the stubbed answer for `path` has been delivered and the app has rendered it. */
export async function settled(fn: ReturnType<typeof stubFetch>, path: string) {
  await waitFor(() => expect(fn).toHaveBeenCalledWith(path, expect.anything()));
  const i = fn.mock.calls.findIndex(([p]) => p === path);
  await act(async () => {
    await fn.mock.results[i]?.value;
    await new Promise((r) => setTimeout(r, 0));
  });
}
