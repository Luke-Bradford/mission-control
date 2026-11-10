/** Immutable, operator-only repository plans attached to Needs-you items. */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { promisify } from "node:util";
import type {
  AttentionMaterialImage,
  AttentionMaterialRegistration,
  AttentionMaterials,
} from "@mc/core";
import type { CcConfig } from "./config.ts";
import { GIT_TIMEOUT_MS, gitEnv } from "./files.ts";
import { SAFE_CONFIG } from "./runtime/git.ts";
import type { Store } from "./store.ts";

const execFileP = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const DOC_MARKDOWN = /^docs\/(?:[^/]+\/)*[^/]+\.md$/i;
const RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?\/)(?!.*%)(?:[^/]+\/)*[^/]+$/;
const MARKDOWN_LINK = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+[^)]*)?\)/g;
const MAX_MARKDOWN = 1024 * 1024;
const MAX_IMAGES = 64;
const MAX_IMAGE = 2 * 1024 * 1024;
const MAX_TOTAL_IMAGES = 24 * 1024 * 1024;

export class AttentionMaterialsError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type SavedStore = Pick<
  Store,
  "attentionMaterials" | "attentionMaterialsForItem" | "putAttentionMaterials"
>;
type Item = { repoId: string | null; brief?: { id?: number } } | null;
type GitBlob = (checkout: string, commit: string, path: string) => Promise<Buffer>;
export interface AttentionMaterialsService {
  register(itemKey: string, input: AttentionMaterialRegistration): Promise<AttentionMaterials>;
  read(itemKey: string): AttentionMaterials | null;
  asset(id: string): { bytes: Buffer; mediaType: AttentionMaterialImage["mediaType"] } | null;
}

