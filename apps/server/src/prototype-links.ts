/** A ticket's prototype must be readable by every crew seat from the repository. */
export const PRIVATE_PROTOTYPE_TEXT = "links a prototype outside docs/prototype/.";

const MARKDOWN_LINK = /\[([^\]]*)\]\(([^\s)]+)(?:\s+[^)]*)?\)/g;
const HTTP_URL = /https?:\/\/[^\s)>]+/g;
const PROTOTYPE = /\b(?:prototype|mockup)\b/i;

function inPrototypeDirectory(link: string): boolean {
  if (/(?:^|\/)docs\/prototype\//.test(link)) return true;
  try {
    return /(?:^|\/)docs\/prototype\//.test(new globalThis.URL(link).pathname);
  } catch {
    return false;
  }
}

/** The first inaccessible prototype link in a ticket body, or null when all are in the repo. */
export function prototypeLinkProblem(body: string): string | null {
  for (const line of body.split("\n")) {
    const links = [...line.matchAll(MARKDOWN_LINK)].map((match) => ({
      label: match[1] ?? "",
      href: match[2] ?? "",
    }));
    const raw = [...line.matchAll(HTTP_URL)].map((match) => match[0] ?? "");
    const prototypeLinks = [
      ...links.filter(({ label }) => PROTOTYPE.test(label)).map(({ href }) => href),
      ...(PROTOTYPE.test(line) ? [...links.map(({ href }) => href), ...raw] : []),
    ];
    if (prototypeLinks.some((link) => !inPrototypeDirectory(link))) return PRIVATE_PROTOTYPE_TEXT;
  }
  return null;
}
