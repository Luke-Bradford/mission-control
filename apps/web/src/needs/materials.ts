import type {
  AttentionBrief,
  AttentionItem,
  AttentionMaterialImage,
  AttentionMaterials,
  AttentionStorySection,
} from "@mc/core";
import { pictureRoute } from "./pictures.ts";

/** A canonical `repo#number` reference to a main ticket; a PR label like `PR 1600` is not one. */
export interface TicketRef {
  repoId: string;
  number: number;
}

const CANONICAL = /^([A-Za-z0-9][A-Za-z0-9._-]*)#([1-9]\d{0,9})$/;

export function parseTicketRef(text: string | null | undefined): TicketRef | null {
  const m = CANONICAL.exec((text ?? "").trim());
  return m ? { repoId: m[1] as string, number: Number(m[2]) } : null;
}

/** The main ticket an item is about: its own canonical ticket, else the brief's. */
export function mainTicket(item: {
  ticket: string | null;
  brief?: Pick<AttentionBrief, "ticket">;
}): TicketRef | null {
  return parseTicketRef(item.ticket) ?? parseTicketRef(item.brief?.ticket);
}

const FENCE = /^ {0,3}(```|~~~)/;

/**
 * The text under the ticket's `## Plan` heading, up to the next `##` heading, with its nested
 * headings, lists and links kept as written. Null when the body has no such section.
 */
export function planSection(body: string): string | null {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let fence = "";
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const f = FENCE.exec(line)?.[1];
    if (f) {
      if (fence === "") fence = f;
      else if (fence === f) fence = "";
      continue;
    }
    if (fence !== "") continue;
    if (start < 0) {
      if (/^##[ \t]+Plan[ \t]*#*[ \t]*$/i.test(line)) start = i + 1;
    } else if (/^##[ \t]+\S/.test(line)) {
      end = i;
      break;
    }
  }
  if (start < 0) return null;
  const text = lines.slice(start, end).join("\n").trim();
  return text === "" ? null : text;
}

/** The route of a retained image; the one shape of link the viewer may open. */
export const retainedImageId = (url: string): string | null =>
  /^\/api\/attention-material-assets\/([0-9a-f]{64})$/.exec(url.trim())?.[1] ?? null;

/** A retained image of a packet by id, only when its URL is an exact allowed route. */
export function packetImage(
  packet: AttentionMaterials,
  id: string,
): AttentionMaterialImage | undefined {
  const image = packet.images.find((i) => i.id === id);
  return image && pictureRoute(image.url) ? image : undefined;
}

/** A relative reference (`../x.md`, `docs/a.md`) names no page the HUD can open. */
export const isRelativeReference = (url: string): boolean =>
  url.trim() !== "" && !/^[a-z][a-z0-9+.-]*:/i.test(url.trim()) && !url.trim().startsWith("/");

export interface StoryImage {
  image: AttentionMaterialImage;
  caption: string;
}

/** The images a section shows, in order, that the packet still holds as allowed routes. */
export function sectionImages(
  packet: AttentionMaterials,
  section: AttentionStorySection,
): StoryImage[] {
  const out: StoryImage[] = [];
  for (const s of section.images) {
    const image = packetImage(packet, s.imageId);
    if (image) out.push({ image, caption: s.caption });
  }
  return out;
}

/** The images of a packet that no story section or plan embed is the only way to reach. */
export function chooserImages(packet: AttentionMaterials): AttentionMaterialImage[] {
  return packet.images.filter((i) => pictureRoute(i.url) !== null);
}

/** What a chooser opens on: the proposal when one is labelled, else the first image. */
export function defaultImageIndex(images: { label: string | null; path: string }[]): number {
  const i = images.findIndex((x) => /proposed|after|mockup/i.test(`${x.label ?? ""} ${x.path}`));
  return i < 0 ? 0 : i;
}

/** The label to show for an image: its caption, else its file name. */
export const imageLabel = (image: AttentionMaterialImage): string =>
  image.label?.trim() || image.path.split("/").at(-1) || "Picture";

/** Valid hub screenshots the brief's work log recorded: a live "before", never a proposal. */
export function didScreenshots(item: AttentionItem): { label: string; url: string }[] {
  const seen = new Set<string>();
  const out: { label: string; url: string }[] = [];
  for (const d of item.brief?.did ?? []) {
    for (const ref of d.refs) {
      const url = ref.trim();
      if (seen.has(url) || !pictureRoute(url)) continue;
      seen.add(url);
      out.push({ label: d.action, url });
    }
  }
  return out;
}
