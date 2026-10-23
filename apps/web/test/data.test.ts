import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIONS, hub, parseTopic, RESOURCES, startStream } from "../src/data.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("parseTopic", () => {
  it("accepts only known topics from the stream", () => {
    expect(parseTopic('{"topic":"limits"}')).toBe("limits");
    expect(parseTopic('{"topic":"nope"}')).toBeNull();
    expect(parseTopic("not json")).toBeNull();
    expect(parseTopic('{"topic":{"x":1}}')).toBeNull();
    expect(parseTopic(undefined)).toBeNull();
  });
});

describe("hub", () => {
  it("refetches only the changed topic, and only what is on screen", async () => {
    const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const offAgents = hub.subscribe("/api/agents", "agents", () => {});
    const offLimits = hub.subscribe("/api/limits", "limits", () => {});
    const offBoard = hub.subscribe("/api/boards/shop-app", "boards", () => {});
    await settle();
    offBoard(); // no longer rendered
    fetchMock.mockClear();

    hub.refetchTopic("limits");
    await settle();
    expect(fetchMock.mock.calls.map((c) => (c as unknown[])[0])).toEqual(["/api/limits"]);

    fetchMock.mockClear();
    hub.refetchTopic("boards");
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    offAgents();
    offLimits();
  });

  it("coalesces changes that arrive during a fetch into one more fetch", async () => {
    let release: () => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((r) => {
          release = () => r(new Response("[]", { status: 200 }));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const off = hub.subscribe("/api/escalations", "escalations", () => {});
    hub.refetchTopic("escalations");
    hub.refetchTopic("escalations");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    release();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    off();
  });
});

describe("hub.clear", () => {
  it("drops fetches in flight from before the clear and notifies listeners", async () => {
    const releases: ((body: string) => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((r) => {
            releases.push((body) => r(new Response(body, { status: 200 })));
          }),
      ),
    );
    const seen: unknown[] = [];
    const path = RESOURCES.crew.path;
    const off = hub.subscribe(path, "agents", () => seen.push(hub.snapshot(path, "agents").data));
    await settle();
    expect(releases).toHaveLength(1);
    seen.length = 0;

    hub.clear(); // the request is still out
    expect(seen[0]).toBeUndefined(); // listeners told: the data is gone
    expect(releases).toHaveLength(2); // and what is on screen is asked for again
    releases[0]?.('["old session data"]');
    await settle();
    expect(hub.snapshot(path, "agents").data).toBeUndefined();
    expect(seen.every((d) => d === undefined)).toBe(true); // the old answer never lands
    off();
  });

  it("refetches what is on screen right after the clear, not at the next event", async () => {
    const fetchMock = vi.fn(async () => new Response('["fresh"]', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const path = RESOURCES.limits.path;
    const off = hub.subscribe(path, "limits", () => {});
    await vi.waitFor(() => expect(hub.snapshot(path, "limits").data).toEqual(["fresh"]));
    fetchMock.mockClear();

    hub.clear();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(hub.snapshot(path, "limits").data).toEqual(["fresh"]));
    off();
  });

  it("does not refetch what nothing is showing", async () => {
    const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const off = hub.subscribe(RESOURCES.limits.path, "limits", () => {});
    await settle();
    off();
    fetchMock.mockClear();
    hub.clear();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a fetch started after the clear lands normally", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('["fresh"]', { status: 200 })),
    );
    hub.clear();
    const off = hub.subscribe(RESOURCES.limits.path, "limits", () => {});
    await vi.waitFor(() =>
      expect(hub.snapshot(RESOURCES.limits.path, "limits").data).toEqual(["fresh"]),
    );
    off();
  });
});

class FakeEventSource {
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 1;
  closed = false;
  readonly listeners = new Map<string, ((ev: unknown) => void)[]>();
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
  emit(type: string, ev: unknown = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}

describe("startStream", () => {
  // What a test opened is undone in afterEach, so a failing assertion cannot leak a stream or a
  // subscription into the tests after it.
  let cleanups: (() => void)[] = [];
  const start = () => {
    const stop = startStream();
    cleanups.push(stop);
    return stop;
  };
  const sub = (...args: Parameters<typeof hub.subscribe>) => {
    const off = hub.subscribe(...args);
    cleanups.push(off);
    return off;
  };
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
    cleanups = [];
    vi.useRealTimers();
  });

  const fetched = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.map((c) => (c as unknown[])[0]);

  it("a changed event refetches the resources on that topic, and no others", async () => {
    const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    sub("/api/limits", "limits", () => {});
    sub("/api/crew", "agents", () => {});
    await settle();
    fetchMock.mockClear();
    start();
    const [es] = FakeEventSource.instances;
    expect(es?.url).toBe("/api/stream");

    es?.emit("changed", { data: '{"topic":"limits"}' });
    await settle();
    expect(fetched(fetchMock)).toEqual(["/api/limits"]);

    fetchMock.mockClear();
    es?.emit("changed", { data: '{"topic":"nope"}' });
    es?.emit("changed", { data: "not json" });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a resource whose last listener left is not refetched by its topic", async () => {
    const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const notified = vi.fn();
    const off = sub("/api/limits", "limits", notified);
    await settle();
    off();
    fetchMock.mockClear();
    notified.mockClear();
    start();
    FakeEventSource.instances[0]?.emit("changed", { data: '{"topic":"limits"}' });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(notified).not.toHaveBeenCalled();
  });

  it("a first open refetches nothing; a reopen refetches everything on screen", async () => {
    const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    sub("/api/limits", "limits", () => {});
    await settle();
    fetchMock.mockClear();
    start();
    const [es] = FakeEventSource.instances;
    es?.emit("open");
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    es?.emit("open");
    await settle();
    expect(fetched(fetchMock)).toEqual(["/api/limits"]);
  });

  it("a stream that is still reconnecting is left to the browser", () => {
    vi.useFakeTimers();
    start();
    const [es] = FakeEventSource.instances as [FakeEventSource];
    es.readyState = 0; // CONNECTING
    es.emit("error");
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(es.closed).toBe(false);
  });

  it("a CLOSED stream is closed, and reopened after 5 s with everything on screen refetched", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    sub("/api/limits", "limits", () => {});
    await vi.advanceTimersByTimeAsync(0);
    fetchMock.mockClear();
    start();
    const [es] = FakeEventSource.instances as [FakeEventSource];
    es.readyState = FakeEventSource.CLOSED;
    es.emit("error");
    expect(es.closed).toBe(true);

    vi.advanceTimersByTime(4999);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(fetched(fetchMock)).toEqual(["/api/limits"]);
  });

  it("stopping closes the stream and cancels a pending retry", () => {
    vi.useFakeTimers();
    const stop = start();
    const [es] = FakeEventSource.instances as [FakeEventSource];
    stop();
    expect(es.closed).toBe(true);

    const stop2 = start();
    const second = FakeEventSource.instances[1] as FakeEventSource;
    second.readyState = FakeEventSource.CLOSED;
    second.emit("error"); // a retry is pending
    stop2();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(2);
  });
});

