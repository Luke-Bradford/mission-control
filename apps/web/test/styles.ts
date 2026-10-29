import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "../src");

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? cssFiles(join(dir, entry.name)) : [join(dir, entry.name)],
    )
    .filter((file) => file.endsWith(".css"));
}

/**
 * Every stylesheet of the app as one text: `hud.css` (tokens, resets, shell layout) first, then
 * the page and component sheets in path order. For a test that asks whether a rule exists, not
 * where the cascade puts it; a test about one block or its order reads that sheet with `readStyle`.
 */
export function readStyles(): string {
  const hud = join(SRC, "hud.css");
  return [
    hud,
    ...cssFiles(SRC)
      .filter((file) => file !== hud)
      .sort(),
  ]
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
}

/** One stylesheet, by its path under `src` (`board/board.css`). */
export function readStyle(path: string): string {
  return readFileSync(join(SRC, path), "utf8");
}
