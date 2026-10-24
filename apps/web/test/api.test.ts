import { OPERATOR_BOOTSTRAP_PATH, OPERATOR_HEADER, OPERATOR_TOKEN_REQUIRED } from "@mc/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  errorNote,
  forgetOperatorToken,
  loadOperatorToken,
} from "../src/api.ts";
import { ACTIONS, RESOURCES } from "../src/data.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(forgetOperatorToken);
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("errorNote", () => {
  it("is the note of a failed response that carried one", () => {
    expect(errorNote(new ApiError(502, "git failed", { error: "git failed", note: "n" }))).toBe(
      "n",
    );
  });

  it.each([
    ["an empty note", new ApiError(502, "x", { error: "x", note: "" })],
    ["a note that is not a string", new ApiError(502, "x", { error: "x", note: 5 })],
    ["a null note", new ApiError(502, "x", { error: "x", note: null })],
    ["an error with no body", new ApiError(502, "HTTP 502")],
    ["a body that is not an object", new ApiError(502, "x", null)],
    ["an error that is not an ApiError", Object.assign(new Error("x"), { body: { note: "n" } })],
  ])("is null for %s", (_name, error) => {
    expect(errorNote(error)).toBeNull();
  });
});

describe("api", () => {
  it("bootstraps once with same-origin credentials, authenticates POSTs, and leaves GETs bare", async () => {
    const fetchMock = vi.fn(async () => json(200, { token: "boot-token" }));
    vi.stubGlobal("fetch", fetchMock);
    await loadOperatorToken();
    await loadOperatorToken();
    await apiPost("/api/attention/ack", { keys: ["one"] });
    await apiGet("/api/attention");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      OPERATOR_BOOTSTRAP_PATH,
      expect.objectContaining({ credentials: "same-origin" }),
    );
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(new Headers(calls[0]?.[1].headers).has(OPERATOR_HEADER)).toBe(false);
    expect(new Headers(calls[1]?.[1].headers).get(OPERATOR_HEADER)).toBe("boot-token");
    expect(new Headers(calls[2]?.[1].headers).has(OPERATOR_HEADER)).toBe(false);
  });

  it("shares an in-flight bootstrap and holds every early POST until it completes", async () => {
    let resolveBootstrap!: (response: Response) => void;
    const bootstrap = new Promise<Response>((resolve) => {
      resolveBootstrap = resolve;
    });
    const fetchMock = vi.fn(async (path: string) =>
      path === OPERATOR_BOOTSTRAP_PATH ? bootstrap : json(200, { ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const first = loadOperatorToken();
    const second = loadOperatorToken();
    const posts = [apiPost(ACTIONS.ack), apiPost(ACTIONS.away)];
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveBootstrap(json(200, { token: "ready" }));
    await Promise.all([first, second, ...posts]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const path of [ACTIONS.ack, ACTIONS.away]) {
      expect(fetchMock).toHaveBeenCalledWith(
        path,
        expect.objectContaining({
          headers: expect.objectContaining({ [OPERATOR_HEADER]: "ready" }),
        }),
      );
    }
  });

  it("authenticates every HUD action on its first POST", async () => {
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === OPERATOR_BOOTSTRAP_PATH) return json(200, { token: "required" });
      return new Headers(init?.headers).get(OPERATOR_HEADER) === "required"
        ? json(200, { ok: true })
        : json(401, { error: OPERATOR_TOKEN_REQUIRED });
    });
    vi.stubGlobal("fetch", fetchMock);
    await loadOperatorToken();
    const paths = [
      ...Object.values(ACTIONS).map((action) =>
        typeof action === "string" ? action : action("id", "topic"),
      ),
      RESOURCES.discussion("key").path,
      RESOURCES.teamsSelection.path,
    ];
    for (const path of paths) await expect(apiPost(path)).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(paths.length + 1);
  });

  it.each([undefined, "stale"])(
    "refreshes a missing or stale token (%s) and replays the JSON body once",
    async (token) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      if (token) {
        fetchMock.mockResolvedValueOnce(json(200, { token }));
        await loadOperatorToken();
        fetchMock.mockClear();
      }
      fetchMock
        .mockResolvedValueOnce(json(401, { error: OPERATOR_TOKEN_REQUIRED }))
        .mockResolvedValueOnce(json(200, { token: "fresh" }))
        .mockResolvedValueOnce(json(200, { ok: true }));
      await expect(apiPost(ACTIONS.ack, { keys: ["one"] })).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock).toHaveBeenNthCalledWith(2, OPERATOR_BOOTSTRAP_PATH, expect.anything());
      expect(fetchMock).toHaveBeenNthCalledWith(
        3,
        ACTIONS.ack,
        expect.objectContaining({
          method: "POST",
          credentials: "same-origin",
          headers: expect.objectContaining({ [OPERATOR_HEADER]: "fresh" }),
          body: JSON.stringify({ keys: ["one"] }),
        }),
      );
    },
  );

  it("throws the complete second 401 after exactly one retry", async () => {
    const body = { error: OPERATOR_TOKEN_REQUIRED, note: "still refused" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(401, body))
      .mockResolvedValueOnce(json(200, { token: "fresh" }))
      .mockResolvedValueOnce(json(401, body));
    vi.stubGlobal("fetch", fetchMock);
    const err = await apiPost(ACTIONS.ack).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, message: OPERATOR_TOKEN_REQUIRED, body });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["another error", () => json(401, { error: "other", note: "kept" }), "other"],
    ["non-JSON", () => new Response("unauthorized", { status: 401 }), "HTTP 401"],
  ])("does not retry a 401 with %s", async (_name, response, message) => {
    const fetchMock = vi.fn(response);
    vi.stubGlobal("fetch", fetchMock);
    await expect(apiPost(ACTIONS.ack)).rejects.toMatchObject({ status: 401, message });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["network failure", () => Promise.reject(new Error("offline"))],
    ["HTTP failure", () => json(403, { token: "untrusted" })],
    ["invalid JSON", () => new Response("bad JSON")],
    ["invalid token", () => json(200, { token: 123 })],
    ["null body", () => json(200, null)],
  ])("swallows bootstrap %s and allows a subsequent load", async (_name, response) => {
    const fetchMock = vi.fn().mockImplementationOnce(response).mockResolvedValueOnce(json(200, {}));
    vi.stubGlobal("fetch", fetchMock);
    await expect(loadOperatorToken()).resolves.toBeUndefined();
    await apiPost(ACTIONS.ack);
    expect(new Headers(fetchMock.mock.calls[1]?.[1].headers).has(OPERATOR_HEADER)).toBe(false);
    fetchMock.mockResolvedValueOnce(json(200, { token: "recovered" }));
    await loadOperatorToken();
    expect(fetchMock).toHaveBeenNthCalledWith(3, OPERATOR_BOOTSTRAP_PATH, expect.anything());
  });

  it("forgets the cached token", async () => {
    const fetchMock = vi.fn(async () => json(200, { token: "forgotten" }));
    vi.stubGlobal("fetch", fetchMock);
    await loadOperatorToken();
    forgetOperatorToken();
    await apiPost(ACTIONS.ack);
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(new Headers(calls[1]?.[1].headers).has(OPERATOR_HEADER)).toBe(false);
  });

  it("GETs same-origin JSON", async () => {
    const fetchMock = vi.fn(async () => json(200, [{ id: "a" }]));
    vi.stubGlobal("fetch", fetchMock);
    expect(await apiGet("/api/agents")).toEqual([{ id: "a" }]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/agents");
    expect(init.credentials).toBe("same-origin");
  });

  it("POSTs JSON with the JSON content type and a {} body", async () => {
    const fetchMock = vi.fn(async () => json(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await apiPost("/api/agents/shop-app-ta/pause");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(init.body).toBe("{}");
  });

  it.each(["PUT", "DELETE"] as const)(
    "%s sends the operator token and preserves its body and headers on a token retry",
    async (method) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      fetchMock.mockResolvedValueOnce(json(200, { token: "stale" }));
      await loadOperatorToken();
      fetchMock.mockClear();
      fetchMock
        .mockResolvedValueOnce(json(401, { error: OPERATOR_TOKEN_REQUIRED }))
        .mockResolvedValueOnce(json(200, { token: "fresh" }))
        .mockResolvedValueOnce(json(200, { ok: true }));
      const path = ACTIONS.flightMemory("shop-app", "tests/locks");
      const body = { kind: "lesson", body: "Use the lock", source: "PR #450" };
      await (method === "PUT" ? apiPut(path, body) : apiDelete(path));
      expect(fetchMock).toHaveBeenCalledTimes(3);
      for (const [index, token] of [
        [0, "stale"],
        [2, "fresh"],
      ] as const) {
        const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
        const headers = new Headers(init.headers);
        expect(url).toBe(path);
        expect(init.method).toBe(method);
        expect(init.credentials).toBe("same-origin");
        expect(headers.get(OPERATOR_HEADER)).toBe(token);
        if (method === "PUT") {
          expect(headers.get("content-type")).toBe("application/json");
          expect(init.body).toBe(JSON.stringify(body));
        } else {
          expect(headers.has("content-type")).toBe(false);
          expect(init).not.toHaveProperty("body");
        }
      }
    },
  );

  it("carries the server's status and error text for other failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(409, { error: "pause arrives with cutover" })),
    );
    const err = await apiPost("/api/agents/s/pause").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).message).toBe("pause arrives with cutover");
  });

  it("keeps the error body for callers that read more than the text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(502, { error: "Could not reach origin.", checkedAt: 1_000 })),
    );
    const err = (await apiPost("/api/version/check").catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(502);
    expect(err.body).toEqual({ error: "Could not reach origin.", checkedAt: 1_000 });
  });

  it("leaves the body unset for a reply that is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad gateway", { status: 502 })),
    );
    const err = (await apiPost("/api/version/check").catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(502);
    expect(err.body).toBeUndefined();
  });
});