describe("githubRate", () => {
  it("is refetched by a limits event, which the GitHub poll emits, and not by health", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const off = hub.subscribe(RESOURCES.githubRate.path, RESOURCES.githubRate.topic, () => {});
    await settle();
    fetchMock.mockClear();
    hub.refetchTopic("health");
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    hub.refetchTopic("limits");
    await settle();
    expect(fetchMock.mock.calls.map((c) => (c as unknown[])[0])).toEqual(["/api/limits/github"]);
    off();
  });
});

describe("RESOURCES", () => {
  it("is the one place paths and topics are named", () => {
    expect(RESOURCES.escalations).toEqual({ path: "/api/escalations", topic: "escalations" });
    expect(RESOURCES.limits).toEqual({ path: "/api/limits", topic: "limits" });
    expect(RESOURCES.githubRate).toEqual({ path: "/api/limits/github", topic: "limits" });
    // Adding a repo rewrites config.yaml and emits `config`: both views refetch.
    expect(RESOURCES.repos).toEqual({ path: "/api/repos", topic: "config" });
    expect(RESOURCES.config).toEqual({ path: "/api/config", topic: "config" });
    expect(RESOURCES.boards("a b/c")).toEqual({ path: "/api/boards/a%20b%2Fc", topic: "boards" });
    expect(RESOURCES.runs("shop-app-ta").path).toBe("/api/agents/shop-app-ta/runs?limit=50");
  });

  it("names the HUD's resources and the topics that refresh them", () => {
    expect(RESOURCES.crew).toEqual({ path: "/api/crew", topic: "agents" });
    expect(RESOURCES.flightIncoming).toEqual({ path: "/api/flight/incoming", topic: "flight" });
    expect(RESOURCES.attention).toEqual({ path: "/api/attention", topic: "attention" });
    expect(RESOURCES.machine).toEqual({ path: "/api/machine", topic: "machine" });
    expect(RESOURCES.away).toEqual({ path: "/api/settings/away", topic: "settings" });
    expect(RESOURCES.telemetry("24h")).toEqual({
      path: "/api/telemetry?range=24h",
      topic: "agents",
    });
    expect(RESOURCES.stream("a b")).toEqual({ path: "/api/agents/a%20b/stream", topic: "agents" });
    expect(RESOURCES.prs("shop-app")).toEqual({
      path: "/api/repos/shop-app/prs?linked=1",
      topic: "boards",
    });
    expect(RESOURCES.files("shop-app-ta")).toEqual({
      path: "/api/agents/shop-app-ta/files",
      topic: null,
    });
    expect(ACTIONS.ack).toBe("/api/attention/ack");
    expect(ACTIONS.away).toBe("/api/settings/away");
  });
});
