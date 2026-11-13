import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ATTENTION_MATERIAL_RETENTION_DAYS, type AttentionStoryRegistration } from "@mc/core";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { createAttentionMaterials } from "../src/attention-materials.ts";
import { ChangeBus } from "../src/bus.ts";
import { Store } from "../src/store.ts";

const DAY = 86_400_000;
const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const png = (tag: string, extra = 0) => Buffer.concat([SIG, Buffer.from(tag), Buffer.alloc(extra)]);
const CONFIG = {
  operator: { id: "operator", timezone: "UTC" },
  accounts: [],
  loops: [],
  poll: { usageMinutes: 5, githubSeconds: 60 },
  repos: [{ id: "sample" }],
} as never;

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {
      // closed by the test already
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Files = Record<string, Buffer | string | { link: string }>;
/** A real Git repository with the files committed; returns where it is and the commit. */
function repo(files: Files) {
  const dir = mkdtempSync(join(tmpdir(), "materials-"));
  dirs.push(dir);
  const checkout = join(dir, "repo");
  mkdirSync(checkout);
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-C",
        checkout,
        ...args,
      ],
      { encoding: "utf8" },
    ).trim();
  git("init", "--quiet");
  for (const [path, body] of Object.entries(files)) {
    const file = join(checkout, path);
    mkdirSync(dirname(file), { recursive: true });
    if (typeof body === "object" && "link" in body) symlinkSync(body.link, file);
    else writeFileSync(file, body);
  }
  git("add", "-A");
  git("commit", "-qm", "fixture");
  return { dir, checkout, git, commit: git("rev-parse", "HEAD") };
}

type TestItem = {
  repoId: string | null;
  brief?: {
    id?: number;
    options?: { id?: string }[];
    binding?: { sourceRevision?: string };
    state?: { freshness?: string };
  };
} | null;
const OPEN: TestItem = {
  repoId: "sample",
  brief: {
    id: 7,
    options: [{ id: "a" }, { id: "b" }],
    binding: { sourceRevision: "rev-1" },
    state: { freshness: "current" },
  },
};

/** The real service over a real Store and real Git blobs. */
function harness(files: Files) {
  const r = repo(files);
  const state = { item: OPEN as TestItem, at: 1000 };
  const dbPath = join(r.dir, "mc.sqlite");
  const make = () => {
    const store = new Store(dbPath);
    stores.push(store);
    const service = createAttentionMaterials({
      store,
      config: CONFIG,
      item: (key) => (key === "k1" || key === "k2" ? state.item : null),
      checkout: () => r.checkout,
      assetsDir: join(r.dir, "assets"),
      now: () => state.at,
    });
    return { store, service };
  };
  return { ...r, state, make, assets: join(r.dir, "assets") };
}

const PLAN =
  "# Plan\n\n![Before](before.png)\n\n| Proposed |\n| --- |\n| ![After](nested/after.png) |\n";
const PACKET: Files = {
  "docs/p/README.md": PLAN,
  "docs/p/before.png": png("before"),
  "docs/p/nested/after.png": png("after"),
};
const REG = (commit: string) => ({
  repoId: "sample",
  sourceCommit: commit,
  sourcePath: "docs/p/README.md",
  label: "Layout",
});
const AUTH = { "x-mc-operator": "secret" };
const app = (
  store: Store,
  service: ReturnType<typeof createAttentionMaterials>,
  extra: object = {},
) =>
  buildApp({
    store,
    bus: new ChangeBus(),
    operatorToken: "secret",
    config: CONFIG,
    attentionMaterials: service,
    ...extra,
  });

