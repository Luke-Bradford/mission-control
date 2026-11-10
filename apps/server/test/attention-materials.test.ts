import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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
            "# Plan\n\n![Before](before.png)\n\n| Proposed |\n| --- |\n| [After](after.png) |\n",
          )
        : Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    checkout: () => "/fixture",
    assetsDir: mkdtempSync(join(process.cwd(), ".mc-tmp/materials-")),
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
  const forged = createAttentionMaterials({
    store: memoryStore(),
    config: { repos: [{ id: "sample" }] } as never,
    item: () => ({ repoId: "sample" }),
    checkout: () => "/fixture",
    git: async (_checkout, _commit, path) =>
      path.endsWith(".md") ? Buffer.from("![Forged](fake.png)") : Buffer.from("not an image"),
    assetsDir: mkdtempSync(join(process.cwd(), ".mc-tmp/materials-forged-")),
  });
  await expect(forged.register("tag:sample", input)).rejects.toMatchObject({ status: 400 });
});

it("keeps retained bytes after reopening storage and marks a rebriefed packet historical", async () => {
  const dir = mkdtempSync(join(process.cwd(), ".mc-tmp/materials-store-"));
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
  const dir = mkdtempSync(join(process.cwd(), ".mc-tmp/materials-api-"));
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

it("imports the full committed layout packet with its seventeen linked PNGs", async () => {
  const service = createAttentionMaterials({
    store: memoryStore(),
    config: { repos: [{ id: "mission-control" }] } as never,
    item: () => ({ repoId: "mission-control", brief: { id: 9 } }),
    checkout: () => process.cwd(),
    assetsDir: mkdtempSync(join(process.cwd(), ".mc-tmp/materials-real-")),
  });
  const packet = await service.register("tag:flight-1:comms:2984", {
    repoId: "mission-control",
    sourceCommit: "33230f9ef1371e9e7d99ebcf3adbf92cfdecfdc2",
    sourcePath: "docs/reviews/2026-11-10/comms-1513-proposal/README.md",
    label: "Comms layout proposal",
  });
  expect(packet.images).toHaveLength(17);
  expect(packet.images.slice(0, 2).map((image) => image.label)).toEqual(["Before", "Proposal"]);
  expect(
    packet.images.reduce((total, image) => total + (service.asset(image.id)?.bytes.length ?? 0), 0),
  ).toBe(2629557);
  expect(createHash("sha256").update(packet.markdown).digest("hex")).toHaveLength(64);
});
