import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttentionMaterials } from "@mc/core";
import { expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { createAttentionMaterials } from "../src/attention-materials.ts";
import { ChangeBus } from "../src/bus.ts";
import { Store } from "../src/store.ts";

const input = {
  repoId: "sample",
  sourceCommit: "a".repeat(40),
  sourcePath: "docs/plan.md",
  label: "Plan",
};

function memoryStore() {
  const packets = new Map<string, AttentionMaterials>();
  return {
    attentionMaterials: (id: string) => packets.get(id) ?? null,
    attentionMaterialsForItem: (key: string) =>
      [...packets.values()].find((packet) => packet.itemKey === key) ?? null,
    putAttentionMaterials: (packet: AttentionMaterials) => {
      packets.set(packet.id, packet);
      return true;
    },
  };
}

it("retains a Markdown packet and rewrites its raster image links", async () => {
  const service = createAttentionMaterials({
    store: memoryStore(),
    config: { repos: [{ id: "sample" }] } as never,
    item: () => ({ repoId: "sample", brief: { id: 7 } }),
    git: async (_checkout, _commit, path) =>
      path.endsWith("README.md")
        ? Buffer.from(
            "# Plan\n\n![Before](./before.png)\n\n| Proposed |\n| --- |\n| [After](nested/after.png) |\n",
          )
        : Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    checkout: () => "/fixture",
    assetsDir: mkdtempSync(join(tmpdir(), "materials-")),
    now: () => 1000,
  });
  const saved = await service.register("tag:sample", {
    repoId: "sample",
    sourceCommit: "a".repeat(40),
    sourcePath: "docs/plan/README.md",
    label: "Layout proposal",
  });
  expect(saved.markdown).toContain("/api/attention-material-assets/");
  expect(saved.images).toHaveLength(2);
  expect(saved.images.map((image) => image.label)).toEqual(["Before", "After"]);
  await expect(
    service.register("tag:sample", { ...input, sourcePath: "docs/%2e%2e/secret.md" }),
  ).rejects.toMatchObject({ status: 400 });
  const escaping = createAttentionMaterials({
    store: memoryStore(),
    config: { repos: [{ id: "sample" }] } as never,
    item: () => ({ repoId: "sample" }),
    checkout: () => "/fixture",
    git: async (_checkout, _commit, path) =>
      path.endsWith(".md")
        ? Buffer.from("[Escape](../outside.png)")
        : Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    assetsDir: mkdtempSync(join(tmpdir(), "materials-escape-")),
  });
  await expect(escaping.register("tag:sample", input)).rejects.toMatchObject({ status: 400 });
  const forged = createAttentionMaterials({
    store: memoryStore(),
    config: { repos: [{ id: "sample" }] } as never,
    item: () => ({ repoId: "sample" }),
    checkout: () => "/fixture",
    git: async (_checkout, _commit, path) =>
      path.endsWith(".md") ? Buffer.from("![Forged](fake.png)") : Buffer.from("not an image"),
    assetsDir: mkdtempSync(join(tmpdir(), "materials-forged-")),
  });
  await expect(forged.register("tag:sample", input)).rejects.toMatchObject({ status: 400 });
});

it("keeps retained bytes after reopening storage and marks a rebriefed packet historical", async () => {
  const dir = mkdtempSync(join(tmpdir(), "materials-store-"));
  let brief = 1;
  const make = (store: Store) =>
    createAttentionMaterials({
      store,
      config: { repos: [{ id: "sample" }] } as never,
      item: () => ({ repoId: "sample", brief: { id: brief } }),
      checkout: () => "/fixture",
      git: async (_root, _commit, path) =>
        path.endsWith(".md")
          ? Buffer.from("[Shot](shot.png)")
          : Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      assetsDir: join(dir, "assets"),
      now: () => 10,
    });
  const store = new Store(join(dir, "mc.sqlite"));
  const saved = await make(store).register("tag:item", input);
  store.close();
  const reopened = new Store(join(dir, "mc.sqlite"));
  brief = 2;
  const read = make(reopened).read("tag:item");
  expect(read).toMatchObject({
    id: saved.id,
    historical: true,
    markdown: expect.stringContaining("/api/attention-material-assets/"),
  });
  expect(make(reopened).asset(saved.images[0]?.id ?? "")?.bytes).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});

it("requires the operator token for material API reads and writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "materials-api-"));
  const store = new Store(join(dir, "mc.sqlite"));
  const app = buildApp({
    store,
    bus: new ChangeBus(),
    operatorToken: "secret",
    config: {
      operator: { id: "operator", timezone: "UTC" },
      accounts: [],
      loops: [],
      poll: { usageMinutes: 5, githubSeconds: 60 },
      repos: [],
    } as never,
    attentionMaterials: {
      register: async () => ({
        id: "packet",
        itemKey: "x",
        repoId: "sample",
        sourceCommit: "a".repeat(40),
        sourcePath: "docs/plan.md",
        label: "Plan",
        registeredAt: 1,
        briefId: null,
        markdown: "plan",
        images: [],
        historical: false,
      }),
      read: () => null,
      asset: () => ({
        bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        mediaType: "image/png",
      }),
    },
  });
  expect(
    (await app.inject({ method: "POST", url: "/api/attention/x/materials", payload: input }))
      .statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/attention/x/materials",
        headers: { "x-mc-operator": "secret" },
        payload: input,
      })
    ).statusCode,
  ).toBe(201);
  const image = await app.inject({
    method: "GET",
    url: `/api/attention-material-assets/${"a".repeat(64)}`,
    headers: { "x-mc-operator": "secret" },
  });
  expect(image.headers["content-type"]).toContain("image/png");
  expect(image.rawPayload).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await app.close();
  const preview = buildApp({
    store,
    bus: new ChangeBus(),
    noLoopWrites: true,
    operatorToken: "secret",
    config: {
      operator: { id: "operator", timezone: "UTC" },
      accounts: [],
      loops: [],
      poll: { usageMinutes: 5, githubSeconds: 60 },
      repos: [],
    } as never,
    attentionMaterials: {
      register: async () => {
        throw Error("preview must not register");
      },
      read: () => null,
      asset: () => null,
    },
  });
  expect(
    (
      await preview.inject({
        method: "POST",
        url: "/api/attention/x/materials",
        headers: { "x-mc-operator": "secret" },
        payload: input,
      })
    ).statusCode,
  ).toBe(409);
  await preview.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it("imports the full retained layout packet from a self-contained Git fixture", async () => {
  const dir = mkdtempSync(join(tmpdir(), "materials-real-"));
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
  try {
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
      store: memoryStore(),
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
      packet.images.reduce(
        (total, image) => total + (service.asset(image.id)?.bytes.length ?? 0),
        0,
      ),
    ).toBe(2629557);
    for (const image of packet.images) {
      const original = expected.referencedImages.find((ref) => image.path.endsWith(`/${ref.path}`));
      expect(image.sha256).toBe(original?.sha256);
    }
    expect(createHash("sha256").update(packet.markdown).digest("hex")).toHaveLength(64);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
