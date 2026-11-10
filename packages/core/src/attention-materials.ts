/** Immutable display material retained for a Needs-you item. */
export interface AttentionMaterialImage {
  id: string;
  path: string;
  label: string | null;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  sha256: string;
  url: string;
}

export interface AttentionMaterials {
  id: string;
  itemKey: string;
  repoId: string;
  sourceCommit: string;
  sourcePath: string;
  label: string;
  registeredAt: number;
  /** Identity of the brief visible while this packet was registered. */
  briefId: number | null;
  markdown: string;
  images: AttentionMaterialImage[];
  /** The item has since been rebriefed or moved to another repository. */
  historical: boolean;
}

export interface AttentionMaterialRegistration {
  repoId: string;
  sourceCommit: string;
  sourcePath: string;
  label: string;
}