function hash(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function mediaType(bytes: Buffer, path: string): AttentionMaterialImage["mediaType"] | null {
  const p = path.toLowerCase();
  if (
    p.endsWith(".png") &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (p.endsWith(".jpg") || p.endsWith(".jpeg"))
    return bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : null;
  if (
    p.endsWith(".webp") &&
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  return null;
}
function storedMediaType(bytes: Buffer): AttentionMaterialImage["mediaType"] | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP")
    return "image/webp";
  return null;
}
function safePath(path: string): boolean {
  return RELATIVE_PATH.test(path) && !path.includes("\\") && !path.includes("\0");
}
/** A link may name this packet's directory or a descendant, but never climb from it. */
function safePacketLink(link: string): boolean {
  return (
    !link.startsWith("/") &&
    !link.includes("\\") &&
    !link.includes("\0") &&
    !link.includes("%") &&
    link.split("/").every((segment) => segment !== "" && segment !== "..")
  );
}
function packetId(key: string, input: AttentionMaterialRegistration): string {
  return hash(
    `${key}\0${input.repoId}\0${input.sourceCommit}\0${input.sourcePath}\0${input.label}`,
  );
}

async function committedBlob(checkout: string, commit: string, path: string): Promise<Buffer> {
  try {
    const listed = await execFileP(
      "git",
      [...SAFE_CONFIG, "-C", checkout, "ls-tree", "-z", commit, "--", path],
      {
        encoding: "buffer",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 4096,
        env: { ...gitEnv(process.env), GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" },
      },
    );
    // A tree read does not dereference symlinks. Only a regular committed blob can enter storage.
    if (!/^100(?:644|755) blob [0-9a-f]{40,64}\t/.test(listed.stdout.toString("utf8")))
      throw new AttentionMaterialsError(400, "The named source is not a regular committed file.");
    const { stdout } = await execFileP(
      "git",
      [...SAFE_CONFIG, "-C", checkout, "cat-file", "blob", "--", `${commit}:${path}`],
      {
        encoding: "buffer",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_IMAGE + MAX_MARKDOWN,
        env: { ...gitEnv(process.env), GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" },
      },
    );
    return stdout;
  } catch (error) {
    if (error instanceof AttentionMaterialsError) throw error;
    throw new AttentionMaterialsError(404, "The named committed file was not found.");
  }
}

export function createAttentionMaterials(i: {
  store: SavedStore;
  config: CcConfig;
  item: (key: string) => Item;
  checkout?: (repoId: string) => string | undefined;
  git?: GitBlob;
  assetsDir?: string;
  now?: () => number;
}): AttentionMaterialsService {
  const now = i.now ?? Date.now;
  const checkout =
    i.checkout ?? ((repoId) => i.config.crew?.sessions.find((s) => s.repoId === repoId)?.checkout);
  const read = i.git ?? committedBlob;
  const assetsDir =
    i.assetsDir ?? join(dirname((i.store as Store).path), "attention-material-assets");
  const writeAsset = (id: string, bytes: Buffer) => {
    mkdirSync(assetsDir, { recursive: true, mode: 0o700 });
    chmodSync(assetsDir, 0o700);
    const target = join(assetsDir, id);
    try {
      writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  };
  const historical = (packet: AttentionMaterials) => {
    const live = i.item(packet.itemKey);
    return (
      live === null ||
      live.repoId !== packet.repoId ||
      (packet.briefId !== null && live.brief?.id !== packet.briefId)
    );
  };
  return {
    async register(
      itemKey: string,
      input: AttentionMaterialRegistration,
    ): Promise<AttentionMaterials> {
      if (!SHA.test(input.sourceCommit))
        throw new AttentionMaterialsError(400, "Give a full 40-character source commit.");
      if (!DOC_MARKDOWN.test(input.sourcePath) || !safePath(input.sourcePath))
        throw new AttentionMaterialsError(
          400,
          "The source path must be a Markdown file under docs/.",
        );
      if (!i.config.repos.some((repo) => repo.id === input.repoId))
        throw new AttentionMaterialsError(404, "Repository is not configured.");
      const item = i.item(itemKey);
      if (item === null || item.repoId !== input.repoId)
        throw new AttentionMaterialsError(404, "Item does not belong to that repository.");
      const id = packetId(itemKey, input);
      const prior = i.store.attentionMaterials(id);
      if (prior) return { ...prior, historical: historical(prior) };
      const root = checkout(input.repoId);
      if (!root) throw new AttentionMaterialsError(503, "Repository checkout is unavailable.");
      const markdownBytes = await read(root, input.sourceCommit, input.sourcePath);
      if (markdownBytes.length > MAX_MARKDOWN || markdownBytes.includes(0))
        throw new AttentionMaterialsError(400, "Plan Markdown is missing or too large.");
      let total = 0;
      const images: AttentionMaterialImage[] = [];
      const base = posix.dirname(input.sourcePath);
      const markdown = await (async () => {
        let output = "",
          offset = 0;
        const source = markdownBytes.toString("utf8");
        for (const match of source.matchAll(MARKDOWN_LINK)) {
          output += markdownBytes.toString("utf8").slice(offset, match.index);
          offset = (match.index ?? 0) + match[0].length;
          const imageSyntax = match[1] === "!",
            label = match[2] || null,
            link = match[3];
          const candidate = /\.(?:png|jpe?g|webp)$/i.test(link);
          if (!candidate) {
            output += match[0];
            continue;
          }
          if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith("//")) {
            output += imageSyntax ? `[${label ?? "image"}](${link})` : match[0];
            continue;
          }
          if (!safePacketLink(link))
            throw new AttentionMaterialsError(
              400,
              "Plan image path must stay within the packet directory.",
            );
          const path = posix.normalize(posix.join(base, link));
          if (!safePath(path) || (path !== base && !path.startsWith(`${base}/`)))
            throw new AttentionMaterialsError(
              400,
              "Plan image path must stay within the packet directory.",
            );
          if (images.length >= MAX_IMAGES)
            throw new AttentionMaterialsError(400, "Plan has too many images.");
          const bytes = await read(root, input.sourceCommit, path);
          const type = bytes.length <= MAX_IMAGE ? mediaType(bytes, path) : null;
          if (!type)
            throw new AttentionMaterialsError(
              400,
              "Plan images must be bounded PNG, JPEG or WebP files.",
            );
          total += bytes.length;
          if (total > MAX_TOTAL_IMAGES)
            throw new AttentionMaterialsError(400, "Plan images are too large.");
          const asset = hash(bytes);
          writeAsset(asset, bytes);
          images.push({
            id: asset,
            path,
            label,
            mediaType: type,
            sha256: asset,
            url: `/api/attention-material-assets/${asset}`,
          });
          output += imageSyntax
            ? `![${label ?? "image"}](/api/attention-material-assets/${asset})`
            : `[${label ?? "image"}](/api/attention-material-assets/${asset})`;
        }
        return output + markdownBytes.toString("utf8").slice(offset);
      })();
      const packet: AttentionMaterials = {
        id,
        itemKey,
        ...input,
        registeredAt: now(),
        briefId: item.brief?.id ?? null,
        markdown,
        images,
        historical: false,
      };
      i.store.putAttentionMaterials(packet);
      return packet;
    },
    read(itemKey: string): AttentionMaterials | null {
      const packet = i.store.attentionMaterialsForItem(itemKey);
      return packet ? { ...packet, historical: historical(packet) } : null;
    },
    asset(id: string): { bytes: Buffer; mediaType: AttentionMaterialImage["mediaType"] } | null {
      if (!/^[a-f0-9]{64}$/.test(id)) return null;
      try {
        const bytes = readFileSync(join(assetsDir, id));
        const type = storedMediaType(bytes);
        return type ? { bytes, mediaType: type } : null;
      } catch {
        return null;
      }
    },
  };
}
