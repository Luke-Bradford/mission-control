import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiGet, apiPost, errorNote } from "../src/api.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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
