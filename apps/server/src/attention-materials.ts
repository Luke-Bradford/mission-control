/** Immutable, operator-only repository plans and picture stories attached to Needs-you items. */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { promisify } from "node:util";
import {
  ATTENTION_MATERIAL_IMAGES_MAX,
  ATTENTION_MATERIAL_QUESTION_BYTES,
  ATTENTION_MATERIAL_RETENTION_DAYS,
  ATTENTION_STORY_DEPTH_MAX,
  ATTENTION_STORY_SECTIONS_MAX,
  type AttentionHistoricalReason,
  type AttentionMaterialImage,
  type AttentionMaterialRegistration,
  type AttentionMaterials,
  type AttentionOptionImages,
  type AttentionStoryInputSection,
  type AttentionStoryRegistration,
  type AttentionStorySection,
} from "@mc/core";
import type { CcConfig } from "./config.ts";
import { GIT_TIMEOUT_MS, gitEnv } from "./files.ts";
import { SAFE_CONFIG } from "./runtime/git.ts";
import type { Store } from "./store.ts";

const execFileP = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const DOC_MARKDOWN = /^docs\/(?:[^/]+\/)*[^/]+\.md$/i;
const RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?\/)(?!.*%)(?:[^/]+\/)*[^/]+$/;
/** `![alt](dest "title")`, `[text](dest)`; the destination may be `<...>` wrapped. */
const MARKDOWN_LINK = /(!?)\[([^\]]*)\]\((?:<([^>]*)>|([^)\s]+))(?:\s+[^)]*)?\)/g;
/** Reference-style image use: `![alt][ref]`. */
const REFERENCE_IMAGE = /!(\[[^\]]*\]\[[^\]]*\])/g;
/** The start of raw HTML (`<img`, `</x`, `<!--`) is made inert text, never an element. */
const RAW_HTML = /<(?=[a-zA-Z/!?])/g;
const RASTER_EXT = /\.(?:png|jpe?g|webp)$/i;
const MAX_MARKDOWN = 1024 * 1024;
const MAX_IMAGE = 2 * 1024 * 1024;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const IMAGE_REFUSED = "Images must be bounded PNG, JPEG or WebP files.";

export class AttentionMaterialsError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type SavedStore = Pick<
  Store,
  | "attentionMaterials"
  | "attentionMaterialsForItem"
  | "attentionMaterialsAllForItem"
  | "attentionMaterialsHeld"
  | "markAttentionMaterials"
  | "putAttentionMaterials"
