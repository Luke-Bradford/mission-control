import { mkdtempSync, readdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HUD_SHOT_ID, hudShotStore } from "../src/flight/hud-store.ts";

const tmp = (): string => join(mkdtempSync(join(tmpdir(), "hud-shots-")), "shots");

describe("the HUD screenshot store", () => {
  it("stores under an opaque id in a private directory and reads it back", () => {
    const dir = tmp();
    const store = hudShotStore(dir);
    const id = store.save(Buffer.from("png-bytes"));
    expect(id).toMatch(HUD_SHOT_ID);
    expect(store.save(Buffer.from("x"))).not.toBe(id);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, `${id}.png`)).mode & 0o777).toBe(0o600);
    expect(store.read(id)?.toString()).toBe("png-bytes");
  });

  it("never turns a non-opaque id into a path", () => {
    const store = hudShotStore(tmp());
    store.save(Buffer.from("x"));
    for (const id of [
      "../x",
      "..%2f",
      "a".repeat(32).toUpperCase(),
      "",
      "0".repeat(31),
      "0".repeat(32),
    ])
      expect(store.read(id)).toBeNull();
  });

  it("keeps only the newest files", () => {
    const dir = tmp();
    const store = hudShotStore(dir, { keep: 2 });
    const first = store.save(Buffer.from("1"));
    utimesSync(join(dir, `${first}.png`), new Date(Date.now() - 5000), new Date(Date.now() - 5000));
    store.save(Buffer.from("2"));
    store.save(Buffer.from("3"));
    expect(readdirSync(dir)).toHaveLength(2);
    expect(store.read(first)).toBeNull();
  });

  it("expires by age, on read and on the next save", () => {
    const dir = tmp();
    const store = hudShotStore(dir, { maxAgeMs: 1000 });
    const id = store.save(Buffer.from("old"));
    const past = new Date(Date.now() - 5000);
    utimesSync(join(dir, `${id}.png`), past, past);
    expect(store.read(id)).toBeNull();
    store.save(Buffer.from("new"));
    expect(readdirSync(dir)).toHaveLength(1);
  });
});
