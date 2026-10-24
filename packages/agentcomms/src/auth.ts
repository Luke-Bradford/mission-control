import { canonicalJson } from "./canonical.ts";
import type { Identity } from "./keys.ts";
import type { KeyGrant, Member } from "./membership.ts";
import { ready } from "./sodium.ts";

const sodium = await ready();
const variant = sodium.base64_variants.URLSAFE_NO_PADDING;
export const encode = (bytes: Uint8Array) => sodium.to_base64(bytes, variant);
export const decode = (text: string) => sodium.from_base64(text, variant);
export const hash = (text: string) => encode(sodium.crypto_hash_sha256(text));
export function sign(payload: string, identity: Identity): string {
  return encode(sodium.crypto_sign_detached(payload, identity.sign.privateKey));
}
export function verify(payload: string, sig: string, id: string): boolean {
  try {
    return sodium.crypto_sign_verify_detached(decode(sig), payload, decode(id));
  } catch {
    return false;
  }
}
export function signMember(member: Member, identity: Identity): Member {
  if (member.id !== identity.id) throw new Error("Wrong member signer");
  const { sig: _, ...record } = member;
  return { ...record, sig: sign(`agentcomms/member/v1|${canonicalJson(record)}`, identity) };
}
export function verifyMember(member: Member): boolean {
  const { sig, ...record } = member;
  return verify(`agentcomms/member/v1|${canonicalJson(record)}`, sig, member.id);
}
export type Directory = {
  room: string;
  keyEpoch: number;
  version: number;
  members: Member[];
  activeMemberIds: string[];
  sig: string;
};
function directoryPayload(d: Directory): string {
  return `agentcomms/directory/v1|${d.room}|${d.keyEpoch}|${d.version}|${hash(canonicalJson(d.members))}`;
}
export function signDirectory(
  room: string,
  keyEpoch: number,
  version: number,
  members: Member[],
  owner: Identity,
): Directory {
  const d: Directory = {
    room,
    keyEpoch,
    version,
    members: structuredClone(members),
    activeMemberIds: members.map((m) => m.id),
    sig: "",
  };
  d.sig = sign(directoryPayload(d), owner);
  return d;
}
export function verifyDirectory(d: Directory, room: string, ownerId: string): boolean {
  return (
    d.room === room &&
    Number.isSafeInteger(d.keyEpoch) &&
    d.keyEpoch >= 0 &&
    Number.isSafeInteger(d.version) &&
    d.version >= 0 &&
    d.members[0]?.id === ownerId &&
    new Set(d.activeMemberIds).size === d.members.length &&
    canonicalJson(d.activeMemberIds) === canonicalJson(d.members.map((m) => m.id)) &&
    d.members.every(verifyMember) &&
    verify(directoryPayload(d), d.sig, ownerId)
  );
}
function grantPayload(room: string, g: KeyGrant): string {
  return `agentcomms/grant/v1|${room}|${g.memberId}|${g.keyEpoch}|${hash(g.wrapped)}`;
}
export function signGrant(room: string, grant: KeyGrant, owner: Identity): KeyGrant {
  return { ...grant, sig: sign(grantPayload(room, grant), owner) };
}
export function verifyGrant(room: string, grant: KeyGrant, ownerId: string): boolean {
  return verify(grantPayload(room, grant), grant.sig ?? "", ownerId);
}
export function controlPayload(
  purpose: "approve" | "remove" | "token" | "create",
  room: string,
  payload: unknown,
): string {
  return `agentcomms/${purpose}/v1|${room}|${canonicalJson(payload)}`;
}
