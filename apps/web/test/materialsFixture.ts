import { deflateSync } from "node:zlib";
import type { AttentionMaterials } from "@mc/core";
import { brief, HOUR, item, NOW } from "./fixtures.ts";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc(body), 4 + body.length);
  return out;
}

/** A real PNG of a mock screen: a side list, a header and rows, in one hue so pictures differ. */
export function mockPng(hue: number, width = 1600, height = 1000): Buffer {
  const rgb = (h: number, l: number): [number, number, number] => {
    const a = 0.5 * Math.min(l, 1 - l);
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
  };
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const side = x < width * 0.28;
      const head = y < height * 0.12;
      const band = !side && !head && Math.floor((y - height * 0.12) / 90) % 2 === 0;
      const [r, g, b] = rgb(hue, side ? 0.78 : head ? 0.62 : band ? 0.9 : 0.96);
      const o = at + 1 + x * 3;
      rows[o] = r;
      rows[o + 1] = g;
      rows[o + 2] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const MAT_KEY = "decision:layout-story";
const idOf = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
export const assetUrl = (n: number) => `/api/attention-material-assets/${idOf(n)}`;

/** A three-level story, a before/after pair and two picture options (images 1 to 7). */
export function storyPacket(extra = 0): AttentionMaterials {
  const count = 7 + extra;
  const images = Array.from({ length: count }, (_, i) => ({
    id: idOf(i + 1),
    path: `docs/design/story/${i + 1}.png`,
    label: null,
    mediaType: "image/png" as const,
    sha256: idOf(i + 1),
    url: assetUrl(i + 1),
    size: 9000,
  }));
  const img = (n: number, caption: string) => ({ imageId: idOf(n), caption });
  const lorem =
    "Each row now carries its repository, its age and the one decision it needs, so the operator can scan the list without opening anything. ";
  return {
    id: "story",
    itemKey: MAT_KEY,
    repoId: "shop-app",
    sourceCommit: "c".repeat(40),
    sourcePath: null,
    label: "Needs you layout story",
    registeredAt: NOW - HOUR,
    briefId: null,
    sourceRevision: null,
    markdown: "",
    images,
    story: [
      {
        heading: "This page today",
        text: lorem.repeat(2),
        images: [img(1, "Live Needs you page")],
        comparison: null,
        children: [
          {
            heading: "What would change",
            text: lorem,
            images: [img(2, "Before"), img(3, "After")],
            comparison: "before-after",
            children: [
              {
                heading: "And the open question looks different here too",
                text: lorem,
                images: [img(4, "Open question, narrow dock")],
                comparison: null,
                children: [],
              },
            ],
          },
        ],
      },
      {
        heading: "Your choice",
        text: lorem.repeat(3),
        images: [],
        comparison: null,
        children: [],
      },
      ...Array.from({ length: extra }, (_, i) => ({
        heading: `Further view ${i + 1}`,
        text: lorem,
        images: [img(8 + i, `View ${i + 1}`)],
        comparison: null,
        children: [],
      })),
    ],
    optionImages: [
      { optionId: "a", imageIds: [idOf(5)] },
      { optionId: "b", imageIds: [idOf(6)] },
    ],
    historical: false,
    historicalReason: null,
  };
}

export const storyItem = () =>
  item({
    key: MAT_KEY,
    kind: "decision",
    agentId: "guido-1",
    escalationId: null,
    ticket: "shop-app#1513",
    offers: ["not-now", "drop"],
    text: "Which layout should Needs you use?",
    at: NOW - 2 * HOUR,
    brief: brief({
      ask: "Do you prefer the list and open item, or one long column?",
      recommendation: "List and open item.",
      recommendedOptionId: "a",
      options: [
        { id: "a", label: "List and open item", answer: "Use the list and open item." },
        { id: "b", label: "One long column", answer: "Use one long column." },
      ],
    }),
  });

export const planBody = `## Outcome\nShip it.\n\n## Plan\n${Array.from(
  { length: 14 },
  (_, i) =>
    `### Step ${i + 1}\n1. Read the existing component and its tests.\n2. Change it and keep [the spec](https://example.com/spec) linked.\n   - a nested point for step ${i + 1} that is long enough to wrap onto a second line in a narrow dock\n`,
).join("\n")}\n## Size\nM\n`;
