import { readFileSync } from "node:fs";
import { QA_DISCLOSURE_LABEL, QA_TAB_LABELS, QA_VIEW_LABEL } from "@mc/core";
import { expect, it } from "vitest";

/**
 * The evidence capture finds the Audit page's controls by the page's own text. The page is in
 * apps/web, so this reads its source: renaming a label on either side fails here, not in a live
 * capture three days later (#1426).
 */
const source = (path: string): string =>
  readFileSync(new URL(`../../web/src/${path}`, import.meta.url), "utf8");

it("the Audit page still shows the disclosure the capture clicks", () => {
  expect(source("code-health/CodeHealth.tsx")).toMatch(
    new RegExp(`\\n\\s*${QA_DISCLOSURE_LABEL}\\s*\\n\\s*</button>`),
  );
});

it("the Audit page still names the QA view and its tabs as the capture expects", () => {
  const legacy = source("pages/LegacyAudit.tsx");
  expect(legacy).toContain(`<Seg label="${QA_VIEW_LABEL}"`);
  for (const label of Object.values(QA_TAB_LABELS)) expect(legacy).toContain(`label: "${label}"`);
});
