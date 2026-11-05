import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVIDENCE_PAGES, EVIDENCE_SCHEMES } from "@mc/core";
import { afterEach, expect, it } from "vitest";
import { probeEvidencePages } from "../src/pr-evidence/probe.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

it("renders every page in both schemes, saves each image and counts the failures", async () => {
  const out = mkdtempSync(join(tmpdir(), "mc-probe-"));
  dirs.push(out);
  const lines: string[] = [];
  const failed = await probeEvidencePages({
    origin: "http://127.0.0.1:7420",
    out,
    log: (l) => lines.push(l),
    render: async (url, scheme) => {
      if (url.endsWith("/board") && scheme === "dark") throw new Error("hung");
      return Buffer.from(`${url} ${scheme}`);
    },
  });
  expect(failed).toBe(1);
  expect(existsSync(join(out, "board-dark.png"))).toBe(false);
  expect(readFileSync(join(out, "map-light.png"), "utf8")).toBe("http://127.0.0.1:7420/map light");
  expect(lines.filter((l) => l.startsWith("ok"))).toHaveLength(
    EVIDENCE_PAGES.length * EVIDENCE_SCHEMES.length - 1,
  );
  expect(lines.some((l) => /^FAILED board dark \d+ ms: hung$/.test(l))).toBe(true);
  expect(lines.at(-1)).toMatch(/^1 failed; total \d+ ms$/);
});
