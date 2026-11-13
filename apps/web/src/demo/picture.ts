/**
 * The pictures Demo serves for every image route: small mock screens drawn here, so a design
 * question shows something to compare. Which one comes from the asset id; no file is fetched.
 */

type Rect = readonly [x: number, y: number, w: number, h: number, colour: number];

const W = 240;
const H = 320;
const BG = 0x20262e;
const BAR = 0x2f6fed;
const FIELD = 0x39424e;
const LABEL = 0x7b8794;
const CARD = 0x2a313a;
const PHOTO = 0x4a5a6a;
const GOOD = 0x2e9d5b;
const WARN = 0xd8892b;

/** A phone-width form: header bar, then labelled fields. `fold` gives the lookup its own row. */
const form = (rows: readonly (readonly [h: number, colour: number])[]): Rect[] => {
  const out: Rect[] = [[0, 0, W, 28, BAR]];
  let y = 40;
  for (const [h, colour] of rows) {
    out.push([16, y, 80, 6, LABEL], [16, y + 12, W - 32, h, colour]);
    y += h + 30;
  }
  out.push([16, Math.min(y, H - 40), W - 32, 24, BAR]);
  return out;
};

const PICTURES: Record<string, readonly Rect[]> = {
  // Today: the lookup button crowds the postcode field and pushes the street field down.
  today: form([
    [24, FIELD],
    [24, WARN],
    [24, FIELD],
    [24, FIELD],
  ]),
  before: form([
    [24, FIELD],
    [24, WARN],
    [60, FIELD],
    [24, FIELD],
  ]),
  proposed: [
    ...form([
      [24, FIELD],
      [24, FIELD],
      [24, FIELD],
    ]),
    [160, 52, 64, 24, GOOD],
  ],
  corner: [
    [20, 20, W - 40, 150, CARD],
    [28, 28, W - 56, 110, PHOTO],
    [28, 28, 56, 20, GOOD],
    [28, 180, 140, 8, LABEL],
    [28, 196, 90, 8, FIELD],
  ],
  banner: [
    [20, 20, W - 40, 150, CARD],
    [28, 28, W - 56, 110, PHOTO],
    [28, 100, W - 56, 24, GOOD],
    [28, 180, 140, 8, LABEL],
    [28, 196, 90, 8, FIELD],
  ],
  generic: [
    [0, 0, W, 28, BAR],
    [16, 44, W - 32, 90, CARD],
    [16, 146, 100, 70, PHOTO],
    [128, 146, 96, 70, FIELD],
    [16, 228, W - 32, 8, LABEL],
    [16, 244, 140, 8, LABEL],
  ],
};

/** The picture an asset id shows: the five story pictures by their first character, else a page. */
export function pictureFor(path: string): keyof typeof PICTURES {
  const id = path.split("?")[0]?.split("/").pop() ?? "";
  const named = { "1": "today", "2": "before", "3": "proposed", "4": "corner", "5": "banner" }[
    id.charAt(0)
  ];
  return id.length === 64 && /^(.)\1+$/.test(id) && named
    ? (named as keyof typeof PICTURES)
    : "generic";
}

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const x of bytes) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const be32 = (n: number): number[] => [
  (n >>> 24) & 255,
  (n >>> 16) & 255,
  (n >>> 8) & 255,
  n & 255,
];

function chunk(type: string, data: Uint8Array): number[] {
  const body = new Uint8Array([...[...type].map((c) => c.charCodeAt(0)), ...data]);
  return [...be32(data.length), ...body, ...be32(crc32(body))];
}

/** A PNG of the named picture: raw rows inside stored deflate blocks, so no compressor is needed. */
export function pictureBytes(name: keyof typeof PICTURES): Uint8Array<ArrayBuffer> {
  const raw = new Uint8Array((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    const row = y * (W * 3 + 1);
    for (let x = 0; x < W; x++) {
      raw[row + 1 + x * 3] = (BG >> 16) & 255;
      raw[row + 2 + x * 3] = (BG >> 8) & 255;
      raw[row + 3 + x * 3] = BG & 255;
    }
  }
  for (const [rx, ry, rw, rh, colour] of PICTURES[name] as readonly Rect[])
    for (let y = ry; y < Math.min(H, ry + rh); y++)
      for (let x = rx; x < Math.min(W, rx + rw); x++) {
        const at = y * (W * 3 + 1) + 1 + x * 3;
        raw[at] = (colour >> 16) & 255;
        raw[at + 1] = (colour >> 8) & 255;
        raw[at + 2] = colour & 255;
      }
  const blocks: number[] = [0x78, 0x01];
  for (let i = 0; i < raw.length; i += 65535) {
    const part = raw.subarray(i, i + 65535);
    const last = i + 65535 >= raw.length ? 1 : 0;
    blocks.push(
      last,
      part.length & 255,
      part.length >> 8,
      ~part.length & 255,
      (~part.length >> 8) & 255,
    );
    for (const b of part) blocks.push(b);
  }
  blocks.push(...be32(adler32(raw)));
  const header = new Uint8Array([...be32(W), ...be32(H), 8, 2, 0, 0, 0]);
  return new Uint8Array([
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ...chunk("IHDR", header),
    ...chunk("IDAT", new Uint8Array(blocks)),
    ...chunk("IEND", new Uint8Array()),
  ]);
}
