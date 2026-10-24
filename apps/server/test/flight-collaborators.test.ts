import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { collaborator, trustedAuthor } from "../src/flight/collaborators.ts";
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
  expect(trustedAuthor(store, "o/r", "friend", 3_600_013)).toBe(false);
  store.close();
});
