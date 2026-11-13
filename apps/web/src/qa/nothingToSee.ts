import { prEvidenceAffectedPages } from "@mc/core";

/** Said where a change has no screen, so an empty image area is not read as missing evidence. */
export const NOTHING_TO_SEE = "Nothing to see: this change has no screen.";

/** True when the changed paths are known and touch no page of the app. */
export const changeHasNoScreen = (files: readonly string[] | undefined): boolean =>
  files !== undefined && files.length > 0 && prEvidenceAffectedPages(files).length === 0;
