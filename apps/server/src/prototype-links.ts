/** A ticket's prototype must be readable by every crew seat from the repository. */
export const PRIVATE_PROTOTYPE_TEXT = "links a prototype outside docs/prototype/.";

const MARKDOWN_LINK = /\[([^\]]*)\]\(([^\s)]+)(?:\s+[^)]*)?\)/g;
const HTTP_URL = /https?:\/\/[^\s)>]+/g;
const PROTOTYPE = /\b(?:prototype|mockup)\b/i;

// A Git ref may contain slashes, and without asking GitHub the ref/file boundary is ambiguous.
// Accept one segment, or a conventional branch prefix plus one segment (feature/prototype-polish).
// Other slash-named refs are refused until someone copies the prototype into docs/prototype/.
const REF = "(?:(?:feature|fix|bug|bugfix|chore|docs|test|hotfix|release|refactor)/)?[^/]+";
const GITHUB_BLOB = new RegExp(`^(?:blob|raw)/${REF}/docs/prototype/.+`);
const RAW_FILE = new RegExp(`^${REF}/docs/prototype/.+`);

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
    if (url.hostname === "github.com") return GITHUB_BLOB.test(route);
    if (url.hostname === "raw.githubusercontent.com") return RAW_FILE.test(route);
    return false;
  } catch {
    return false;
  }
}

/** A link that stays in this repository, whatever it points at (a doc, an issue, a pull request). */
function inRepository(link: string, github: string | undefined): boolean {
  try {
    if (!/^[a-z][a-z\d+.-]*:/i.test(link) && !link.startsWith("//")) {
      return (
        new globalThis.URL(link, "https://repository.invalid/").origin ===
        "https://repository.invalid"
      );
    }
    if (github === undefined) return false;
    const url = new globalThis.URL(link);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    if (url.hostname !== "github.com" && url.hostname !== "raw.githubusercontent.com") return false;
    const [owner, repo] = url.pathname.split("/").slice(1);
    return `${owner}/${repo}`.toLowerCase() === github.toLowerCase();
  } catch {
    return false;
  }
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const PROTOTYPE_HEADING = /\b(?:prototype|mockup)s?\b/i;

/** The first inaccessible prototype link in a ticket body, or null when all are in the repo. */
export function prototypeLinkProblem(body: string, github?: string): string | null {
  // Level of the open heading that names a prototype; links under it are prototype links.
  let prototypeHeading: number | null = null;
  for (const line of body.split("\n")) {
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      if (PROTOTYPE_HEADING.test(heading[2] ?? "")) prototypeHeading = level;
      else if (prototypeHeading !== null && level <= prototypeHeading) prototypeHeading = null;
    }
    const links = [...line.matchAll(MARKDOWN_LINK)].map((match) => ({
      label: match[1] ?? "",
      href: match[2] ?? "",
    }));
    const raw = [...line.matchAll(HTTP_URL)].map((match) => ({ label: "", href: match[0] ?? "" }));
    const mentions = PROTOTYPE.test(line);
    for (const { label, href } of [...links, ...raw]) {
      // A link is a prototype link when it says so itself or sits under a prototype heading.
      const own = PROTOTYPE.test(label) || PROTOTYPE.test(href) || prototypeHeading !== null;
      if (own && !inPrototypeDirectory(href, github)) return PRIVATE_PROTOTYPE_TEXT;
      // Any other link beside the word only has to stay in this repository.
      if (!own && mentions && !inRepository(href, github)) return PRIVATE_PROTOTYPE_TEXT;
    }
  }
  return null;
}
