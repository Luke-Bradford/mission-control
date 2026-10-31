import type { Raster } from "../src/pr-evidence/png.ts";

/** A solid-colour raster with filled boxes: a stand-in for a page. */
export function fixtureRaster(
  width: number,
  height: number,
  boxes: { x: number; y: number; w: number; h: number; rgb: [number, number, number] }[] = [],
  background: [number, number, number] = [250, 250, 250],
): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data.set([...background, 255], i * 4);
  }
  for (const b of boxes)
    for (let y = b.y; y < b.y + b.h; y++)
      for (let x = b.x; x < b.x + b.w; x++) data.set([...b.rgb, 255], (y * width + x) * 4);
  return { width, height, data };
}
