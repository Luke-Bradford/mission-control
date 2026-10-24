import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { collaborator, refreshAuthors, trustedAuthor } from "../src/flight/collaborators.ts";
import { Store } from "../src/store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
it("marks strangers and missing authors untrusted and caches collaborator permissions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-trust-"));
  dirs.push(dir);
  const store = new Store(join(dir, "db"));
  const gh = vi.fn(async () => ({ code: 0, stdout: '{"permission":"none"}', stderr: "" }));
  expect(await collaborator(store, gh, dir, "o/r", "stranger", 10)).toBe(false);
  expect(await collaborator(store, gh, dir, "o/r", "stranger", 11)).toBe(false);
  expect(gh).toHaveBeenCalledTimes(1);
  expect(trustedAuthor(store, "o/r", null, 12)).toBe(false);
  gh.mockResolvedValue({ code: 0, stdout: '{"permission":"write"}', stderr: "" });
  expect(await collaborator(store, gh, dir, "o/r", "friend", 12)).toBe(true);
  expect(trustedAuthor(store, "o/r", "friend", 13)).toBe(true);
  expect(trustedAuthor(store, "o/r", "friend", 86_400_013)).toBe(false);
  store.close();
});

it.each(["read", "triage", "write", "maintain", "admin"])(
  "caches %s permission for 24h and prunes after 7 days",
  async (permission) => {
    const dir = mkdtempSync(join(tmpdir(), "mc-trust-"));
    dirs.push(dir);
    const store = new Store(join(dir, "db"));
    const gh = vi.fn(async () => ({ code: 0, stdout: JSON.stringify({ permission }), stderr: "" }));
    const trusted = ["write", "maintain", "admin"].includes(permission);
    expect(await collaborator(store, gh, dir, "o/r", "author", 0)).toBe(trusted);
    expect(await collaborator(store, gh, dir, "o/r", "author", 23 * 3600_000)).toBe(trusted);
    expect(gh).toHaveBeenCalledTimes(1);
    await collaborator(store, gh, dir, "o/r", "author", 24 * 3600_000);
    expect(gh).toHaveBeenCalledTimes(2);
    await refreshAuthors(store, gh, dir, "r", "o/r", 9 * 24 * 3600_000);
    expect(store.getSetting("collaborator:o/r:author")).toBeNull();
    store.close();
  },
);
