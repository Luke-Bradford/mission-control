/** PNG decode and encode, and the pixel diff behind a PR's before/after screenshots. */
import { crc32, deflateSync, inflateSync } from "node:zlib";
import type { EvidenceRegion } from "@mc/core";

export interface Raster {
  width: number;
  height: number;
  /** RGBA, row by row. */
  data: Uint8Array;
}

/** An image over this many pixels is refused, so a hostile file cannot make the diff allocate. */
export const PNG_MAX_PIXELS = 16_000_000;
/** A pixel counts as changed when its channels differ by more than this in total. */
export const PIXEL_TOLERANCE = 24;
/** Changes are grouped on a grid of cells this many pixels square. */
export const REGION_CELL = 16;
/** The most regions a diff lists; the largest come first. */
export const REGIONS_MAX = 20;
/** What a changed pixel is painted in the diff image. */
const CHANGED_RGB = [255, 0, 64] as const;

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Colour type to channels per pixel: truecolour and truecolour with alpha. */
const CHANNELS: Record<number, number> = { 2: 3, 6: 4 };

/** Reads an 8-bit, non-interlaced RGB or RGBA PNG (what Chrome writes). */
export function decodePng(bytes: Uint8Array): Raster {
  const buf = Buffer.from(bytes);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG file");
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= buf.length; ) {
    const size = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + size);
    if (body.length < size) throw new Error("PNG chunk is cut short");
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      channels = CHANNELS[body[9] ?? 0] ?? 0;
      if (body[8] !== 8 || channels === 0 || body[12] !== 0)
        throw new Error("PNG must be 8-bit RGB or RGBA, not interlaced");
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    at += 12 + size;
  }
  if (width === 0 || height === 0 || width * height > PNG_MAX_PIXELS)
    throw new Error("PNG has no usable size");
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error("PNG pixel data is cut short");
  const data = new Uint8Array(width * height * 4);
  const line = new Uint8Array(stride);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? (line[i - channels] ?? 0) : 0;
      const b = prev[i] ?? 0;
      const c = i >= channels ? (prev[i - channels] ?? 0) : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error("PNG uses an unknown filter");
      line[i] = ((src[i] ?? 0) + add) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      data[o] = line[x * channels] ?? 0;
      data[o + 1] = line[x * channels + 1] ?? 0;
      data[o + 2] = line[x * channels + 2] ?? 0;
      data[o + 3] = channels === 4 ? (line[x * channels + 3] ?? 255) : 255;
    }
    prev = Uint8Array.from(line);
  }
  return { width, height, data };
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

/** Writes an RGBA PNG. */
export function encodePng(r: Raster): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(r.width, 0);
  header.writeUInt32BE(r.height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = r.width * 4;
  const raw = Buffer.alloc((stride + 1) * r.height);
  for (let y = 0; y < r.height; y++)
    raw.set(r.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export interface ImageDiff {
  /** The after image dimmed, with each changed pixel painted red. */
  png: Buffer;
  changedPixels: number;
  /** Of the larger of the two images, to two decimals. */
  changedPercent: number;
  regions: EvidenceRegion[];
}

/**
 * Compares two screenshots pixel by pixel. Where the sizes differ the larger canvas is compared and
 * the part outside the smaller image counts as changed.
 */
export function diffImages(before: Raster, after: Raster): ImageDiff {
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const out = new Uint8Array(width * height * 4);
  const cols = Math.ceil(width / REGION_CELL);
  const rows = Math.ceil(height / REGION_CELL);
  /** Pixel bounds of the changes in each cell: minX, minY, maxX, maxY; minX -1 for none. */
  const bounds = new Int32Array(cols * rows * 4).fill(-1);
  let changedPixels = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const inB = x < before.width && y < before.height;
      const inA = x < after.width && y < after.height;
      let changed = !(inB && inA);
      if (!changed) {
        const b = (y * before.width + x) * 4;
        const a = (y * after.width + x) * 4;
        const delta =
          Math.abs((before.data[b] ?? 0) - (after.data[a] ?? 0)) +
          Math.abs((before.data[b + 1] ?? 0) - (after.data[a + 1] ?? 0)) +
          Math.abs((before.data[b + 2] ?? 0) - (after.data[a + 2] ?? 0));
        changed = delta > PIXEL_TOLERANCE;
      }
      if (changed) {
        changedPixels += 1;
        out.set([...CHANGED_RGB, 255], o);
        const cell = ((y / REGION_CELL) | 0) * cols + ((x / REGION_CELL) | 0);
        const k = cell * 4;
        if (bounds[k] === -1) {
          bounds[k] = x;
          bounds[k + 1] = y;
          bounds[k + 2] = x;
          bounds[k + 3] = y;
        } else {
          bounds[k] = Math.min(bounds[k] ?? x, x);
          bounds[k + 1] = Math.min(bounds[k + 1] ?? y, y);
          bounds[k + 2] = Math.max(bounds[k + 2] ?? x, x);
          bounds[k + 3] = Math.max(bounds[k + 3] ?? y, y);
        }
      } else if (inA) {
        // unchanged: the after pixel faded towards white, so the red reads
        const a = (y * after.width + x) * 4;
        for (let c = 0; c < 3; c++) out[o + c] = ((after.data[a + c] ?? 0) + 255 * 3) >> 2;
        out[o + 3] = 255;
      } else out.set([255, 255, 255, 255], o);
    }
  }
  return {
    png: encodePng({ width, height, data: out }),
    changedPixels,
    changedPercent: Math.round((changedPixels / (width * height)) * 10_000) / 100,
    regions: regionsOf(bounds, cols, rows),
  };
}

/** Joins touching changed cells (diagonals too) and returns each group's pixel bounding box. */
function regionsOf(bounds: Int32Array, cols: number, rows: number): EvidenceRegion[] {
  const label = new Int32Array(cols * rows).fill(-1);
  const found: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (let start = 0; start < label.length; start++) {
    if (bounds[start * 4] === -1 || label[start] !== -1) continue;
    const box = { x0: Infinity, y0: Infinity, x1: -1, y1: -1 };
    const todo = [start];
    label[start] = found.length;
    while (todo.length > 0) {
      const cell = todo.pop() as number;
      const k = cell * 4;
      box.x0 = Math.min(box.x0, bounds[k] ?? 0);
      box.y0 = Math.min(box.y0, bounds[k + 1] ?? 0);
      box.x1 = Math.max(box.x1, bounds[k + 2] ?? 0);
      box.y1 = Math.max(box.y1, bounds[k + 3] ?? 0);
      const cx = cell % cols;
      const cy = (cell - cx) / cols;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const next = ny * cols + nx;
          if (bounds[next * 4] === -1 || label[next] !== -1) continue;
          label[next] = found.length;
          todo.push(next);
        }
      }
    }
    found.push(box);
  }
  return found
    .map((b) => ({ x: b.x0, y: b.y0, width: b.x1 - b.x0 + 1, height: b.y1 - b.y0 + 1 }))
    .sort((a, b) => b.width * b.height - a.width * a.height)
    .slice(0, REGIONS_MAX);
}
