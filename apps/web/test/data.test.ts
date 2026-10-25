import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIONS, hub, parseTopic, RESOURCES, startStream } from "../src/data.ts";
import { flightLedger, ledgerEntry } from "./flightSummaryFixture.ts";

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
  it("loads every ledger page and keeps the last copy of overlapping keys", async () => {
    const path = RESOURCES.flightLedger.path;
    const fetchMock = vi.fn(async (url: string) =>
      Response.json(
        url === path
          ? { ...flightLedger([ledgerEntry()]), more: true, nextOffset: 1 }
          : flightLedger([
              ledgerEntry({ title: "Updated on next page" }),
              ledgerEntry({ key: "closed", status: "done" }),
            ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const off = hub.subscribe(path, "flight", () => {});
    await vi.waitFor(() => expect(hub.snapshot(path, "flight").loading).toBe(false));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([path, `${path}&offset=1`]);
    expect(hub.snapshot(path, "flight").data).toEqual(
      flightLedger([
        ledgerEntry({ title: "Updated on next page" }),
        ledgerEntry({ key: "closed", status: "done" }),
      ]),
    );
    off();
  });

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
  static OPEN = 1;
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

describe("browser notification resources", () => {
  it("refetches events on both settings and attention invalidations", async () => {
    const fetch = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const off = hub.subscribe(RESOURCES.notificationEvents.path, "attention", () => {});
    await settle();
    fetch.mockClear();
    hub.refetchTopic("settings");
    await settle();
    hub.refetchTopic("attention");
    await settle();
    expect(fetch.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      "/api/notifications/events",
      "/api/notifications/events",
    ]);
    off();
  });
});

it("merges activity deltas and replaces timestamp ties without duplicating rows", async () => {
  hub.clear();
  const at = Date.now();
  const row = (time: number, text: string) => ({ at: time, kind: "state", who: "seat", text });
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify([row(at, "one"), row(at - 1, "old")])))
    .mockResolvedValueOnce(
      new Response(JSON.stringify([row(at + 1, "new"), row(at, "one"), row(at, "tie")])),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify([row(at + 1, "new")])));
  vi.stubGlobal("fetch", fetchMock);
  const off = hub.subscribe(RESOURCES.activity.path, "agents", () => {});
  try {
    await settle();
    hub.refetchTopic("agents");
    await settle();
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/activity?since=${at - 1}`);
    expect(hub.snapshot(RESOURCES.activity.path, "agents").data).toEqual([
      row(at + 1, "new"),
      row(at, "one"),
      row(at, "tie"),
      row(at - 1, "old"),
    ]);
    hub.refetchTopic("agents");
    await settle();
    expect(hub.snapshot(RESOURCES.activity.path, "agents").data).toHaveLength(4);
  } finally {
    off();
    hub.clear();
  }
});

it("requests a delta even when the first activity load is empty", async () => {
  hub.clear();
  const fetchMock = vi.fn(async () => new Response("[]"));
  vi.stubGlobal("fetch", fetchMock);
  const off = hub.subscribe(RESOURCES.activity.path, "agents", () => {});
  try {
    await settle();
    hub.refetchTopic("agents");
    await settle();
    expect(fetchMock.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      "/api/activity",
      "/api/activity?since=0",
    ]);
  } finally {
    off();
    hub.clear();
  }
});

it("starts each activity visit with a full load and shares an in-flight load across subscribers", async () => {
  const fetch = vi.fn(async () => new Response("[]"));
  vi.stubGlobal("fetch", fetch);
  const ref = RESOURCES.activity;
  const first = hub.subscribe(ref.path, ref.topic, () => {});
  first();
  const second = hub.subscribe(ref.path, ref.topic, () => {});
  await settle();
  expect(fetch.mock.calls).toHaveLength(1);
  second();
  const third = hub.subscribe(ref.path, ref.topic, () => {});
  try {
    await settle();
    expect(fetch.mock.calls.map((call) => (call as unknown[])[0])).toEqual([ref.path, ref.path]);
    hub.refetchTopic("agents");
    await settle();
    expect(fetch).toHaveBeenLastCalledWith(`${ref.path}?since=0`, expect.anything());
  } finally {
    third();
  }
});

describe("activity reconciliation", () => {
  let off: (() => void) | undefined;
  beforeEach(() => {
    hub.clear();
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
  });
  afterEach(() => {
    off?.();
    hub.clear();
    vi.useRealTimers();
  });
  const flush = () => vi.advanceTimersByTimeAsync(0);
  const path = RESOURCES.activity.path;
  const snapshot = () => hub.snapshot(path, "agents").data;
  const row = (at: number, text: string) => ({ at, kind: "state", who: "seat", text });
  const load = async (initial: unknown[], fresh: unknown[]) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(initial)))
      .mockImplementation(async () => new Response(JSON.stringify(fresh)));
    vi.stubGlobal("fetch", fetch);
    off = hub.subscribe(path, "agents", () => {});
    await flush();
    return fetch;
  };

  it("keeps cached timestamp ties when a delta only contains the new arrival", async () => {
    const at = Date.now();
    const first = row(at, "alpha");
    const second = row(at, "beta");
    const added = row(at + 1, "new");
    await load([first, second], [added]);
    const before = snapshot() as unknown[];
    hub.refetchTopic("agents");
    await flush();
    expect(snapshot()).toEqual([added, first, second]);
    expect((snapshot() as unknown[])[1]).toBe(before[0]);
    expect((snapshot() as unknown[])[2]).toBe(before[1]);
  });

  it("reuses the cached array and rows for an unchanged full reload with reversed ties", async () => {
    const at = Date.now();
    const first = row(at, "alpha");
    const second = row(at, "beta");
    await load([first, second], [second, first]);
    const before = snapshot();
    hub.refetchAll();
    await flush();
    expect(snapshot()).toBe(before);
  });

  it("updates a run-start row's live status, PRs and summary on the next full load", async () => {
    const initial = {
      ...row(Date.now() - 100, "started"),
      status: "running",
      prs: [],
      summary: null,
    };
    const fresh = { ...initial, status: "done", prs: [42], summary: "finished" };
    const fetch = await load([row(Date.now(), "newest"), initial], [fresh]);
    vi.setSystemTime(Date.now() + 60_000);
    hub.refetchTopic("agents");
    await flush();
    expect(fetch.mock.calls[1]?.[0]).toBe(path);
    expect(snapshot()).toEqual([fresh]);
  });

  it("replaces a collector row that moved to a newer status time without duplicating it", async () => {
    const initial = row(Date.now() - 100, "collector failing");
    const fresh = row(Date.now() + 1, "collector failing again");
    await load([row(Date.now(), "newest"), initial], [fresh]);
    vi.setSystemTime(Date.now() + 60_000);
    hub.refetchTopic("agents");
    await flush();
    expect(snapshot()).toEqual([fresh]);
  });

  it("includes late rows with older timestamps after a full load", async () => {
    const newest = row(Date.now(), "newest");
    const late = row(Date.now() - 100, "late escalation");
    const fetch = await load([newest], [newest, late]);
    vi.setSystemTime(Date.now() + 60_000);
    hub.refetchTopic("agents");
    await flush();
    expect(fetch.mock.calls[1]?.[0]).toBe(path);
    expect(snapshot()).toEqual([newest, late]);
  });

  it("reconnect always requests a full load within the delta window", async () => {
    const fetch = await load([row(Date.now(), "cached")], []);
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    const stop = startStream();
    try {
      const es = FakeEventSource.instances[0];
      es?.emit("open");
      es?.emit("open");
      await flush();
      expect(fetch.mock.calls[1]?.[0]).toBe(path);
      expect(snapshot()).toEqual([]);
    } finally {
      stop();
    }
  });

  it("arms one full-load timer after deltas and fires once at the window boundary", async () => {
    const fetch = await load([row(Date.now(), "cached")], []);
    await vi.advanceTimersByTimeAsync(10_000);
    hub.refetchTopic("agents");
    await flush();
    hub.refetchTopic("agents");
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(49_999);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[3]?.[0]).toBe(path);
    expect(snapshot()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("drops a timer's queued full load when the last subscriber leaves during a delta", async () => {
    const cached = row(Date.now(), "cached");
    const fetch = await load([cached], [cached]);
    hub.refetchTopic("agents");
    await flush();
    expect(vi.getTimerCount()).toBe(1);

    let release: (response: Response) => void = () => {};
    fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    hub.refetchTopic("agents");
    expect(fetch.mock.calls[2]?.[0]).toBe(`/api/activity?since=${Date.now() - 1}`);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(3);

    off?.();
    release(new Response("[]"));
    await flush();
    expect(hub.snapshot(path, "agents").loading).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("clears a pending timer when refetchAll does a full load", async () => {
    const fetch = await load([row(Date.now(), "cached")], []);
    hub.refetchTopic("agents");
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    hub.refetchAll();
    await flush();
    expect(fetch.mock.calls[2]?.[0]).toBe(path);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("clears the timer only when the last subscriber leaves", async () => {
    const fetch = await load([row(Date.now(), "cached")], []);
    const secondOff = hub.subscribe(path, "agents", () => {});
    hub.refetchTopic("agents");
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    secondOff();
    expect(vi.getTimerCount()).toBe(1);
    off?.();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

it("refetches the Overview timeline on agents and guard changes", async () => {
  const fetchMock = vi.fn(async () => Response.json({ from: 0, to: 1, lanes: [] }));
  vi.stubGlobal("fetch", fetchMock);
  const ref = RESOURCES.overviewTimeline;
  const off = hub.subscribe(ref.path, ref.topic, () => {});
  try {
    await settle();
    fetchMock.mockClear();
    for (const topic of ["agents", "guard"] as const) {
      hub.refetchTopic(topic);
      await settle();
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(ref.path, expect.anything());
  } finally {
    off();
  }
});

it("overview refetches on every dependency topic and preserves its session", async () => {
  const fetchMock = vi.fn(async () => Response.json({ at: 1 }));
  vi.stubGlobal("fetch", fetchMock);
  const ref = RESOURCES.overview("session/one");
  expect(ref.path).toBe("/api/overview?session=session%2Fone");
  expect(RESOURCES.overview("session/one").topic).toBe(ref.topic);
  expect(ref.topic).toEqual(["agents", "boards", "limits", "attention", "machine"]);
  const off = hub.subscribe(ref.path, ref.topic, () => {});
  await settle();
  for (const topic of ["agents", "boards", "limits", "attention", "machine"] as const) {
    fetchMock.mockClear();
    hub.refetchTopic(topic);
    await settle();
    expect(fetchMock.mock.calls).toHaveLength(1);
  }
  fetchMock.mockClear();
  hub.refetchTopic("health");
  await settle();
  expect(fetchMock).not.toHaveBeenCalled();
  off();
});

it("coalesces overview topics within one macrotask and omits the All session filter", async () => {
  expect(RESOURCES.overview("all").path).toBe("/api/overview");
  expect(RESOURCES.overview().path).toBe("/api/overview");
  const fetchMock = vi.fn(async () => Response.json({ at: 1 }));
  vi.stubGlobal("fetch", fetchMock);
  const ref = RESOURCES.overview();
  const off = hub.subscribe(ref.path, ref.topic, () => {});
  await settle();
  fetchMock.mockClear();
  hub.refetchTopic("agents");
  hub.refetchTopic("attention");
  await settle();
  await settle();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  off();
});

it("refetches the live log on guard, health and board changes", async () => {
  const fetchMock = vi.fn(async () => Response.json([]));
  vi.stubGlobal("fetch", fetchMock);
  const ref = RESOURCES.activity;
  const off = hub.subscribe(ref.path, ref.topic, () => {});
  try {
    await settle();
    for (const topic of ["guard", "health", "boards"] as const) {
      fetchMock.mockClear();
      hub.refetchTopic(topic);
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  } finally {
    off();
  }
});
