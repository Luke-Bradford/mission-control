import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodePng, diffImages, encodePng, type Raster } from "../src/pr-evidence/png.ts";
import { fixtureRaster } from "./pr-evidence-fixture.ts";

/** A PNG whose rows use filters 0 to 4 in turn, the way Chrome writes them. */
function filteredPng(r: Raster): Buffer {
  const stride = r.width * 4;
  const rows: number[] = [];
  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < r.height; y++) {
    const filter = y % 5;
    rows.push(filter);
    for (let i = 0; i < stride; i++) {
      const cur = r.data[y * stride + i] ?? 0;
      const a = i >= 4 ? (r.data[y * stride + i - 4] ?? 0) : 0;
      const b = y > 0 ? (r.data[(y - 1) * stride + i] ?? 0) : 0;
      const c = y > 0 && i >= 4 ? (r.data[(y - 1) * stride + i - 4] ?? 0) : 0;
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter] ?? 0;
      rows.push((cur - pred) & 0xff);
    }
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "latin1");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(r.width, 0);
  header.writeUInt32BE(r.height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("png", () => {
  it("round-trips a raster through encode and decode", () => {
    const r = fixtureRaster(40, 30, [{ x: 5, y: 5, w: 10, h: 10, rgb: [200, 20, 20] }]);
    const back = decodePng(encodePng(r));
    expect(back.width).toBe(40);
    expect(back.height).toBe(30);
    expect(Buffer.from(back.data).equals(Buffer.from(r.data))).toBe(true);
  });

  it("decodes rows written with every filter type", () => {
    const r = fixtureRaster(23, 17, [{ x: 3, y: 2, w: 9, h: 9, rgb: [12, 99, 200] }]);
    r.data[5] = 77;
    r.data[200] = 3;
    expect(Buffer.from(decodePng(filteredPng(r)).data).equals(Buffer.from(r.data))).toBe(true);
  });

  it("refuses bytes that are not a PNG", () => {
    expect(() => decodePng(Buffer.from("not a png"))).toThrow(/PNG/);
  });
});

describe("diffImages", () => {
  const box = { x: 32, y: 32, w: 40, h: 20, rgb: [10, 10, 10] as [number, number, number] };

  it("finds nothing in identical images", () => {
    const a = fixtureRaster(200, 100, [box]);
    const d = diffImages(a, a);
    expect(d.changedPixels).toBe(0);
    expect(d.changedPercent).toBe(0);
    expect(d.regions).toEqual([]);
  });

  it("a moved box gives one changed region and a diff image", () => {
    const before = fixtureRaster(200, 100, [box]);
    const after = fixtureRaster(200, 100, [{ ...box, x: 112 }]);
    const d = diffImages(before, after);
    // the old and the new position both changed: two areas far apart
    expect(d.regions).toHaveLength(2);
    expect(d.changedPixels).toBe(2 * 40 * 20);
    expect(d.changedPercent).toBeCloseTo((1600 / 20000) * 100, 1);
    const [first] = d.regions;
    expect(first?.width).toBeGreaterThanOrEqual(40);
    const image = decodePng(d.png);
    expect(image.width).toBe(200);
    expect(image.height).toBe(100);
    // the changed pixels are painted red in the diff image
    const at = (112 + 5 + (32 + 5) * 200) * 4;
    expect([image.data[at], image.data[at + 1], image.data[at + 2]]).toEqual([255, 0, 64]);
  });

  it("merges neighbouring changes into one region", () => {
    const before = fixtureRaster(200, 100);
    const after = fixtureRaster(200, 100, [
      { x: 50, y: 40, w: 4, h: 4, rgb: [0, 0, 0] },
      { x: 60, y: 40, w: 4, h: 4, rgb: [0, 0, 0] },
    ]);
    expect(diffImages(before, after).regions).toHaveLength(1);
  });

  it("counts the area outside a smaller image as changed", () => {
    const d = diffImages(fixtureRaster(100, 50), fixtureRaster(100, 80));
    expect(d.changedPixels).toBe(100 * 30);
    expect(d.regions).toHaveLength(1);
  });

  it("ignores a difference too small to see", () => {
    const d = diffImages(
      fixtureRaster(50, 50, [], [250, 250, 250]),
      fixtureRaster(50, 50, [], [251, 250, 250]),
    );
    expect(d.changedPixels).toBe(0);
  });
});