describe("a retained plan", () => {
  it("retains the plan and exact bytes over HTTP, after the checkout changes and a reopen", async () => {
    const h = harness(PACKET);
    const first = h.make();
    const server = app(first.store, first.service);
    const posted = await server.inject({
      method: "POST",
      url: "/api/attention/k1/materials",
      headers: AUTH,
      payload: REG(h.commit),
    });
    expect(posted.statusCode).toBe(201);
    await server.close();
    first.store.close();
    // the working tree and branch move on: the files go, and the checkout leaves the commit's branch
    h.git("rm", "-rq", "docs");
    h.git("commit", "-qm", "remove");
    h.git("checkout", "-q", "--orphan", "other");
    expect(existsSync(join(h.checkout, "docs/p/before.png"))).toBe(false);
    const second = h.make();
    const reopened = app(second.store, second.service);
    const got = await reopened.inject({
      method: "GET",
      url: "/api/attention/k1/materials",
      headers: AUTH,
    });
    expect(got.statusCode).toBe(200);
    const packet = got.json();
    const linked = packet.images.map((i: { url: string }) => i.url);
    expect(packet.markdown).toBe(
      PLAN.replace("before.png", linked[0]).replace("nested/after.png", linked[1]),
    );
    expect(packet.sourceCommit).toBe(h.commit);
    expect(packet.historical).toBe(false);
    for (const image of packet.images) {
      const bytes = await reopened.inject({ method: "GET", url: image.url, headers: AUTH });
      expect(bytes.statusCode).toBe(200);
      expect(bytes.headers["content-type"]).toContain("image/png");
      expect(bytes.rawPayload).toEqual(
        execFileSync("git", ["-C", h.checkout, "cat-file", "blob", `${h.commit}:${image.path}`]),
      );
    }
    await reopened.close();
  });

  it("refuses every unauthenticated read and write", async () => {
    const h = harness(PACKET);
    const { store, service } = h.make();
    const server = app(store, service);
    const saved = await service.register("k1", REG(h.commit));
    for (const [method, url] of [
      ["GET", "/api/attention/k1/materials"],
      ["GET", `/api/attention-material-assets/${saved.images[0]?.id}`],
      ["POST", "/api/attention/k1/materials"],
    ] as const) {
      const res = await server.inject({
        method,
        url,
        payload: method === "POST" ? REG(h.commit) : undefined,
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    await server.close();
  });

  it("answers 409 to a preview that must not write", async () => {
    const h = harness(PACKET);
    const { store, service } = h.make();
    const server = app(store, service, { noLoopWrites: true });
    const res = await server.inject({
      method: "POST",
      url: "/api/attention/k1/materials",
      headers: AUTH,
      payload: REG(h.commit),
    });
    expect(res.statusCode).toBe(409);
    await server.close();
  });

  it("registers twice as one packet and one set of image files", async () => {
    const h = harness(PACKET);
    const { store, service } = h.make();
    const a = await service.register("k1", REG(h.commit));
    const b = await service.register("k1", REG(h.commit));
    expect(b.id).toBe(a.id);
    expect(store.attentionMaterialsAllForItem("k1")).toHaveLength(1);
    expect(readdirSync(h.assets)).toHaveLength(2);
  });

  it("keeps items apart", async () => {
    const h = harness(PACKET);
    const { service } = h.make();
    await service.register("k1", REG(h.commit));
    expect(service.read("k2")).toBeNull();
    const other = await service.register("k2", { ...REG(h.commit), label: "Other" });
    expect(service.read("k1")?.label).toBe("Layout");
    expect(service.read("k2")?.id).toBe(other.id);
  });

  it("changes no brief, hold or decision when it registers or reads", async () => {
    const h = harness(PACKET);
    const { store, service } = h.make();
    const snapshot = () =>
      JSON.stringify([[...store.briefs().entries()], store.flightDecisions(0, 50)]);
    const before = snapshot();
    await service.register("k1", REG(h.commit));
    service.read("k1");
    expect(snapshot()).toBe(before);
  });

  it("returns a long plan whole", async () => {
    const files: Files = {};
    for (let n = 0; n < 64; n++) files[`docs/p/img${n}.png`] = png(`i${n}`);
    files["docs/p/README.md"] =
      `${Array.from({ length: 64 }, (_, n) => `![i${n}](img${n}.png)`).join("\n")}\n${"plan text\n".repeat(20000)}`;
    const big = harness(files);
    const { service } = big.make();
    const packet = await service.register("k1", REG(big.commit));
    expect(packet.images).toHaveLength(64);
    expect(packet.markdown.split("plan text\n").length - 1).toBe(20000);
  });

  it("flags the packet when the item or brief changes, with the reason", async () => {
    const h = harness(PACKET);
    const { service } = h.make();
    await service.register("k1", REG(h.commit));
    const read = () => service.read("k1");
    expect(read()).toMatchObject({ historical: false, historicalReason: null });
    h.state.item = { ...OPEN, brief: { ...OPEN?.brief, binding: { sourceRevision: "rev-2" } } };
    expect(read()).toMatchObject({ historical: true, historicalReason: "source changed" });
    h.state.item = { ...OPEN, brief: { ...OPEN?.brief, state: { freshness: "stale" } } };
    expect(read()).toMatchObject({ historical: true, historicalReason: "source changed" });
    h.state.item = { ...OPEN, brief: { ...OPEN?.brief, id: 8 } };
    expect(read()).toMatchObject({ historical: true, historicalReason: "rebriefed" });
    h.state.item = { ...OPEN, repoId: "else" };
    expect(read()).toMatchObject({ historical: true, historicalReason: "repository changed" });
    h.state.item = null;
    expect(read()).toMatchObject({ historical: true, historicalReason: "question closed" });
    // the plan stays readable throughout
    expect(read()?.markdown).toContain("/api/attention-material-assets/");
  });

  it("makes embeds that are not retained images plain links or text", async () => {
    const hostile = harness({
      "docs/p/README.md": [
        "![track](https://evil.example/pixel)",
        "![svg](diagram.svg)",
        "![q](shot.png?raw=1)",
        "![ref][r]",
        "![js](javascript:alert(1))",
        "![w](<shot.png>)",
        '<img src="https://evil.example/b.png"> and <script>x</script>',
        "[r]: https://evil.example/a.png",
      ].join("\n"),
      "docs/p/shot.png": png("shot"),
    });
    const { service } = hostile.make();
    const packet = await service.register("k1", REG(hostile.commit));
    const embeds = [...packet.markdown.matchAll(/!\[[^\]]*\]\(([^)]*)\)/g)].map((m) => m[1]);
    expect(embeds.length).toBeGreaterThan(0);
    expect(embeds.every((url) => url?.startsWith("/api/attention-material-assets/"))).toBe(true);
    expect(packet.markdown).not.toMatch(/!\[[^\]]*\]\[/);
    expect(packet.markdown).not.toContain("<img");
    expect(packet.markdown).not.toContain("<script");
    expect(packet.markdown).toContain("[track](https://evil.example/pixel)");
    expect(packet.markdown).toContain("[svg](diagram.svg)");
    expect(packet.markdown).not.toContain("javascript:");
    expect(packet.images).toHaveLength(1);
  });
});

describe("a held question", () => {
  it("keeps its materials, and still takes new ones, through the API's own wiring", async () => {
    const h = repo(PACKET);
    const store = new Store(join(h.dir, "mc.sqlite"));
    stores.push(store);
    store.raiseNote({
      key: "blocked:demo",
      kind: "blocked",
      runId: null,
      seatId: null,
      repoId: "sample",
      text: "Choose",
      at: 1,
    });
    let at = Date.now();
    const config = {
      ...(CONFIG as object),
      crew: {
        worktrees: join(h.dir, "wt"),
        maxSeats: 1,
        sessions: [{ id: "s1", repoId: "sample", checkout: h.checkout, seats: [] }],
      },
    } as never;
    const server = buildApp({
      store,
      bus: new ChangeBus(),
      config,
      operatorToken: "secret",
      now: () => at,
    });
    const key = "note:blocked:demo";
    const post = () =>
      server.inject({
        method: "POST",
        url: `/api/attention/${key}/materials`,
        headers: AUTH,
        payload: REG(h.commit),
      });
    const get = () =>
      server.inject({ method: "GET", url: `/api/attention/${key}/materials`, headers: AUTH });
    expect((await post()).statusCode).toBe(201);
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/api/attention/${key}/hold`,
          headers: AUTH,
          payload: { reason: "Waiting", condition: { kind: "manual" } },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await server.inject({ method: "GET", url: "/api/attention/held" })).json(),
    ).toHaveLength(1);
    expect((await get()).json()).toMatchObject({ historical: false, closedAt: null });
    at += (ATTENTION_MATERIAL_RETENTION_DAYS + 1) * DAY;
    const later = (await get()).json();
    expect(later).toMatchObject({ historical: false, closedAt: null, imagesRemovedAt: null });
    expect(readdirSync(join(h.dir, "attention-material-assets"))).toHaveLength(2);
    expect((await post()).statusCode).toBe(201);
    await server.close();
  });
});

describe("refusals", () => {
  const big = (n: number) => Buffer.alloc(n, "x");
  const links = (n: number) => Array.from({ length: n }, (_, i) => `![i](i${i}.png)`).join("\n");
  const pngs = (n: number, extra = 0): Files =>
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`docs/p/i${i}.png`, png(`i${i}`, extra)]),
    );
  const cases: [string, Files, Partial<ReturnType<typeof REG>>, number, RegExp][] = [
    [
      "a symlinked image",
      { "docs/p/README.md": "![x](x.png)", "docs/p/x.png": { link: "../../secret" } },
      {},
      400,
      /regular committed file/,
    ],
    [
      "a symlinked plan",
      { "docs/p/README.md": { link: "../real.md" }, "docs/real.md": "x" },
      {},
      400,
      /regular committed file/,
    ],
    ["a missing plan", { "docs/other.md": "x" }, {}, 404, /not found/],
    ["a missing image", { "docs/p/README.md": "![x](gone.png)" }, {}, 404, /not found/],
    ["a short commit", PACKET, { sourceCommit: "abc1234" }, 400, /40-character/],
    ["an unconfigured repository", PACKET, { repoId: "nope" }, 404, /not configured/],
    ["a path outside docs", PACKET, { sourcePath: "README.md" }, 400, /under docs/],
    ["a traversal path", PACKET, { sourcePath: "docs/../secret.md" }, 400, /under docs/],
    [
      "an encoded traversal path",
      PACKET,
      { sourcePath: "docs/%2e%2e/secret.md" },
      400,
      /under docs/,
    ],
    [
      "an image climbing out",
      { "docs/p/README.md": "![x](../out.png)" },
      {},
      400,
      /within the packet/,
    ],
    [
      "an encoded climb",
      { "docs/p/README.md": "![x](%2e%2e/out.png)" },
      {},
      400,
      /within the packet/,
    ],
    [
      "a forged type",
      { "docs/p/README.md": "![x](x.png)", "docs/p/x.png": "not a png" },
      {},
      400,
      /PNG, JPEG or WebP/,
    ],
    [
      "an image over 2 MB",
      {
        "docs/p/README.md": "![x](x.png)",
        "docs/p/x.png": Buffer.concat([SIG, big(2 * 1024 * 1024)]),
      },
      {},
      400,
      /over 2 MB/,
    ],
    [
      "a 4 MB image",
      {
        "docs/p/README.md": "![x](x.png)",
        "docs/p/x.png": Buffer.concat([SIG, big(4 * 1024 * 1024)]),
      },
      {},
      400,
      /over 2 MB/,
    ],
    ["a plan over 1 MB", { "docs/p/README.md": big(1024 * 1024 + 1) }, {}, 400, /over 1 MB/],
    ["65 images", { "docs/p/README.md": links(65), ...pngs(65) }, {}, 400, /Too many images/],
    [
      "images past the question cap",
      { "docs/p/README.md": links(14), ...pngs(14, 1_900_000) },
      {},
      400,
      /cap/,
    ],
  ];
  for (const [name, files, over, status, message] of cases) {
    it(`refuses ${name}`, async () => {
      const h = harness(files);
      const { service } = h.make();
      await expect(service.register("k1", { ...REG(h.commit), ...over })).rejects.toMatchObject({
        status,
        message: expect.stringMatching(message),
      });
      expect(existsSync(h.assets) ? readdirSync(h.assets) : []).toEqual([]);
    });
  }

  it("refuses an item of another repository, and one that does not exist", async () => {
    const h = harness(PACKET);
    const { service } = h.make();
    h.state.item = { ...OPEN, repoId: "else" };
    await expect(service.register("k1", REG(h.commit))).rejects.toMatchObject({ status: 404 });
    await expect(service.register("nothing", REG(h.commit))).rejects.toMatchObject({
      status: 404,
    });
  });

  it("never fetches an external image", async () => {
    const h = harness({ "docs/p/README.md": "![x](https://evil.example/x.png)" });
    const { service } = h.make();
    const packet = await service.register("k1", REG(h.commit));
    expect(packet.images).toEqual([]);
    expect(packet.markdown).toBe("[x](https://evil.example/x.png)");
  });
});

describe("a story in pictures", () => {
  const files: Files = {
    "docs/s/page.png": png("page"),
    "docs/s/before.png": png("before"),
    "docs/s/after.png": png("after"),
    "docs/s/a.png": png("optionA"),
    "docs/s/b.png": png("optionB"),
    "docs/s/notes.md": "text",
  };
  const story = (sourceCommit: string): AttentionStoryRegistration => ({
    repoId: "sample",
    sourceCommit,
    label: "Comms layout",
    sections: [
      {
        heading: "This page",
        text: "Today's Comms.",
        images: [{ path: "docs/s/page.png", caption: "Comms now" }],
        children: [
          {
            heading: "This part changes",
            images: [
              { path: "docs/s/before.png", caption: "Before" },
              { path: "docs/s/after.png", caption: "After" },
            ],
            comparison: "before-after",
            children: [{ heading: "It looks different here too", text: "The header shrinks." }],
          },
        ],
      },
      {
        heading: "Which do you prefer?",
        images: [
          { path: "docs/s/a.png", caption: "A" },
          { path: "docs/s/b.png", caption: "B" },
        ],
        comparison: "options",
      },
    ],
    optionImages: [
      { optionId: "a", imagePaths: ["docs/s/a.png"] },
      { optionId: "b", imagePaths: ["docs/s/b.png"] },
    ],
  });
  const first = <T>(list: T[] | null | undefined, at = 0) => list?.[at];

  it("keeps nested sections, comparisons and picture options in order", async () => {
    const h = harness(files);
    const { service } = h.make();
    const saved = await service.attachStory("k1", story(h.commit));
    const read = service.read("k1");
    expect(read?.id).toBe(saved.id);
    expect(read?.sourcePath).toBeNull();
    const top = first(read?.story);
    expect(top?.heading).toBe("This page");
    const child = first(top?.children);
    expect(child).toMatchObject({ heading: "This part changes", comparison: "before-after" });
    expect(child?.images.map((i) => i.caption)).toEqual(["Before", "After"]);
    expect(first(child?.children)?.heading).toBe("It looks different here too");
    expect(first(read?.story, 1)).toMatchObject({ comparison: "options" });
    const byId = new Map(read?.images.map((i) => [i.id, i]));
    expect(
      read?.optionImages.map((o) => [o.optionId, byId.get(o.imageIds[0] ?? "")?.path]),
    ).toEqual([
      ["a", "docs/s/a.png"],
      ["b", "docs/s/b.png"],
    ]);
    expect(read?.images.map((i) => i.label)).toEqual(["Comms now", "Before", "After", "A", "B"]);
    for (const image of read?.images ?? [])
      expect(service.asset(image.id)?.mediaType).toBe("image/png");
  });

  it("does not multiply a story registered twice", async () => {
    const h = harness(files);
    const { store, service } = h.make();
    await service.attachStory("k1", story(h.commit));
    await service.attachStory("k1", story(h.commit));
    expect(store.attentionMaterialsAllForItem("k1")).toHaveLength(1);
    expect(readdirSync(h.assets)).toHaveLength(5);
  });

  const refused: [string, (s: AttentionStoryRegistration) => void, number, RegExp][] = [
    [
      "a path outside the repo",
      (s) => set(s, "../../etc/passwd.png"),
      400,
      /inside the repository/,
    ],
    ["an absolute path", (s) => set(s, "/etc/x.png"), 400, /inside the repository/],
    ["a non-image file", (s) => set(s, "docs/s/notes.md"), 400, /PNG, JPEG or WebP/],
    ["an SVG", (s) => set(s, "docs/s/x.svg"), 400, /PNG, JPEG or WebP/],
    ["a comparison of one image", (s) => void s.sections[1]?.images?.pop(), 400, /two or more/],
    [
      "an option that is not the brief's",
      (s) => {
        if (s.optionImages?.[0]) s.optionImages[0].optionId = "zzz";
      },
      400,
      /not an option/,
    ],
    ["a missing image", (s) => set(s, "docs/s/gone.png"), 404, /not found/],
  ];
  function set(s: AttentionStoryRegistration, path: string) {
    const image = s.sections[0]?.images?.[0];
    if (image) image.path = path;
  }
  for (const [name, mutate, status, message] of refused) {
    it(`refuses ${name} with a plain message`, async () => {
      const h = harness(files);
      const { service } = h.make();
      const s = story(h.commit);
      mutate(s);
      await expect(service.attachStory("k1", s)).rejects.toMatchObject({
        status,
        message: expect.stringMatching(message),
      });
    });
  }

  it("refuses an image over the size cap and a forged image", async () => {
    const h = harness({
      ...files,
      "docs/s/big.png": Buffer.concat([SIG, Buffer.alloc(2 * 1024 * 1024)]),
      "docs/s/fake.png": "text pretending",
    });
    const { service } = h.make();
    const s = story(h.commit);
    set(s, "docs/s/big.png");
    await expect(service.attachStory("k1", s)).rejects.toMatchObject({ status: 400 });
    set(s, "docs/s/fake.png");
    await expect(service.attachStory("k1", s)).rejects.toMatchObject({ status: 400 });
  });

  it("counts every packet of a question toward its cap", async () => {
    const many: Files = {};
    for (let n = 0; n < 14; n++) many[`docs/s/i${n}.png`] = png(`i${n}`, 1_900_000);
    const h = harness(many);
    const { service } = h.make();
    const pack = (from: number, to: number, label: string): AttentionStoryRegistration => ({
      repoId: "sample",
      sourceCommit: h.commit,
      label,
      sections: [
        {
          heading: label,
          images: Array.from({ length: to - from }, (_, n) => ({
            path: `docs/s/i${from + n}.png`,
            caption: "c",
          })),
        },
      ],
    });
    await service.attachStory("k1", pack(0, 7, "first"));
    await service.attachStory("k1", pack(7, 13, "second"));
    await expect(service.attachStory("k1", pack(13, 14, "third"))).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/cap/),
    });
  });
});

describe("retention", () => {
  it("deletes the images of a question closed past the window, and says so", async () => {
    const h = harness(PACKET);
    const { service } = h.make();
    const saved = await service.register("k1", REG(h.commit));
    const id = saved.images[0]?.id ?? "";
    expect(service.asset(id)).not.toBeNull();
    h.state.item = null;
    h.state.at = 5000;
    expect(service.read("k1")).toMatchObject({ closedAt: 5000, imagesRemovedAt: null });
    h.state.at = 5000 + (ATTENTION_MATERIAL_RETENTION_DAYS - 1) * DAY;
    service.sweep();
    expect(service.asset(id)).not.toBeNull();
    h.state.at = 5000 + ATTENTION_MATERIAL_RETENTION_DAYS * DAY;
    const read = service.read("k1");
    expect(read?.imagesRemovedAt).toBe(h.state.at);
    expect(read?.markdown).toContain("/api/attention-material-assets/");
    expect(service.asset(id)).toBeNull();
    expect(readdirSync(h.assets)).toEqual([]);
  });

  it("keeps an image that a question still open holds", async () => {
    const h = harness(PACKET);
    const { service } = h.make();
    await service.register("k1", REG(h.commit));
    await service.register("k2", REG(h.commit));
    // k1 closes while k2 stays open and holds the same two images
    let k1Open = true;
    const stored = h.make();
    const both = createAttentionMaterials({
      store: stored.store,
      config: CONFIG,
      item: (key) => (key === "k1" ? (k1Open ? OPEN : null) : key === "k2" ? OPEN : null),
      checkout: () => h.checkout,
      assetsDir: h.assets,
      now: () => h.state.at,
    });
    k1Open = false;
    h.state.at = 10;
    both.sweep();
    h.state.at = 10 + ATTENTION_MATERIAL_RETENTION_DAYS * DAY;
    both.sweep();
    expect(readdirSync(h.assets)).toHaveLength(2);
    expect(both.read("k1")?.imagesRemovedAt).toBe(h.state.at);
    expect(both.read("k2")?.imagesRemovedAt).toBeNull();
  });
});

it("imports the full retained layout packet from a self-contained Git fixture", async () => {
  const dir = mkdtempSync(join(tmpdir(), "materials-real-"));
  dirs.push(dir);
  const store = new Store(join(dir, "mc.sqlite"));
  stores.push(store);
  const checkout = join(dir, "repo");
  const sourcePath = "docs/reviews/2026-11-10/comms-1513-proposal/README.md";
  const sourceDir = join(checkout, "docs/reviews/2026-11-10/comms-1513-proposal");
  mkdirSync(sourceDir, { recursive: true });
  cpSync(new URL("./fixtures/attention-materials-proposal/", import.meta.url), sourceDir, {
    recursive: true,
  });
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", checkout, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-11-10T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-11-10T00:00:00Z",
      },
    }).trim();
  git("init", "--quiet");
  git("add", "docs");
  git(
    "-c",
    "user.name=Materials fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "Retained layout fixture",
  );
  const sourceCommit = git("rev-parse", "HEAD");
  const expected: {
    markdownSha256: string;
    referencedImages: { path: string; sha256: string }[];
  } = JSON.parse(readFileSync(join(sourceDir, "provenance.json"), "utf8"));
  expect(
    createHash("sha256")
      .update(readFileSync(join(checkout, sourcePath)))
      .digest("hex"),
  ).toBe(expected.markdownSha256);
  const service = createAttentionMaterials({
    store,
    config: { repos: [{ id: "mission-control" }] } as never,
    item: () => ({ repoId: "mission-control", brief: { id: 9 } }),
    checkout: () => checkout,
    assetsDir: join(dir, "assets"),
  });
  const packet = await service.register("tag:flight-1:comms:2984", {
    repoId: "mission-control",
    sourceCommit,
    sourcePath,
    label: "Comms layout proposal",
  });
  expect(packet.sourceCommit).toBe(sourceCommit);
  expect(packet.images).toHaveLength(17);
  expect(packet.images.slice(0, 2).map((image) => image.label)).toEqual(["Before", "Proposal"]);
  expect(
    packet.images.reduce((total, image) => total + (service.asset(image.id)?.bytes.length ?? 0), 0),
  ).toBe(2629557);
  for (const image of packet.images) {
    const original = expected.referencedImages.find((ref) => image.path.endsWith(`/${ref.path}`));
    expect(image.sha256).toBe(original?.sha256);
  }
});
