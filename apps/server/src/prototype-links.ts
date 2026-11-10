/** A ticket's prototype must be readable by every crew seat from the repository. */
export const PRIVATE_PROTOTYPE_TEXT = "links a prototype outside docs/prototype/.";

const MARKDOWN_LINK = /\[([^\]]*)\]\(([^\s)]+)(?:\s+[^)]*)?\)/g;
const HTTP_URL = /https?:\/\/[^\s)>]+/g;
const PROTOTYPE = /\b(?:prototype|mockup)\b/i;

function inPrototypeDirectory(link: string, github: string | undefined): boolean {
  try {
    // A relative path belongs to this repository. Resolve dot segments before trusting its directory.
    if (!/^[a-z][a-z\d+.-]*:/i.test(link) && !link.startsWith("//")) {
      const url = new globalThis.URL(link, "https://repository.invalid/");
      return (
        url.origin === "https://repository.invalid" && /^\/docs\/prototype\/.+/.test(url.pathname)
      );
    }
    if (github === undefined) return false;
    const url = new globalThis.URL(link);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    const [owner, repo, ...rest] = url.pathname.split("/").slice(1);
    if (`${owner}/${repo}`.toLowerCase() !== github.toLowerCase()) return false;
    const route = rest.join("/");
    if (url.hostname === "github.com")
      return /^(?:blob|raw)\/[^/]+\/docs\/prototype\/.+/.test(route);
    if (url.hostname === "raw.githubusercontent.com")
      return /^[^/]+\/docs\/prototype\/.+/.test(route);
    return false;
  } catch {
    return false;
  }
}

/** The first inaccessible prototype link in a ticket body, or null when all are in the repo. */
export function prototypeLinkProblem(body: string, github?: string): string | null {
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
    if (prototypeLinks.some((link) => !inPrototypeDirectory(link, github)))
      return PRIVATE_PROTOTYPE_TEXT;
  }
  return null;
}
