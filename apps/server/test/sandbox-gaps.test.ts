import { describe, expect, it } from "vitest";
import { capabilityBlocked, inSeatSandbox } from "./sandbox-gaps.ts";

const SEAT = { SANDBOX_RUNTIME: "1" } as NodeJS.ProcessEnv;
const failing = async () => false;
const working = async () => true;

describe("sandbox gaps (#1411)", () => {
  it("skips only inside a seat's sandbox whose probe fails", async () => {
    expect(await capabilityBlocked("install", { env: SEAT, probe: failing })).toBe(true);
  });

  it("never skips outside a seat's sandbox, whatever the probe says (CI runs every test)", async () => {
    let probed = false;
    const probe = async () => {
      probed = true;
      return false;
    };
    expect(await capabilityBlocked("listen", { env: {}, probe })).toBe(false);
    expect(probed).toBe(false);
  });

  it("does not skip when the sandbox allows the capability, so a real failure still fails", async () => {
    expect(await capabilityBlocked("seatbelt", { env: SEAT, probe: working })).toBe(false);
  });

  it("reads the sandbox marker exactly", () => {
    expect(inSeatSandbox({ SANDBOX_RUNTIME: "1" })).toBe(true);
    expect(inSeatSandbox({ SANDBOX_RUNTIME: "0" })).toBe(false);
    expect(inSeatSandbox({})).toBe(false);
  });
});
