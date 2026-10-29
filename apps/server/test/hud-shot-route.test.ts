import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATOR_HEADER } from "@mc/core";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { hudShotStore } from "../src/flight/hud-store.ts";
import { Store } from "../src/store.ts";

const config: CcConfig = {
  operator: { id: "operator", timezone: "UTC" },
  accounts: [],
  repos: [],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
};

function appWith(operatorToken?: string) {
  const hudShots = hudShotStore(join(mkdtempSync(join(tmpdir(), "hud-route-")), "shots"));
  const id = hudShots.save(Buffer.from("PNGDATA"));
  const app = buildApp({
    config,
    store: new Store(":memory:"),
    bus: new ChangeBus(),
    hudShots,
    ...(operatorToken === undefined ? {} : { operatorToken }),
  });
  return { app, id };
}

describe("GET /api/hud-screenshots/:id", () => {
  it("serves a stored screenshot to the operator, privately", async () => {
    const { app, id } = appWith("tok");
    const res = await app.inject({
      url: `/api/hud-screenshots/${id}`,
      headers: { [OPERATOR_HEADER]: "tok" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.body).toBe("PNGDATA");
  });

  it("refuses a caller without the operator token, even for a real id", async () => {
    const { app, id } = appWith("tok");
    expect((await app.inject({ url: `/api/hud-screenshots/${id}` })).statusCode).toBe(401);
    const wrong = await app.inject({
      url: `/api/hud-screenshots/${id}`,
      headers: { [OPERATOR_HEADER]: "nope" },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it("answers 404 for unknown, malformed and traversal ids", async () => {
    const { app } = appWith("tok");
    for (const id of ["0".repeat(32), "short", "..%2f..%2fetc%2fpasswd", "A".repeat(32)]) {
      const res = await app.inject({
        url: `/api/hud-screenshots/${id}`,
        headers: { [OPERATOR_HEADER]: "tok" },
      });
      expect(res.statusCode).toBe(404);
    }
  });
});
