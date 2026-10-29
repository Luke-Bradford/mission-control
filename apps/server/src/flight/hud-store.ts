/** Durable, private storage for FLIGHT's HUD screenshots, cited in tickets by an opaque id. */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Newest screenshots kept; older ones are removed when a new one is stored. */
export const HUD_SHOT_KEEP = 50;
/** A stored screenshot expires after a week. */
export const HUD_SHOT_MAX_AGE_MS = 7 * 86_400_000;
/** The opaque id: 128 random bits as hex. Anything else is never turned into a path. */
export const HUD_SHOT_ID = /^[0-9a-f]{32}$/;
/** What a stored screenshot is cited as in a ticket: this prefix and the id. */
export const HUD_SHOT_REF_PREFIX = "hud-shot:";

export interface HudShotStore {
  save(png: Buffer): string;
  read(id: string): Buffer | null;
}

export function hudShotStore(
  dir: string,
  opts: { now?: () => number; keep?: number; maxAgeMs?: number } = {},
): HudShotStore {
  const now = opts.now ?? Date.now;
  const keep = opts.keep ?? HUD_SHOT_KEEP;
  const maxAgeMs = opts.maxAgeMs ?? HUD_SHOT_MAX_AGE_MS;
  const fileOf = (id: string): string => join(dir, `${id}.png`);

  const prune = (): void => {
    const at = now();
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".png") && HUD_SHOT_ID.test(f.slice(0, -4)))
      .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    files.forEach(({ f, mtime }, i) => {
      if (i >= keep || at - mtime > maxAgeMs) {
        try {
          unlinkSync(join(dir, f));
        } catch {
          // Already gone.
        }
      }
    });
  };

  return {
    save(png) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700); // tighten a directory that already existed, too
      const id = randomBytes(16).toString("hex");
      writeFileSync(fileOf(id), png, { mode: 0o600, flag: "wx" });
      prune();
      return id;
    },
    read(id) {
      if (!HUD_SHOT_ID.test(id)) return null;
      try {
        const file = fileOf(id);
        if (now() - statSync(file).mtimeMs > maxAgeMs) return null;
        return readFileSync(file);
      } catch {
        return null;
      }
    },
  };
}
