import { describe, expect, it, vi } from "vitest";
import type { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { startCodexDiscovery } from "../src/runtime/codex-discovery.ts";
import type { Store } from "../src/store.ts";

const catalogs = vi.hoisted(() => ({
  machine: vi.fn(async () => {
    throw new Error("machine catalog unavailable");
  }),
  source: vi.fn(async () => {
    throw new Error("source catalog unavailable");
  }),
  destination: vi.fn(async () => {}),
}));

vi.mock("../src/runtime/codex-models.ts", () => ({
  codexModels: { load: catalogs.machine },
  codexModelsFor: (account: { cliProfile?: string }) => ({
    load: account.cliProfile === "/profiles/source" ? catalogs.source : catalogs.destination,
  }),
}));

describe("Codex discovery", () => {
  it("recovers a transferred run when only its destination profile catalog succeeds", async () => {
    const resumeRun = vi.fn(async () => {});
    const stop = startCodexDiscovery({
      config: {
        accounts: [
          {
            id: "source",
            vendor: "codex",
            cliProfile: "/profiles/source",
            alertAt: 70,
            stopAt: 80,
          },
          {
            id: "destination",
            vendor: "codex",
            cliProfile: "/profiles/destination",
            alertAt: 70,
            stopAt: 80,
          },
        ],
        crew: {
          sessions: [
            {
              id: "session",
              repoId: "repo",
              checkout: "/checkout",
              seats: [
                {
                  id: "seat",
                  role: "GUIDO",
                  accountId: "source",
                  model: "gpt-transferred",
                  area: [],
                },
              ],
            },
          ],
        },
      } as unknown as CcConfig,
      bus: { emit: vi.fn() } as unknown as ChangeBus,
      store: {
        liveSeatRuns: () => [{ seatId: "seat", run: { id: "run", vendor: "codex" } }],
      } as unknown as Store,
      supervisor: { resumeRun },
      retryMs: 60_000,
      log: vi.fn(),
    });
    try {
      await expect.poll(() => resumeRun.mock.calls).toEqual([["run"]]);
      expect(catalogs.source).toHaveBeenCalledOnce();
      expect(catalogs.destination).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  });
});
