import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "./canonical.ts";
import { ready } from "./sodium.ts";

export type KeyPair = { publicKey: Uint8Array; privateKey: Uint8Array };

export type Identity = {
  id: string;
  kind: "human" | "agent";
  label: string;
  sign: KeyPair;
  box: KeyPair;
};

export type Delegation = {
  boxPublicKey: string;
  agentId: string;
  memberId: string;
  subscription: string;
  agentName: string;
  sig: string;
};

type StoredKeyPair = { publicKey: string; privateKey: string };
type StoredIdentity = Omit<Identity, "sign" | "box"> & {
  sign: StoredKeyPair;
  box: StoredKeyPair;
};

export async function newIdentity(kind: Identity["kind"], label: string): Promise<Identity> {
  const sodium = await ready();
  const sign = sodium.crypto_sign_keypair();
  const box = sodium.crypto_box_keypair();
  return {
    id: sodium.to_base64(sign.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
    kind,
    label,
    sign: { publicKey: sign.publicKey, privateKey: sign.privateKey },
    box: { publicKey: box.publicKey, privateKey: box.privateKey },
  };
}

function keyPath(dir: string, id: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) throw new Error("Invalid identity id");
  return join(dir, "keys", `${id}.json`);
}

async function checkKeysDirectory(dir: string): Promise<void> {
  if (!(await lstat(join(dir, "keys"))).isDirectory()) {
    throw new Error("Keys path must be a directory, not a symlink");
  }
}

export async function saveIdentity(dir: string, identity: Identity): Promise<void> {
  const path = keyPath(dir, identity.id);
  const sodium = await ready();
  const encode = (key: Uint8Array) =>
    sodium.to_base64(key, sodium.base64_variants.URLSAFE_NO_PADDING);
  if (identity.id !== encode(identity.sign.publicKey))
    throw new Error("Identity id does not match key");
  const encodePair = (pair: KeyPair): StoredKeyPair => ({
    publicKey: encode(pair.publicKey),
    privateKey: encode(pair.privateKey),
  });
  const stored: StoredIdentity = {
    ...identity,
    sign: encodePair(identity.sign),
    box: encodePair(identity.box),
  };
  await mkdir(join(dir, "keys"), { recursive: true, mode: 0o700 });
  await checkKeysDirectory(dir);
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.chmod(0o600);
    await file.truncate(0);
    await file.writeFile(JSON.stringify(stored));
  } finally {
    await file.close();
  }
}

export async function loadIdentity(dir: string, id: string): Promise<Identity> {
  const path = keyPath(dir, id);
  await checkKeysDirectory(dir);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let stored: StoredIdentity;
  try {
    stored = JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
  const sodium = await ready();
  const decodePair = (pair: StoredKeyPair): KeyPair => ({
    publicKey: sodium.from_base64(pair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
    privateKey: sodium.from_base64(pair.privateKey, sodium.base64_variants.URLSAFE_NO_PADDING),
  });
  const identity: Identity = {
    ...stored,
    sign: decodePair(stored.sign),
    box: decodePair(stored.box),
  };
  if (
    identity.id !== id ||
    sodium.to_base64(identity.sign.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING) !== id
  ) {
    throw new Error("Stored identity does not match requested id");
  }
  return identity;
}

function delegationPayload(d: Omit<Delegation, "sig">): string {
  return `agentcomms/delegation/v1|${canonicalJson({
    boxPublicKey: d.boxPublicKey,
    agentId: d.agentId,
    memberId: d.memberId,
    subscription: d.subscription,
    agentName: d.agentName,
  })}`;
}

export async function delegate(
  member: Identity,
  agent: Identity,
  subscription: string,
  agentName: string,
): Promise<Delegation> {
  if (member.kind !== "human" || agent.kind !== "agent") {
    throw new Error("Delegation requires a human member and an agent");
  }
  const sodium = await ready();
  const payload = {
    boxPublicKey: sodium.to_base64(agent.box.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
    agentId: agent.id,
    memberId: member.id,
    subscription,
    agentName,
  };
  const sig = sodium.crypto_sign_detached(delegationPayload(payload), member.sign.privateKey);
  return { ...payload, sig: sodium.to_base64(sig, sodium.base64_variants.URLSAFE_NO_PADDING) };
}

export async function verifyDelegation(
  d: Delegation,
  memberPublicKey: Uint8Array,
): Promise<boolean> {
  const sodium = await ready();
  try {
    if (d.memberId !== sodium.to_base64(memberPublicKey, sodium.base64_variants.URLSAFE_NO_PADDING))
      return false;
    const sig = sodium.from_base64(d.sig, sodium.base64_variants.URLSAFE_NO_PADDING);
    return sodium.crypto_sign_verify_detached(sig, delegationPayload(d), memberPublicKey);
  } catch {
    return false;
  }
}
