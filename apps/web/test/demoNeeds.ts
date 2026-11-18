/**
 * Demo's Needs you: three questions (a design sign-off with a before/after pair and a plan, a pick
 * between pictured options, a plain question), the pictures kept for them and the discussions.
 * All invented; every picture route is answered with the one demo PNG.
 */
import type {
  AttentionItem,
  AttentionMaterialImage,
  AttentionMaterials,
  QuestionClosure,
} from "@mc/core";
import { DEMO_REPO } from "./demoSeedPages.ts";
import { HOUR, MIN, NOW } from "./fixtures.ts";

export const DEMO_DESIGN_KEY = "demo-design-signoff";
export const DEMO_PICTURES_KEY = "demo-picture-options";
export const DEMO_PLAIN_KEY = "demo-plain-question";
export const DEMO_ARRIVING_KEY = "demo-new-question";

const hex = (c: string) => c.repeat(64);
const SHA = "b".repeat(40);

const image = (c: string, label: string): AttentionMaterialImage => ({
  id: hex(c),
  path: `design/${label.toLowerCase().replaceAll(" ", "-")}.png`,
  label,
  mediaType: "image/png",
  sha256: hex(c),
  url: `/api/attention-material-assets/${hex(c)}`,
  size: 4096,
});

const packet = (
  key: string,
  ticket: number,
  over: Partial<AttentionMaterials>,
): AttentionMaterials => ({
  id: `demo-packet-${key}`,
  itemKey: key,
  repoId: DEMO_REPO,
  sourceCommit: SHA,
  sourcePath: null,
  label: `shop-app#${ticket} mockups`,
  registeredAt: NOW - 40 * MIN,
  briefId: null,
  sourceRevision: null,
  markdown: "",
  images: [],
  story: null,
  optionImages: [],
  historical: false,
  historicalReason: null,
  ...over,
});

/** What each question has retained, by item key. */
export const demoMaterials = (): Record<string, { packets: AttentionMaterials[] }> => ({
  [DEMO_DESIGN_KEY]: {
    packets: [
      packet(DEMO_DESIGN_KEY, 104, {
        images: [image("1", "Today"), image("2", "Before"), image("3", "Proposed")],
        story: [
          {
            heading: "The address form today",
            text: "On a phone the postcode lookup pushes the street field below the fold.",
            images: [{ imageId: hex("1"), caption: "Today, 390 pixels wide" }],
            comparison: null,
            children: [
              {
                heading: "What would change",
                text: "The lookup folds under the postcode and the form switches layout at 720 pixels.",
                images: [
                  { imageId: hex("2"), caption: "Before" },
                  { imageId: hex("3"), caption: "Proposed" },
                ],
                comparison: "before-after",
                children: [],
              },
            ],
          },
        ],
      }),
    ],
  },
  // A question with nothing retained still answers, with no packets.
  [DEMO_PLAIN_KEY]: { packets: [] },
  [DEMO_ARRIVING_KEY]: { packets: [] },
  [DEMO_PICTURES_KEY]: {
    packets: [
      packet(DEMO_PICTURES_KEY, 105, {
        images: [image("4", "Corner badge"), image("5", "Banner badge")],
        story: [
          {
            heading: "Two ways to show stock",
            text: "Both read well at card size; they differ in how much of the photo they cover.",
            images: [
              { imageId: hex("4"), caption: "Corner badge" },
              { imageId: hex("5"), caption: "Banner badge" },
            ],
            comparison: "options",
            children: [],
          },
        ],
        optionImages: [
          { optionId: "corner", imageIds: [hex("4")] },
          { optionId: "banner", imageIds: [hex("5")] },
        ],
      }),
    ],
  },
});

const base = { tool: null, acked: false, owner: "operator", repoId: DEMO_REPO } as const;

const brief = (over: Partial<NonNullable<AttentionItem["brief"]>>) => ({
  basis: "Read the ticket and the open pull request.",
  at: NOW - 30 * MIN,
  for: "operator" as const,
  ...over,
  context: over.context ?? "",
  recommendation: over.recommendation ?? "",
  options: over.options ?? [],
});

