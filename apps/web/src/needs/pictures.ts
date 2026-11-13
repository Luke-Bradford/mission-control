import type { AttentionBrief, AttentionItem } from "@mc/core";
import { openableHref } from "../links.ts";

/** Where a picture comes from and so how it is fetched: the hub needs no token, the rest do. */
export interface PictureRoute {
  path: string;
  auth: "hub" | "operator";
}

const REPO = "[A-Za-z0-9][A-Za-z0-9._-]*";
/** The image routes of `apps/server/src/api.ts`, each matched whole; nothing else is a picture. */
const ROUTES: readonly { re: RegExp; auth: PictureRoute["auth"] }[] = [
  {
    // PR evidence: /api/prs/:n/evidence/:sha/:name, with an optional ?repo=
    re: new RegExp(
      `^/api/prs/[1-9]\\d{0,9}/evidence/[0-9a-f]{40}/[a-z_]+-(?:light|dark)-(?:before|after|diff)\\.png(?:\\?repo=${REPO})?$`,
    ),
    auth: "hub",
  },
  { re: /^\/api\/hud-screenshots\/[0-9a-f]{32}$/, auth: "operator" },
  { re: /^\/api\/qa\/review-shots\/[0-9a-f]{32}$/, auth: "operator" },
  { re: /^\/api\/qa-report-assets\/[0-9a-f]{64}$/, auth: "operator" },
  { re: /^\/api\/attention-material-assets\/[0-9a-f]{64}$/, auth: "operator" },
];

/** The route a picture URL names, or null when it is not one the hub serves (it is a link then). */
export function pictureRoute(url: string): PictureRoute | null {
  const text = url.trim();
  for (const r of ROUTES) if (r.re.test(text)) return { path: text, auth: r.auth };
  return null;
}

/** The text of a brief that can carry links and pictures, in reading order. */
function briefTexts(item: AttentionItem): string[] {
  const b: AttentionBrief | undefined = item.brief;
  const texts = [
    item.text,
    b?.original,
    b?.assessment,
    b?.context,
    b?.ask,
    b?.recommendation,
    ...(b?.options.flatMap((o) => [o.label, o.description, o.answer]) ?? []),
    ...(b?.did?.map((d) => d.action) ?? []),
    ...(b?.catchUp?.story ?? []),
    ...(b?.catchUp?.aware ?? []),
    ...(b?.checked?.map((c) => c.finding) ?? []),
  ];
  return texts.filter((t): t is string => typeof t === "string" && t !== "");
}

const IMAGE = /!\[([^\]\n]*)\]\(([^)\s]+)\)/g;
const LINK = /(?<!!)\[([^\]\n]+)\]\(([^)\s]+)\)/g;
const BARE = /https?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"]/g;

/** Every `![label](url)` in the brief, once each by URL. */
export function briefPictures(item: AttentionItem): { label: string; url: string }[] {
  const seen = new Set<string>();
  const out: { label: string; url: string }[] = [];
  for (const text of briefTexts(item)) {
    for (const m of text.matchAll(IMAGE)) {
      const url = m[2] ?? "";
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ label: (m[1] ?? "").trim() || "Picture", url });
    }
  }
  return out;
}

/**
 * Every link the operator can follow from an item: the item's own URL, links and bare URLs in its
 * brief, and a person item's related references, once each. A picture that cannot be shown is a
 * link; one that can is not repeated here.
 */
export function briefLinks(item: AttentionItem): { label: string; url: string }[] {
  const seen = new Set<string>();
  const out: { label: string; url: string }[] = [];
  const add = (label: string, url: string) => {
    if (seen.has(url) || pictureRoute(url)) return;
    seen.add(url);
    out.push({ label, url });
  };
  if (item.url) add("Open on GitHub", item.url);
  for (const text of briefTexts(item)) {
    for (const m of text.matchAll(LINK)) add((m[1] ?? "").trim(), m[2] ?? "");
    for (const m of text.matchAll(IMAGE)) add((m[1] ?? "").trim() || "Picture", m[2] ?? "");
    const rest = text.replace(IMAGE, " ").replace(LINK, " ");
    for (const m of rest.matchAll(BARE)) add(m[0], m[0]);
  }
  for (const l of item.brief?.links ?? []) add(l.label.trim() || l.url, l.url);
  for (const ref of item.brief?.person?.related ?? []) if (ref.url) add(ref.label, ref.url);
  return out;
}

/** Whether a link may be followed; the Links section shows the rest as refused text. */
export const isOpenable = (url: string): boolean => openableHref(url) !== null;
