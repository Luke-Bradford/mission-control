import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// These are fixture advertisements, not a baked-in production model or effort catalog.
export const CODEX_MODELS = [
  { model: "gpt-6-astra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { model: "gpt-5.6-sol", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { model: "gpt-5.6-terra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { model: "gpt-5.6-luna", efforts: ["low", "medium", "high", "xhigh", "max"] },
];
export const MODEL_PAGES = CODEX_MODELS.map(({ model, efforts }, i) => ({
  data: [
    { model, supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })) },
  ],
  nextCursor: i === CODEX_MODELS.length - 1 ? null : `page-${i + 1}`,
}));

export function fakeModels(scenario: object = { pages: MODEL_PAGES }) {
  const dir = mkdtempSync(join(tmpdir(), "mc-model-fixture-"));
  const authPath = join(dir, "auth.json");
  const record = join(dir, "record.jsonl");
  writeFileSync(authPath, '{"fake":"auth"}', { mode: 0o600 });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  return {
    deps: {
      authPath,
      spawn: ((_command, _args, options) =>
        spawn(process.execPath, [join(import.meta.dirname, "fixtures/fake-codex-models.mjs")], {
          ...options,
          env: {
            ...options?.env,
            FAKE_MODELS_SCENARIO: JSON.stringify(scenario),
            FAKE_MODELS_RECORD: record,
          },
        })) as typeof spawn,
    },
    records: (): Record<string, unknown>[] =>
      readFileSync(record, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}
