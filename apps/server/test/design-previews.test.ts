import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DESIGN_PREVIEW_IDLE_MS,
  DESIGN_PREVIEW_MAX_FILES,
  DesignPreviews,
  PREVIEW_BOOT_SCRIPT,
  PreviewRefused,
} from "../src/design-previews.ts";

const PORT = 7440;
const HOST = `127.0.0.1:${PORT}`;
let dir: string;
let clock = 1_000_000;
let pr: { number: number; state: "open" | "closed" | "merged" } | null = null;

const newPreviews = () =>
  new DesignPreviews({
    root: join(dir, "store"),
    port: PORT,
    hubPort: 7420,
    prOf: () => pr,
    now: () => clock,
  });

/** A worktree whose apps/web/dist holds a tiny built app; `mark` tells builds apart. */
function worktree(name: string, mark: string, extra: (dist: string) => void = () => {}): string {
  const wt = join(dir, name);
  const dist = join(wt, "apps", "web", "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(
    join(dist, "index.html"),
    `<!doctype html><html><head><title>${mark}</title></head><body>${mark}</body></html>`,
  );
  writeFileSync(join(dist, "assets", "app-1.js"), "console.log(1)");
  extra(dist);
  return wt;
}

const input = (ticket: number, wt: string) => ({
  ticket,
  branch: `feature/${ticket}-x`,
  sha: "a".repeat(40),
  worktree: wt,
});
const get = (p: DesignPreviews, url: string, host = HOST) =>
  p.app().inject({ method: "GET", url, headers: { host } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-design-"));
  clock = 1_000_000;
  pr = null;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("DesignPreviews", () => {
  it("publish refuses what it must not serve", async () => {
    const p = newPreviews();
    const refused = async (wt: string) =>
      p.publish(input(1, wt)).then(
        () => null,
        (e: unknown) => (e instanceof PreviewRefused ? e.message : "other error"),
      );
    expect(
      await refused(worktree("sh", "a", (d) => writeFileSync(join(d, "run.sh"), "echo"))),
    ).toBe(
      "Not published: run.sh in the build is not a file type the preview serves. Remove it and publish again.",
    );
    expect(
      await refused(worktree("link", "b", (d) => symlinkSync("/etc/hosts", join(d, "hosts.html")))),
    ).toContain("hosts.html in the build");
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.js"), "x");
    expect(
      await refused(worktree("dirlink", "c", (d) => symlinkSync(outside, join(d, "more")))),
    ).toContain("more in the build");
    expect(
      await refused(worktree("odd", "d", (d) => writeFileSync(join(d, "a b.js"), "x"))),
    ).toContain("a b.js in the build");
    const noIndex = worktree("noindex", "e");
    rmSync(join(noIndex, "apps", "web", "dist", "index.html"));
    expect(await refused(noIndex)).toBe(
      "Not published: your worktree has no web build. Run pnpm -s build, then publish again.",
    );
    expect(await refused(join(dir, "nothing"))).toContain("has no web build");
    const many = worktree("many", "f", (d) => {
      for (let i = 0; i <= DESIGN_PREVIEW_MAX_FILES; i++) writeFileSync(join(d, `f${i}.js`), "x");
    });
    expect(await refused(many)).toBe("Not published: the build is over 64 MB or 2,000 files.");
    expect(p.list()).toEqual([]);
  });

  it("serves the stored build with the boot script in its head, and the CSP on every answer", async () => {
    const p = newPreviews();
    const view = await p.publish(input(1, worktree("w1", "one")));
    expect(view).toMatchObject({ ticket: 1, running: true, url: `http://127.0.0.1:${PORT}/` });
    const page = await get(p, "/");
    expect(page.body).toContain('<head><script src="/mc-preview-boot"></script>');
    expect(page.headers["content-security-policy"]).toContain(
      "frame-ancestors http://127.0.0.1:7420",
    );
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["cross-origin-opener-policy"]).toBe("same-origin");
    const boot = await get(p, "/mc-preview-boot");
    expect(boot.body).toBe(PREVIEW_BOOT_SCRIPT);
    expect(boot.headers["content-security-policy"]).toContain("default-src 'self'");
    expect((await get(p, "/assets/app-1.js")).body).toBe("console.log(1)");
  });

  it("answers the listener's refusals", async () => {
    const p = newPreviews();
    expect((await get(p, "/")).body).toBe("No preview is running. Open one from Needs you.");
    const api = await get(p, "/api/operator/bootstrap");
    expect(api.statusCode).toBe(404);
    expect(api.json()).toEqual({ error: "A preview has no hub. It shows Demo data only." });
    await p.publish(input(1, worktree("w1", "one")));
    expect((await get(p, "/api/crew")).statusCode).toBe(404);
    expect((await get(p, "/", "evil.example:7440")).statusCode).toBe(421);
    expect((await get(p, "/", "localhost:7440")).statusCode).toBe(200);
    const post = await p.app().inject({ method: "POST", url: "/", headers: { host: HOST } });
    expect(post.statusCode).toBe(405);
  });

  it("one preview runs at a time and a closed PR's preview is gone", async () => {
    const p = newPreviews();
    await p.publish(input(1, worktree("w1", "page-one")));
    await p.publish(input(2, worktree("w2", "page-two")));
    expect(p.list().map((v) => [v.ticket, v.running])).toEqual([
      [1, true],
      [2, false],
    ]);
    expect((await get(p, "/")).body).toContain("page-one");

    expect((await p.open(2))?.running).toBe(true);
    expect((await get(p, "/")).body).toContain("page-two");
    expect(
      p
        .list()
        .filter((v) => v.running)
        .map((v) => v.ticket),
    ).toEqual([2]);

    clock += 61 * 60_000;
    expect((await get(p, "/")).body).toBe("No preview is running. Open one from Needs you.");
    expect(p.list().every((v) => !v.running)).toBe(true);
    expect((await p.open(2))?.running).toBe(true);

    pr = { number: 9, state: "merged" };
    expect(await p.open(2)).toBeNull();
    expect(await get(p, "/")).toMatchObject({ statusCode: 404 });
    pr = { number: 9, state: "closed" };
    await p.sweep();
    expect(p.list()).toEqual([]);
    expect(existsSync(join(dir, "store", "1"))).toBe(false);
    expect(existsSync(join(dir, "store", "2"))).toBe(false);
  });

  it("keeps builds across a restart with nothing running, and drops the oldest past five", async () => {
    const p = newPreviews();
    for (let t = 1; t <= 6; t++) {
      clock += 1000;
      await p.publish(input(t, worktree(`w${t}`, `p${t}`)));
    }
    expect(
      p
        .list()
        .map((v) => v.ticket)
        .sort(),
    ).toEqual([1, 3, 4, 5, 6]);
    const again = newPreviews();
    expect(
      again
        .list()
        .map((v) => v.ticket)
        .sort(),
    ).toEqual([1, 3, 4, 5, 6]);
    expect(again.list().every((v) => !v.running)).toBe(true);
    expect((await again.open(3))?.running).toBe(true);
    expect((await get(again, "/")).body).toContain("p3");
    clock += 8 * 24 * 3_600_000;
    await again.sweep();
    expect(again.list()).toEqual([]);
    expect(DESIGN_PREVIEW_IDLE_MS).toBe(3_600_000);
  });

  it("a republish replaces that ticket's build", async () => {
    const p = newPreviews();
    await p.publish(input(1, worktree("w1", "old")));
    await p.publish({ ...input(1, worktree("w1b", "new")), sha: "b".repeat(40) });
    expect(p.list()).toHaveLength(1);
    expect(p.list()[0]?.sha).toBe("b".repeat(40));
    expect((await get(p, "/")).body).toContain("new");
  });
});
