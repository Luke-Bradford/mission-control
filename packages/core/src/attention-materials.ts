/** Immutable display material retained for a Needs-you item: a plan, or a story told in pictures. */

/** Days the hub keeps a question's images after the question closes. */
export const ATTENTION_MATERIAL_RETENTION_DAYS = 30;
/** The most image bytes one question may hold, summed over every packet it has. */
export const ATTENTION_MATERIAL_QUESTION_BYTES = 24 * 1024 * 1024;
/** Deepest nesting of story sections, the sections in one story and the images in one packet. */
export const ATTENTION_STORY_DEPTH_MAX = 4;
export const ATTENTION_STORY_SECTIONS_MAX = 40;
export const ATTENTION_MATERIAL_IMAGES_MAX = 64;

export interface AttentionMaterialImage {
  id: string;
  path: string;
  label: string | null;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  sha256: string;
  url: string;
  /** Bytes retained; counts toward the question's cap. */
  size: number;
}

/** What a group of two or more images in a section shows side by side. */
export type AttentionComparisonKind = "before-after" | "options";

export interface AttentionStoryImage {
  /** An `images[].id` of the packet. */
  imageId: string;
  caption: string;
}

export interface AttentionStorySection {
  heading: string;
  text: string;
  images: AttentionStoryImage[];
  /** Set: the page shows `images` (two or more) side by side. */
  comparison: AttentionComparisonKind | null;
  children: AttentionStorySection[];
}

/** The pictures that show one brief option, so "this or this?" is answered by picking one. */
export interface AttentionOptionImages {
  optionId: string;
  imageIds: string[];
}

export type AttentionHistoricalReason =
  | "rebriefed"
  | "source changed"
  | "question closed"
  | "repository changed";

export interface AttentionMaterials {
  id: string;
  itemKey: string;
  repoId: string;
  sourceCommit: string;
  /** The plan Markdown's path; null for a story, whose sections carry the text. */
  sourcePath: string | null;
  label: string;
  registeredAt: number;
  /** Identity of the brief visible while this packet was registered. */
  briefId: number | null;
  /** The brief's source revision at registration, when it had one. */
  sourceRevision: string | null;
  markdown: string;
  images: AttentionMaterialImage[];
  /** Ordered, nested sections of a story; null for a plan packet. */
  story: AttentionStorySection[] | null;
  optionImages: AttentionOptionImages[];
  /** The item has since been rebriefed, changed source, closed or moved to another repository. */
  historical: boolean;
  historicalReason: AttentionHistoricalReason | null;
  /** When the hub first saw the question closed; the retention window counts from here. */
  closedAt: number | null;
  /** Set once the images were deleted after the window; `images[].url` then answers 404. */
  imagesRemovedAt: number | null;
}

export interface AttentionMaterialRegistration {
  repoId: string;
  sourceCommit: string;
  sourcePath: string;
  label: string;
}

export interface AttentionStoryInputSection {
  heading: string;
  text?: string;
  images?: { path: string; caption: string }[];
  comparison?: AttentionComparisonKind;
  children?: AttentionStoryInputSection[];
}

/** One call from FLIGHT: a nested story of committed images, with picture options. */
export interface AttentionStoryRegistration {
  repoId: string;
  sourceCommit: string;
  label: string;
  sections: AttentionStoryInputSection[];
  optionImages?: { optionId: string; imagePaths: string[] }[];
}

/** `GET /api/attention/:key/materials`: every packet kept for the item, oldest first. */
export interface AttentionMaterialsResponse {
  packets: AttentionMaterials[];
}
