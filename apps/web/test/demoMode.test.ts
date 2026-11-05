import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiDelete,
  apiGet,
  apiOperatorGet,
  apiPost,
  apiPut,
  apiReviewImage,
  forgetOperatorToken,
  loadOperatorToken,
  openStream,
} from "../src/api.ts";
import { startClient } from "../src/bootstrap.ts";
import { hub, RESOURCES } from "../src/data.ts";
import { DEMO_REFUSED, DEMO_UNAVAILABLE, demoMode, isDemo, setDemo } from "../src/demo/mode.ts";
import { LANE_KEY, readKey, THEME_KEY, writeKey } from "../src/storage.ts";
import { demoSeed } from "./overviewDensityFixtures.ts";

let fetchSpy: ReturnType<typeof vi.fn>;
let sources: number;
class SpiedEventSource {
  constructor() {
    sources++;
  }
  addEventListener() {}
  close() {}
}

beforeEach(() => {
  sources = 0;
  fetchSpy = vi.fn(async () => new Response("{}", { status: 404 }));
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubGlobal("EventSource", SpiedEventSource);
  forgetOperatorToken();
});
afterEach(() => vi.unstubAllGlobals());

describe("Demo at the network door", () => {
  it("makes no call for any door, and refuses every write with the demo words", async () => {
    setDemo(true);
    await expect(apiPost("/api/comms", { text: "hello" })).rejects.toThrow(DEMO_REFUSED);
    await expect(apiPut("/api/settings/away", {})).rejects.toThrow(DEMO_REFUSED);
    await expect(apiDelete("/api/accounts/claude-main")).rejects.toThrow(DEMO_REFUSED);
    await loadOperatorToken();
    expect(await apiOperatorGet<{ operator: unknown }>("/api/config")).toHaveProperty("operator");
    const image = await apiReviewImage("f".repeat(32));
    expect(image.type).toBe("image/png");
    const stream = openStream("/api/stream");
    expect(stream.readyState).not.toBe(2);
    stream.close();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sources).toBe(0);
  });

  it("answers a read from the simulator, and a path it has no data for with a plain 404", async () => {
    setDemo(true);
    const rows = await apiGet<{ rows: unknown[] }>("/api/crew?shape=summary");
    expect(rows.rows).toHaveLength(11);
    await expect(apiGet("/api/not-a-real-path")).rejects.toThrow("Demo has no data for this view.");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers a failed chunk load with the unavailable words", async () => {
    setDemo(true);
    vi.doMock("../src/demo/source.ts", () => {
      throw new Error("chunk failed");
    });
    vi.resetModules();
    const api = await import("../src/api.ts");
    const mode = await import("../src/demo/mode.ts");
    mode.setDemo(true);
    await expect(api.apiGet("/api/config")).rejects.toThrow(DEMO_UNAVAILABLE);
    vi.doUnmock("../src/demo/source.ts");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("goes to the real fetch and EventSource in Live, with today's arguments", async () => {
    setDemo(false);
    expect(isDemo()).toBe(false);
    fetchSpy.mockResolvedValueOnce(Response.json({ ok: true }));
    await apiGet("/api/config");
    expect(fetchSpy).toHaveBeenCalledWith("/api/config", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    openStream("/api/stream");
    expect(sources).toBe(1);
  });

  it("keeps the flag per tab, in sessionStorage, and survives a fresh read", () => {
    setDemo(true);
    expect(sessionStorage.getItem("mc-demo")).toBe("true");
    expect(demoMode.get()).toBe(true);
    setDemo(false);
    expect(sessionStorage.getItem("mc-demo")).toBe("false");
  });
});

describe("a switch between Live and Demo", () => {
  it("drops a Live answer that was still in flight, and fetches the new world fresh", async () => {
    let answerLive: (r: Response) => void = () => {};
    fetchSpy.mockImplementation((path: string) =>
      path === RESOURCES.crew.path
        ? new Promise<Response>((resolve) => {
            answerLive = resolve;
          })
        : Promise.resolve(new Response("{}", { status: 404 })),
    );
    const stop = startClient(() => {});
    const off = hub.subscribe(RESOURCES.crew.path, RESOURCES.crew.topic, () => {});
    expect(fetchSpy).toHaveBeenCalledWith(RESOURCES.crew.path, expect.anything());
    setDemo(true);
    answerLive(Response.json({ rows: [{ id: "LIVE-SENTINEL" }], firstRunToday: null }));
    await new Promise((r) => setTimeout(r, 20));
    expect(hub.snapshot(RESOURCES.crew.path, RESOURCES.crew.topic).data).toBeUndefined();
    // No refetch from the old tree: the shell remounts and each new subscriber fetches itself.
    off();
    const callsBefore = fetchSpy.mock.calls.length;
    const off2 = hub.subscribe(RESOURCES.crew.path, RESOURCES.crew.topic, () => {});
    await new Promise((r) => setTimeout(r, 50));
    const data = hub.snapshot(RESOURCES.crew.path, RESOURCES.crew.topic).data as {
      rows: unknown[];
    };
    expect(data.rows).toHaveLength(11);
    expect(fetchSpy.mock.calls.length).toBe(callsBefore);
    off2();
    stop();
  });

  it("asks the hub for the token again when it returns to Live", async () => {
    setDemo(true);
    const stop = startClient(() => {});
    expect(fetchSpy).not.toHaveBeenCalled();
    setDemo(false);
    expect(fetchSpy).toHaveBeenCalledWith("/api/operator/bootstrap", expect.anything());
    stop();
  });

  it("keeps a choice written in Demo out of Live's, except the theme", () => {
    writeKey(LANE_KEY, "live-lane");
    writeKey(THEME_KEY, "dark");
    setDemo(true);
    expect(readKey(LANE_KEY)).toBeNull();
    writeKey(LANE_KEY, "demo-lane");
    expect(readKey(THEME_KEY)).toBe("dark");
    setDemo(false);
    expect(readKey(LANE_KEY)).toBe("live-lane");
    expect(localStorage.getItem("mc-demo:mc-lane")).toBe("demo-lane");
  });
});

describe("the only doors", () => {
  const SRC = join(import.meta.dirname, "../src");
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
    );
  const sources = files(SRC).filter((f) => /\.tsx?$/.test(f));
  const outside = (re: RegExp) =>
    sources
      .filter((f) => relative(SRC, f) !== "api.ts")
      .filter((f) => re.test(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")))
      .map((f) => relative(SRC, f));

  it("finds fetch( and new EventSource only in api.ts", () => {
    expect(outside(/(?<![.\w])(?<!async )fetch\(/)).toEqual([]);
    expect(outside(/new EventSource/)).toEqual([]);
  });

  it("holds no token, real path or real account in the seed", () => {
    expect(JSON.stringify(demoSeed())).not.toMatch(
      /gh[pousr]_|sk-[A-Za-z0-9]|Bearer |\/Users\/|xox[abp]-/,
    );
  });
});
