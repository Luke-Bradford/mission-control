import { expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

it("held items leave attention and return with a release explanation; routes enforce guards", async () => {
  const store = new Store(":memory:");
  const config: CcConfig = {
    operator: { id: "operator", timezone: "UTC" },
    accounts: [],
    repos: [],
    loops: [],
    poll: { usageMinutes: 30, githubSeconds: 60 },
  };
  store.raiseNote({
    key: "blocked:demo",
    kind: "blocked",
    runId: null,
    seatId: null,
    repoId: null,
    text: "Choose",
    at: 1,
  });
  const app = buildApp({ config, store, bus: new ChangeBus(), operatorToken: "test-token" });
  try {
    const url = "/api/attention/note:blocked:demo/hold";
    const payload = { reason: "Waiting", condition: { kind: "manual" } };
    expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(401);
    const headers = { "x-mc-operator": "test-token" };
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          payload,
          headers: { ...headers, origin: "https://example.invalid" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          payload: JSON.stringify(payload),
          headers: { ...headers, "content-type": "text/plain" },
        })
      ).statusCode,
    ).toBe(415);
    expect(
      (await app.inject({ method: "POST", url, payload: { ...payload, reason: " " }, headers }))
        .statusCode,
    ).toBe(400);
    expect((await app.inject({ method: "POST", url, payload, headers })).statusCode).toBe(200);
    expect((await app.inject("/api/attention")).json()).toHaveLength(0);
    expect((await app.inject("/api/attention/held")).json()[0].hold.reason).toBe("Waiting");
    expect(
      (await app.inject({ method: "POST", url: `${url}/release`, headers, payload: {} }))
        .statusCode,
    ).toBe(200);
    expect((await app.inject("/api/attention")).json()[0].holdReleased).toBe("until I release it");
  } finally {
    await app.close();
    store.close();
  }
});