>;
type Item = {
  repoId: string | null;
  brief?: {
    id?: number;
    options?: { id?: string }[];
    binding?: { sourceRevision?: string };
    state?: { freshness?: string };
  };
} | null;
type GitBlob = (checkout: string, commit: string, path: string, limit?: number) => Promise<Buffer>;
export interface AttentionMaterialsService {
  register(itemKey: string, input: AttentionMaterialRegistration): Promise<AttentionMaterials>;
  attachStory(itemKey: string, input: AttentionStoryRegistration): Promise<AttentionMaterials>;
  read(itemKey: string): AttentionMaterials | null;
  asset(id: string): { bytes: Buffer; mediaType: AttentionMaterialImage["mediaType"] } | null;
  /** Marks closed questions, and deletes the images of those closed past the retention window. */
  sweep(): void;
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
  return (
    RELATIVE_PATH.test(path) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.split("/").some((segment) => segment === ".git")
  );
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
function packetId(key: string, parts: unknown[]): string {
  return hash(`${key}\0${parts.map((p) => JSON.stringify(p)).join("\0")}`);
}

async function committedBlob(
  checkout: string,
  commit: string,
  path: string,
  limit = MAX_IMAGE,
): Promise<Buffer> {
  try {
    const listed = await execFileP(
      "git",
      [...SAFE_CONFIG, "-C", checkout, "ls-tree", "-l", "-z", commit, "--", path],
      {
        encoding: "buffer",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 4096,
        env: { ...gitEnv(process.env), GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" },
      },
    );
    if (listed.stdout.length === 0)
      throw new AttentionMaterialsError(404, "The named committed file was not found.");
    // A tree read does not dereference symlinks. Only a regular committed blob can enter storage.
    const entry = /^100(?:644|755) blob [0-9a-f]{40,64} +(\d+)\t/.exec(
      listed.stdout.toString("utf8"),
    );
    if (!entry)
      throw new AttentionMaterialsError(400, "The named source is not a regular committed file.");
    // refused by its listed size, before any bytes are read
    if (Number(entry[1]) > limit)
      throw new AttentionMaterialsError(
        400,
        `${path.slice(0, 160)} is over ${limit / 1024 / 1024} MB.`,
      );
    const { stdout } = await execFileP(
      "git",
      [...SAFE_CONFIG, "-C", checkout, "cat-file", "blob", "--", `${commit}:${path}`],
      {
        encoding: "buffer",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: limit,
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

  const withDefaults = (packet: AttentionMaterials): AttentionMaterials => ({
    ...packet,
    sourcePath: packet.sourcePath ?? null,
    sourceRevision: packet.sourceRevision ?? null,
    story: packet.story ?? null,
    optionImages: packet.optionImages ?? [],
    closedAt: packet.closedAt ?? null,
    imagesRemovedAt: packet.imagesRemovedAt ?? null,
  });
  const historicalReason = (packet: AttentionMaterials): AttentionHistoricalReason | null => {
    const live = i.item(packet.itemKey);
    if (live === null) return "question closed";
    if (live.repoId !== packet.repoId) return "repository changed";
    if (packet.briefId !== null && live.brief?.id !== packet.briefId) return "rebriefed";
    if (
      (packet.sourceRevision !== null &&
        live.brief?.binding?.sourceRevision !== packet.sourceRevision) ||
      live.brief?.state?.freshness === "stale"
    )
      return "source changed";
    return null;
  };
  const view = (stored: AttentionMaterials): AttentionMaterials => {
    const packet = withDefaults(stored);
    const reason = historicalReason(packet);
    return { ...packet, historical: reason !== null, historicalReason: reason };
  };

  /** Bytes the question already holds, by image id, over every packet whose images remain. */
  const heldImages = (itemKey: string): Map<string, number> => {
    const held = new Map<string, number>();
    for (const packet of i.store.attentionMaterialsAllForItem(itemKey)) {
      if ((packet.imagesRemovedAt ?? null) !== null) continue;
      for (const image of packet.images) held.set(image.id, image.size);
    }
    return held;
  };

  /** Reads and checks the images of one registration, writing nothing until all pass. */
  const collector = (itemKey: string, root: string, commit: string) => {
    const held = heldImages(itemKey);
    const byPath = new Map<string, AttentionMaterialImage>();
    const byId = new Map<string, AttentionMaterialImage>();
    const pending = new Map<string, Buffer>();
    let added = 0;
    return {
      images: [] as AttentionMaterialImage[],
      async load(path: string, label: string | null): Promise<AttentionMaterialImage> {
        const known = byPath.get(path);
        if (known) return known;
        if (this.images.length >= ATTENTION_MATERIAL_IMAGES_MAX)
          throw new AttentionMaterialsError(400, "Too many images in one packet.");
        const bytes = await read(root, commit, path, MAX_IMAGE);
        const type = bytes.length <= MAX_IMAGE ? mediaType(bytes, path) : null;
        if (!type)
          throw new AttentionMaterialsError(
            400,
            `${IMAGE_REFUSED} ${path} is not one, or is over ${MAX_IMAGE / 1024 / 1024} MB.`,
          );
        const id = hash(bytes);
        const twin = byId.get(id);
        if (twin) {
          byPath.set(path, twin);
          return twin;
        }
        if (!held.has(id)) {
          added += bytes.length;
          let total = added;
          for (const size of held.values()) total += size;
          if (total > ATTENTION_MATERIAL_QUESTION_BYTES)
            throw new AttentionMaterialsError(
              400,
              `This question's images would pass the ${ATTENTION_MATERIAL_QUESTION_BYTES / 1024 / 1024} MB cap.`,
            );
        }
        pending.set(id, bytes);
        const image: AttentionMaterialImage = {
          id,
          path,
          label,
          mediaType: type,
          sha256: id,
          size: bytes.length,
          url: `/api/attention-material-assets/${id}`,
        };
        byPath.set(path, image);
        byId.set(id, image);
        this.images.push(image);
        return image;
      },
      commit(): void {
        for (const [id, bytes] of pending) writeAsset(id, bytes);
      },
    };
  };

  /** The common checks of a registration: the commit, the repository and the item. */
  const precheck = (itemKey: string, repoId: string, commit: string) => {
    if (!SHA.test(commit))
      throw new AttentionMaterialsError(400, "Give a full 40-character source commit.");
    if (!i.config.repos.some((repo) => repo.id === repoId))
      throw new AttentionMaterialsError(404, "Repository is not configured.");
    const item = i.item(itemKey);
    if (item === null || item.repoId !== repoId)
      throw new AttentionMaterialsError(404, "Item does not belong to that repository.");
    return item;
  };
  const rootOf = (repoId: string): string => {
    const root = checkout(repoId);
    if (!root) throw new AttentionMaterialsError(503, "Repository checkout is unavailable.");
    return root;
  };
  const baseOf = (item: NonNullable<Item>) => ({
    briefId: item.brief?.id ?? null,
    sourceRevision: item.brief?.binding?.sourceRevision ?? null,
  });

  const sweep = () => {
    const at = now();
    const removed: AttentionMaterials[] = [];
    for (const stored of i.store.attentionMaterialsHeld()) {
      const packet = withDefaults(stored);
      const open = i.item(packet.itemKey) !== null;
      if (open) {
        if (packet.closedAt !== null) i.store.markAttentionMaterials(packet.id, { closedAt: null });
        continue;
      }
      if (packet.closedAt === null) {
        i.store.markAttentionMaterials(packet.id, { closedAt: at });
        continue;
      }
      if (at - packet.closedAt >= ATTENTION_MATERIAL_RETENTION_DAYS * DAY_MS) {
        i.store.markAttentionMaterials(packet.id, { imagesRemovedAt: at });
        removed.push(packet);
      }
    }
    if (removed.length === 0) return;
    const stillHeld = new Set(
      i.store.attentionMaterialsHeld().flatMap((p) => p.images.map((image) => image.id)),
    );
    for (const packet of removed)
      for (const image of packet.images)
        if (!stillHeld.has(image.id) && /^[a-f0-9]{64}$/.test(image.id))
          rmSync(join(assetsDir, image.id), { force: true });
  };

  /** `![alt](x)` that does not become a retained image is shown as a plain link, never embedded. */
  const inert = (label: string, link: string) =>
    /^[a-z][a-z0-9+.-]*:/i.test(link) && !/^https?:/i.test(link) ? label : `[${label}](${link})`;

  /** Rewrites plan Markdown: retained rasters become asset links; nothing else stays an embed. */
  const planMarkdown = async (
    source: string,
    base: string,
    images: ReturnType<typeof collector>,
  ): Promise<string> => {
    let output = "";
    let offset = 0;
    for (const match of source.matchAll(MARKDOWN_LINK)) {
      output += source.slice(offset, match.index);
      offset = (match.index ?? 0) + match[0].length;
      const embed = match[1] === "!";
      const label = match[2] || null;
      const link = match[3] ?? match[4] ?? "";
      const text = label ?? "image";
      const target = link.split(/[?#]/)[0] ?? "";
      const external = /^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith("//");
      if (external || !RASTER_EXT.test(target)) {
        output += embed ? inert(text, link) : match[0];
        continue;
      }
      if (!safePacketLink(target))
        throw new AttentionMaterialsError(
          400,
          "Plan image path must stay within the packet directory.",
        );
      const path = posix.normalize(posix.join(base, target));
      if (!safePath(path) || (path !== base && !path.startsWith(`${base}/`)))
        throw new AttentionMaterialsError(
          400,
          "Plan image path must stay within the packet directory.",
        );
      const image = await images.load(path, label);
      output += embed ? `![${text}](${image.url})` : `[${text}](${image.url})`;
    }
    return (output + source.slice(offset)).replace(REFERENCE_IMAGE, "$1").replace(RAW_HTML, "&lt;");
  };

  const storyPaths = (input: AttentionStoryRegistration): string[] => {
    const paths: string[] = [];
    let sections = 0;
    const walk = (list: AttentionStoryInputSection[], depth: number) => {
      if (depth > ATTENTION_STORY_DEPTH_MAX)
        throw new AttentionMaterialsError(
          400,
          `Sections nest at most ${ATTENTION_STORY_DEPTH_MAX} deep.`,
        );
      for (const section of list) {
        sections++;
        if (sections > ATTENTION_STORY_SECTIONS_MAX)
          throw new AttentionMaterialsError(
            400,
            `A story has at most ${ATTENTION_STORY_SECTIONS_MAX} sections.`,
          );
        const shown = section.images ?? [];
        if (section.comparison !== undefined && shown.length < 2)
          throw new AttentionMaterialsError(
            400,
            `Section "${section.heading}" is a comparison and needs two or more images.`,
          );
        for (const image of shown) paths.push(image.path);
        walk(section.children ?? [], depth + 1);
      }
    };
    if (input.sections.length === 0)
      throw new AttentionMaterialsError(400, "Give at least one section.");
    walk(input.sections, 1);
    for (const option of input.optionImages ?? []) paths.push(...option.imagePaths);
    for (const path of paths)
      if (!RASTER_EXT.test(path) || !safePath(path))
        throw new AttentionMaterialsError(
          400,
          `Image path ${path.slice(0, 120)} must be a PNG, JPEG or WebP file inside the repository.`,
        );
    return paths;
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
      const item = precheck(itemKey, input.repoId, input.sourceCommit);
      sweep();
      const id = packetId(itemKey, [
        input.repoId,
        input.sourceCommit,
        input.sourcePath,
        input.label,
      ]);
      const prior = i.store.attentionMaterials(id);
      if (prior) return view(prior);
      const root = rootOf(input.repoId);
      const markdownBytes = await read(root, input.sourceCommit, input.sourcePath, MAX_MARKDOWN);
      if (markdownBytes.length > MAX_MARKDOWN || markdownBytes.includes(0))
        throw new AttentionMaterialsError(400, "Plan Markdown is missing or too large.");
      const images = collector(itemKey, root, input.sourceCommit);
      const markdown = await planMarkdown(
        markdownBytes.toString("utf8"),
        posix.dirname(input.sourcePath),
        images,
      );
      images.commit();
      const packet: AttentionMaterials = {
        id,
        itemKey,
        ...input,
        registeredAt: now(),
        ...baseOf(item),
        markdown,
        images: images.images,
        story: null,
        optionImages: [],
        historical: false,
        historicalReason: null,
        closedAt: null,
        imagesRemovedAt: null,
      };
      i.store.putAttentionMaterials(packet);
      return packet;
    },
    async attachStory(
      itemKey: string,
      input: AttentionStoryRegistration,
    ): Promise<AttentionMaterials> {
      const item = precheck(itemKey, input.repoId, input.sourceCommit);
      sweep();
      const paths = storyPaths(input);
      const optionIds = new Set((item.brief?.options ?? []).flatMap((o) => (o.id ? [o.id] : [])));
      for (const option of input.optionImages ?? []) {
        if (!optionIds.has(option.optionId))
          throw new AttentionMaterialsError(
            400,
            `Option ${option.optionId.slice(0, 80)} is not an option of this question's brief.`,
          );
        if (option.imagePaths.length === 0)
          throw new AttentionMaterialsError(400, "An option with pictures needs an image.");
      }
      const id = packetId(itemKey, [
        input.repoId,
        input.sourceCommit,
        "story",
        input.label,
        input.sections,
        input.optionImages ?? [],
      ]);
      const prior = i.store.attentionMaterials(id);
      if (prior) return view(prior);
      const root = rootOf(input.repoId);
      const images = collector(itemKey, root, input.sourceCommit);
      for (const path of paths) await images.load(path, null);
      const idOf = async (path: string) => (await images.load(path, null)).id;
      const convert = async (
        list: AttentionStoryInputSection[],
      ): Promise<AttentionStorySection[]> => {
        const out: AttentionStorySection[] = [];
        for (const section of list) {
          const shown: AttentionStorySection["images"] = [];
          for (const image of section.images ?? [])
            shown.push({ imageId: await idOf(image.path), caption: image.caption });
          out.push({
            heading: section.heading,
            text: section.text ?? "",
            images: shown,
            comparison: section.comparison ?? null,
            children: await convert(section.children ?? []),
          });
        }
        return out;
      };
      const story = await convert(input.sections);
      const optionImages: AttentionOptionImages[] = [];
      for (const option of input.optionImages ?? [])
        optionImages.push({
          optionId: option.optionId,
          imageIds: await Promise.all(option.imagePaths.map(idOf)),
        });
      // a caption is the image's label in the manifest, from its first appearance
      const captions = new Map<string, string>();
      const note = (list: AttentionStorySection[]) => {
        for (const section of list) {
          for (const image of section.images)
            if (!captions.has(image.imageId)) captions.set(image.imageId, image.caption);
          note(section.children);
        }
      };
      note(story);
      images.commit();
      const packet: AttentionMaterials = {
        id,
        itemKey,
        repoId: input.repoId,
        sourceCommit: input.sourceCommit,
        sourcePath: null,
        label: input.label,
        registeredAt: now(),
        ...baseOf(item),
        markdown: "",
        images: images.images.map((image) => ({
          ...image,
          label: captions.get(image.id) ?? image.label,
        })),
        story,
        optionImages,
        historical: false,
        historicalReason: null,
        closedAt: null,
        imagesRemovedAt: null,
      };
      i.store.putAttentionMaterials(packet);
      return packet;
    },
    read(itemKey: string): AttentionMaterials | null {
      sweep();
      const packet = i.store.attentionMaterialsForItem(itemKey);
      return packet ? view(packet) : null;
    },
    asset(id: string): { bytes: Buffer; mediaType: AttentionMaterialImage["mediaType"] } | null {
      if (!/^[a-f0-9]{64}$/.test(id)) return null;
      const file = join(assetsDir, id);
      if (!existsSync(file)) return null;
      try {
        const bytes = readFileSync(file);
        const type = storedMediaType(bytes);
        return type ? { bytes, mediaType: type } : null;
      } catch {
        return null;
      }
    },
    sweep,
  };
}

export const MATERIAL_SWEEP_MS = HOUR_MS;