/** The questions waiting on the operator, newest last. */
export function demoAttention(): AttentionItem[] {
  return [
    {
      ...base,
      key: DEMO_DESIGN_KEY,
      kind: "question",
      agentId: "dev-4",
      text: "Which layout should the address form use on a phone?",
      at: NOW - 40 * MIN,
      url: null,
      escalationId: null,
      ticket: `${DEMO_REPO}#104`,
      offers: ["not-now", "drop"],
      brief: brief({
        title: "Sign off the address form layout on narrow screens",
        looks: true,
        context: "The postcode lookup pushes the street field below the fold on a phone.",
        ask: "Is the proposed layout, with the lookup under the postcode, the one to build?",
        recommendation: "Build the proposed layout: it keeps both fields on screen at 390 pixels.",
        recommendedOptionId: "proposed",
        options: [
          { id: "proposed", label: "Proposed layout", answer: "Build the proposed layout." },
          { id: "keep", label: "Keep today's", answer: "Keep the layout as it is." },
        ],
      }),
    },
    {
      ...base,
      key: DEMO_PICTURES_KEY,
      kind: "question",
      agentId: "dev-5",
      text: "Which stock badge should the product cards carry?",
      at: NOW - 25 * MIN,
      url: null,
      escalationId: null,
      ticket: `${DEMO_REPO}#105`,
      brief: brief({
        title: "Pick the stock badge for product cards",
        looks: true,
        context: "Two badge designs are ready; both are shown against a real card.",
        ask: "Which badge should ship?",
        recommendation: "The corner badge covers less of the photo.",
        recommendedOptionId: "corner",
        options: [
          { id: "corner", label: "Corner badge", answer: "Ship the corner badge." },
          { id: "banner", label: "Banner badge", answer: "Ship the banner badge." },
        ],
      }),
    },
    {
      ...base,
      key: DEMO_PLAIN_KEY,
      kind: "question",
      agentId: "dev-7",
      text: "Should the CSV export use the shop's date format or ISO dates?",
      at: NOW - 12 * MIN,
      url: null,
      escalationId: null,
      ticket: `${DEMO_REPO}#107`,
      brief: brief({
        title: "Choose the date format for the CSV export",
        context: "Accountants open the file in a spreadsheet; ISO dates sort, local ones read.",
        ask: "Which date format should the export use?",
        recommendation: "ISO dates: they sort the same in every spreadsheet.",
        recommendedOptionId: "iso",
        options: [
          { id: "iso", label: "ISO dates", answer: "Use ISO dates (2026-11-13)." },
          { id: "local", label: "Shop format", answer: "Use the shop's date format (13/11/2026)." },
        ],
      }),
    },
  ];
}

/** A question that arrives while Demo plays. */
export const demoArriving = (at: number): AttentionItem => ({
  ...base,
  key: DEMO_ARRIVING_KEY,
  kind: "question",
  agentId: "dev-2",
  text: "Retry failed payment webhooks three times or five?",
  at,
  url: null,
  escalationId: null,
  ticket: `${DEMO_REPO}#102`,
  brief: brief({
    title: "Choose the retry count for payment webhooks",
    at,
    context: "The provider gives up after an hour; five tries fit inside it.",
    ask: "How many times should a failed webhook be retried?",
    recommendation: "Five, spaced out.",
    recommendedOptionId: "five",
    options: [
      { id: "three", label: "Three tries", answer: "Retry three times." },
      { id: "five", label: "Five tries", answer: "Retry five times, spaced out." },
    ],
  }),
});

/** What the operator has already settled today, so Answered is not empty. */
export const demoAnswered = (): QuestionClosure[] => [
  {
    key: "demo-answered-1",
    askAt: NOW - 3 * HOUR,
    kind: "cleared",
    reason: "Answered: keep the cart total in pence.",
    by: "dev-3",
    question: "Keep the cart total in pence or switch to decimals?",
    ticket: `${DEMO_REPO}#103`,
    operator: true,
    at: NOW - 2 * HOUR,
  },
];

/** An empty discussion for each question, so its thread reads as a conversation not yet begun. */
export function demoDiscussions(keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    keys.flatMap((key) => {
      const thread = { id: `discussion:${key}`, itemKey: key, version: "demo-v1", messages: [] };
      const path = `/api/attention/${encodeURIComponent(key)}/discussion`;
      return [
        [path, thread],
        [`${path}?id=${encodeURIComponent(thread.id)}`, thread],
      ];
    }),
  );
}
