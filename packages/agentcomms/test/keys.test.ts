import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical.ts";
import {
  delegate,
  loadIdentity,
  newIdentity,
  saveIdentity,
  verifyDelegation,
} from "../src/keys.ts";
import { ready } from "../src/sodium.ts";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("identities", () => {
  it("initializes sodium once and generates independent signing and box keys", async () => {
    const [sodium, sameSodium] = await Promise.all([ready(), ready()]);
    expect(sodium).toBe(sameSodium);
    const human = await newIdentity("human", "Alice");
    const agent = await newIdentity("agent", "Assistant");
    expect(human.kind).toBe("human");
    expect(human.label).toBe("Alice");
    expect(agent.kind).toBe("agent");
    expect(agent.label).toBe("Assistant");
    expect(human.id).not.toBe(agent.id);
    for (const identity of [human, agent]) {
      expect(identity.id).toBe(Buffer.from(identity.sign.publicKey).toString("base64url"));
      expect(identity.sign.publicKey).toHaveLength(32);
      expect(identity.sign.privateKey).toHaveLength(64);
      expect(identity.box.publicKey).toHaveLength(32);
      expect(identity.box.privateKey).toHaveLength(32);
      expect(identity.box.publicKey).not.toEqual(identity.sign.publicKey);
      expect(identity.box.publicKey).not.toEqual(
        sodium.crypto_sign_ed25519_pk_to_curve25519(identity.sign.publicKey),
      );
      const message = "hello";
      const signature = sodium.crypto_sign_detached(message, identity.sign.privateKey);
      expect(sodium.crypto_sign_verify_detached(signature, message, identity.sign.publicKey)).toBe(
        true,
      );
      const sealed = sodium.crypto_box_seal(message, identity.box.publicKey);
      expect(
        sodium.to_string(
          sodium.crypto_box_seal_open(sealed, identity.box.publicKey, identity.box.privateKey),
        ),
      ).toBe(message);
    }
  });

  it("saves and loads key bytes with private file permissions outside the repo", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentcomms-keys-"));
    homes.push(home);
    const identity = await newIdentity("human", "Alice");
    await saveIdentity(home, identity);
    const path = join(home, "keys", `${identity.id}.json`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8")).id).toBe(identity.id);
    expect(await loadIdentity(home, identity.id)).toEqual(identity);
    await chmod(path, 0o644);
    await saveIdentity(home, identity);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it.each(["../escape", "a/b", "", "/absolute"])("rejects unsafe identity path %j", async (id) => {
    const home = await mkdtemp(join(tmpdir(), "agentcomms-keys-"));
    homes.push(home);
    const identity = await newIdentity("agent", "Assistant");
    await expect(saveIdentity(home, { ...identity, id })).rejects.toThrow();
    await expect(loadIdentity(home, id)).rejects.toThrow();
  });

  it("rejects symlinked key directories and files", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentcomms-keys-"));
    homes.push(home);
    const identity = await newIdentity("human", "Alice");
    const target = join(home, "elsewhere");
    const keys = join(home, "keys");
    await mkdir(target);
    await symlink(target, keys);
    await expect(saveIdentity(home, identity)).rejects.toThrow();
    await expect(loadIdentity(home, identity.id)).rejects.toThrow();
    await rm(keys);
    await mkdir(keys);
    const targetFile = join(target, "untouched.json");
    await writeFile(targetFile, "untouched");
    await symlink(targetFile, join(keys, `${identity.id}.json`));
    await expect(saveIdentity(home, identity)).rejects.toThrow();
    await expect(loadIdentity(home, identity.id)).rejects.toThrow();
    expect(await readFile(targetFile, "utf8")).toBe("untouched");
  });

  it("rejects a stored identity whose id does not match the requested filename", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentcomms-keys-"));
    homes.push(home);
    const identity = await newIdentity("human", "Alice");
    await saveIdentity(home, identity);
    const path = join(home, "keys", `${identity.id}.json`);
    const stored = JSON.parse(await readFile(path, "utf8"));
    stored.id = "different";
    await writeFile(path, JSON.stringify(stored));
    await expect(loadIdentity(home, identity.id)).rejects.toThrow();
  });
});

describe("delegations", () => {
  it("canonicalizes nested objects while preserving array order and omitting undefined fields", () => {
    expect(
      canonicalJson({ z: [{ b: 2, a: 1 }, "first"], a: { z: true, a: null, absent: undefined } }),
    ).toBe('{"a":{"a":null,"z":true},"z":[{"a":1,"b":2},"first"]}');
  });

  it("signs a canonical delegation that verifies with the member key", async () => {
    const member = await newIdentity("human", "Alice");
    const agent = await newIdentity("agent", "Assistant");
    const delegation = await delegate(member, agent, "team", "Helper");
    expect(delegation).toMatchObject({
      memberId: member.id,
      agentId: agent.id,
      subscription: "team",
      agentName: "Helper",
    });
    expect(await verifyDelegation(delegation, member.sign.publicKey)).toBe(true);
    const sodium = await ready();
    const canonical = JSON.stringify({
      agentId: agent.id,
      agentName: "Helper",
      memberId: member.id,
      subscription: "team",
    });
    expect(
      sodium.crypto_sign_verify_detached(
        Buffer.from(delegation.sig, "base64url"),
        canonical,
        member.sign.publicKey,
      ),
    ).toBe(true);
    expect(await verifyDelegation(delegation, agent.sign.publicKey)).toBe(false);
    for (const field of ["agentId", "memberId", "subscription", "agentName"] as const) {
      expect(
        await verifyDelegation(
          { ...delegation, [field]: `${delegation[field]}changed` },
          member.sign.publicKey,
        ),
      ).toBe(false);
    }
    for (const sig of ["", "!invalid", Buffer.alloc(64).toString("base64url")]) {
      expect(await verifyDelegation({ ...delegation, sig }, member.sign.publicKey)).toBe(false);
    }
    expect(await verifyDelegation(delegation, new Uint8Array())).toBe(false);
  });

  it("requires a human member and an agent delegate", async () => {
    const member = await newIdentity("human", "Alice");
    const agent = await newIdentity("agent", "Assistant");
    await expect(delegate(agent, member, "team", "Helper")).rejects.toThrow();
    await expect(delegate(member, member, "team", "Helper")).rejects.toThrow();
    await expect(delegate(agent, agent, "team", "Helper")).rejects.toThrow();
  });
});
