/** What `GET /api/boards/:repoId/setup` answers. */
export interface BoardSetupStatus {
  missing: string[];
  missingLabels: string[];
  mismatched: { field: string; options: string[] }[];
}

/** What `POST /api/boards/:repoId/setup` answers. */
export interface BoardSetupResult {
  created: string[];
  mismatched: BoardSetupStatus["mismatched"];
  labelsCreated: string[];
}

export const BOARD_READY = "Board ready";
export const SET_UP_BOARD = "Set up board";
export const CREATE_LABELS = "Create missing labels";
export const LABELS_ALL_PRESENT = "Labels: all present";

export const missingLine = (s: BoardSetupStatus): string => `Missing: ${s.missing.join(", ")}`;

export const missingLabelsLine = (s: BoardSetupStatus): string =>
  `Labels missing: ${s.missingLabels.join(", ")}`;

/** Ready only when no field and no type label is missing (#132). */
export const isReady = (s: BoardSetupStatus): boolean =>
  s.missing.length === 0 && s.missingLabels.length === 0;

/** The status lines: what is missing, or that the board is ready. */
export const statusLines = (s: BoardSetupStatus): string[] =>
  isReady(s)
    ? [BOARD_READY]
    : [
        ...(s.missing.length > 0 ? [missingLine(s)] : []),
        ...(s.missingLabels.length > 0 ? [missingLabelsLine(s)] : []),
      ];

export const mismatchLine = (m: BoardSetupStatus["mismatched"][number]): string =>
  `Warning: field ${m.field} exists with other options (${m.options.join(", ")}); it is left alone.`;

/** The outward write, named exactly: the missing fields and the missing type labels. */
export const confirmText = (github: string, s: BoardSetupStatus): string => {
  const parts = [
    ...(s.missing.length > 0 ? [`the project fields ${s.missing.join(", ")}`] : []),
    ...(s.missingLabels.length > 0 ? [`the labels ${s.missingLabels.join(", ")}`] : []),
  ];
  return `This writes to GitHub. On ${github} it creates ${parts.join(" and ")}. It changes no item, no other field and no label that exists.`;
};

export function resultLines(r: BoardSetupResult): string[] {
  return [
    ...(r.created.length > 0 ? [`Created fields: ${r.created.join(", ")}`] : []),
    r.labelsCreated.length > 0
      ? `Created labels: ${r.labelsCreated.join(", ")}`
      : LABELS_ALL_PRESENT,
    ...r.mismatched.map(mismatchLine),
  ];
}
