import { Fragment, type ReactNode } from "react";

/** The code block's class: it scrolls sideways inside its own box (see `.md pre.md-code` in hud/shared.css). */
export const MD_CODE_CLASS = "md-code";

/** A fence opens on 3+ backticks and a line with no more backticks (so ```code``` is inline code). */
const FENCE = /^\s*(`{3,})([^`]*)$/;
/** An info string that is only a language tag; anything else is code, kept. */
const LANG = /^[\w+#.-]+$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
/** A lone `#` is a heading only when short and without a colon; "# of retries: 3" is prose. */
const H1_MAX = 60;
/** Numbers over three digits (a year) are not list markers. */
const ITEM = /^(\s*)([-*]|\d{1,3}\.)\s+(.*)$/;

type MdNode =
  | { t: "text"; text: string }
  | { t: "code"; text: string }
  | { t: "bold"; kids: MdNode[] }
  | { t: "link"; kids: MdNode[]; url: string };

/** A run of two or more stars; `open`/`close` say whether it can open or close bold by what is next to it. */
type Stars = { t: "stars"; k: number; open: boolean; close: boolean };
type Flat = MdNode | Stars;

/** The code spans of the text: where each starts and ends, and a mask of every index inside one. */
function codeSpans(s: string): { spans: Map<number, number>; mask: Uint8Array } {
  const all = [...s.matchAll(/`+/g)].map((m) => ({ at: m.index, k: m[0].length }));
  // where each backtick run starts, by length: a span closes on the next run of the same length
  const byLen = new Map<number, number[]>();
  for (const r of all) {
    const list = byLen.get(r.k) ?? [];
    list.push(r.at);
    byLen.set(r.k, list);
  }
  const cursor = new Map<number, number>();
  const spans = new Map<number, number>();
  const mask = new Uint8Array(s.length + 1);
  for (let j = 0; j < all.length; ) {
    const { at, k } = all[j] as { at: number; k: number };
    const list = byLen.get(k) ?? [];
    let c = cursor.get(k) ?? 0;
    while (c < list.length && (list[c] ?? 0) <= at) c++;
    cursor.set(k, c);
    const end = list[c];
    if (end === undefined) {
      j++;
      continue;
    }
    spans.set(at, end);
    mask.fill(1, at, end + k);
    while (j < all.length && (all[j]?.at ?? 0) <= end) j++;
  }
  return { spans, mask };
}

/** The `]` at or after each index outside code, or -1; lets every `[` find its close in constant time. */
function closeTable(s: string, mask: Uint8Array): Int32Array {
  const next = new Int32Array(s.length + 1).fill(-1);
  for (let i = s.length - 1; i >= 0; i--)
    next[i] = s[i] === "]" && !mask[i] ? i : (next[i + 1] ?? -1);
  return next;
}

/** Per index: the `)` matching a `(` there (else -1), and the next whitespace at or after it. */
function parenTables(s: string, mask: Uint8Array): { match: Int32Array; space: Int32Array } {
  const match = new Int32Array(s.length + 1).fill(-1);
  const space = new Int32Array(s.length + 1).fill(s.length);
  const open: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (mask[i]) continue;
    if (s[i] === "(") open.push(i);
    else if (s[i] === ")") match[open.pop() ?? s.length] = i;
  }
  for (let i = s.length - 1; i >= 0; i--)
    space[i] = /\s/.test(s[i] ?? "") ? i : (space[i + 1] ?? 0);
  return { match, space };
}

/** One pass over the text; no character is read more than a constant number of times. */
function parse(s: string): MdNode[] {
  const { spans, mask } = codeSpans(s);
  const closes = s.includes("[") ? closeTable(s, mask) : null;
  const parens = s.includes("[") ? parenTables(s, mask) : null;
  const flat: Flat[] = [];
  let buf = "";
  const flush = () => {
    if (buf !== "") flat.push({ t: "text", text: buf });
    buf = "";
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "`" || c === "*") {
      let k = 1;
      while (s[i + k] === c) k++;
      if (c === "`") {
        const end = spans.get(i);
        if (end !== undefined) {
          flush();
          flat.push({ t: "code", text: codeText(s.slice(i + k, end)) });
          i = end + k;
          continue;
        }
        buf += s.slice(i, i + k);
      } else if (k >= 2) {
        // bold opens before a non-space and closes after one; a lone star is text
        const open = i + k < s.length && !/\s/.test(s[i + k] ?? "");
        const close = i > 0 && !/\s/.test(s[i - 1] ?? "");
        flush();
        flat.push({ t: "stars", k, open, close });
      } else {
        buf += c;
      }
      i += k;
    } else if (c === "[" && closes && parens) {
      const close = closes[i + 1] ?? -1;
      const open = close + 1;
      const end = close > i + 1 && s[open] === "(" ? (parens.match[open] ?? -1) : -1;
      // a URL is one non-empty word, its parentheses balanced
      if (end <= open + 1 || (parens.space[open] ?? 0) < end) {
        buf += c;
        i++;
      } else {
        flush();
        flat.push({ t: "link", kids: parse(s.slice(i + 1, close)), url: s.slice(close + 2, end) });
        i = end + 1;
      }
    } else {
      buf += c;
      i++;
    }
  }
  flush();
  // star runs pair by what flanks them, innermost first; one that cannot is plain text. A run holds
  // its odd star inside the bold, so `***x***` is bold `*x*`.
  // An opener sits in `out` as the text of its stars until a closer wraps what follows it, so an
  // unclosed one needs no undoing and no node is moved more than once per level it nests in.
  const out: MdNode[] = [];
  const open: { at: number; k: number }[] = [];
  for (const f of flat) {
    const opener = open.pop();
    if (f.t !== "stars") {
      if (opener) open.push(opener);
      out.push(f);
    } else if (f.close && opener) {
      const kids = out.splice(opener.at + 1);
      if (opener.k % 2) kids.unshift({ t: "text", text: "*" });
      if (f.k % 2) kids.push({ t: "text", text: "*" });
      out[opener.at] = { t: "bold", kids };
    } else {
      if (opener) open.push(opener);
      if (f.open) open.push({ at: out.length, k: f.k });
      out.push({ t: "text", text: "*".repeat(f.k) });
    }
  }
  return out;
}

/** A code span's text; one space of padding on each side is dropped, so "`` `x` ``" shows `x` in ticks. */
const codeText = (t: string): string =>
  t.length > 2 && t.startsWith(" ") && t.endsWith(" ") && t.trim() !== "" ? t.slice(1, -1) : t;

const size = (n: MdNode): number =>
  n.t === "bold" || n.t === "link" ? n.kids.reduce((a, k) => a + size(k), 0) : [...n.text].length;

/** The nodes kept to `max` visible characters (code points), a cut ending in `…`, even inside a marker. */
function limit(nodes: MdNode[], max: number): MdNode[] {
  if (nodes.reduce((a, n) => a + size(n), 0) <= max) return nodes;
  let left = Math.max(max - 1, 0);
  let done = false;
  const take = (list: MdNode[]): MdNode[] => {
    const out: MdNode[] = [];
    for (const n of list) {
      if (done) break;
      if (n.t === "bold" || n.t === "link") {
        out.push({ ...n, kids: take(n.kids) });
        continue;
      }
      const len = size(n);
      if (len <= left) {
        out.push(n);
        left -= len;
      } else {
        const text = `${[...n.text].slice(0, left).join("")}…`;
        out.push(left > 0 ? { ...n, text } : { t: "text", text });
        done = true;
      }
    }
    return out;
  };
  return take(nodes);
}

function render(nodes: MdNode[]): ReactNode[] {
  const node = (n: MdNode): ReactNode => {
    if (n.t === "code") return <code>{n.text}</code>;
    if (n.t === "bold") return <strong>{render(n.kids)}</strong>;
    if (n.t === "link") return <span title={n.url}>{render(n.kids)}</span>;
    return n.text;
  };
  return nodes.map((n, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: parsed text has no id and never reorders
    <Fragment key={i}>{node(n)}</Fragment>
  ));
}

const inline = (text: string): ReactNode[] => render(parse(text));

/**
 * Inline Markdown on one line of text (run summaries, Needs rows): bold, code and links as
 * elements, nothing block-level. With `max` the text is cut after parsing, so a cut never leaves
 * half a marker.
 */
export function MarkdownInline({ text, max }: { text: string; max?: number }) {
  const nodes = parse(text);
  return <>{render(max === undefined ? nodes : limit(nodes, max))}</>;
}

interface Item {
  text: string;
  indent: number;
  ordered: boolean;
  /** The number as written; `<li value>` shows it even when a block splits the list. */
  n: number;
  /** Indented lines under the item, kept in it. */
  more: string[];
}

/**
 * Items indented deeper than the list's first nest under the item above them. Each marker type is
 * its own list, so `-` and `1.` items side by side keep the marker they were written with.
 */
function list(items: Item[]): ReactNode[] {
  const base = items[0]?.indent ?? 0;
  const groups: { head: Item; sub: Item[] }[] = [];
  for (const it of items) {
    const g = groups.at(-1);
    if (it.indent > base && g) g.sub.push(it);
    else groups.push({ head: it, sub: [] });
  }
  const runs: { head: Item; sub: Item[] }[][] = [];
  for (const g of groups) {
    const r = runs.at(-1);
    if (r && r[0]?.head.ordered === g.head.ordered) r.push(g);
    else runs.push([g]);
  }
  return runs.map((r, k) => {
    const first = r[0]?.head;
    const children = r.map((g, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: parsed text has no id; the list never reorders
      <li key={i} value={g.head.ordered ? g.head.n : undefined}>
        {inline(g.head.text)}
        {g.head.more.map((l, j) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines have no id and never reorder
          <Fragment key={j}>
            <br />
            {/* the line break shows: only `.md p` keeps a newline */}
            {inline(l)}
          </Fragment>
        ))}
        {g.sub.length > 0 && list(g.sub)}
      </li>
    ));
    return first?.ordered ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the list never reorders
      <ol key={k} start={first.n}>
        {children}
      </ol>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: the list never reorders
      <ul key={k}>{children}</ul>
    );
  });
}

/** The text of a heading line, or null when the line reads as prose. */
function heading(line: string): string | null {
  const m = HEADING.exec(line);
  if (!m) return null;
  const text = m[2] ?? "";
  return m[1] === "#" && (text.length > H1_MAX || text.includes(":")) ? null : text;
}

const isBreak = (l: string): boolean =>
  l.trim() === "" || FENCE.test(l) || heading(l) !== null || ITEM.test(l);

function blocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  const para = (ls: string[]) =>
    out.push(
      <p key={out.length}>
        {ls.map((l, k) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines have no id and never reorder
          <Fragment key={k}>
            {k > 0 && "\n"}
            {inline(l)}
          </Fragment>
        ))}
      </p>,
    );
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fence = FENCE.exec(line);
    const head = heading(line);
    if (line.trim() === "") {
      i++;
    } else if (fence) {
      const info = (fence[2] ?? "").trim();
      // a language tag is dropped; any other text after the fence is code
      const body: string[] = info === "" || LANG.test(info) ? [] : [info];
      // only a bare fence at least as long as the opening one closes the block
      const close = new RegExp(`^\\s*\`{${(fence[1] ?? "").length},}\\s*$`);
      i++;
      while (i < lines.length) {
        if (close.test(lines[i] ?? "")) {
          i++;
          break;
        }
        body.push(lines[i++] ?? "");
      }
      out.push(
        <pre key={out.length} className={MD_CODE_CLASS}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
    } else if (head !== null) {
      out.push(
        <p key={out.length}>
          <strong>{inline(head)}</strong>
        </p>,
      );
      i++;
    } else if (ITEM.test(line)) {
      const items: Item[] = [];
      for (; i < lines.length; i++) {
        const l = lines[i] ?? "";
        const m = ITEM.exec(l);
        if (m) {
          const marker = m[2] ?? "";
          items.push({
            indent: (m[1] ?? "").length,
            ordered: /\d/.test(marker),
            n: Number.parseInt(marker, 10),
            text: m[3] ?? "",
            more: [],
          });
        } else if (/^\s+\S/.test(l) && !isBreak(l)) {
          items.at(-1)?.more.push(l.trim());
        } else {
          break;
        }
      }
      out.push(<Fragment key={out.length}>{list(items)}</Fragment>);
    } else {
      const ls: string[] = [];
      while (i < lines.length && !isBreak(lines[i] ?? "")) ls.push(lines[i++] ?? "");
      para(ls);
    }
  }
  return out;
}

/**
 * Agent text as formatted text: paragraphs, `-` and `1.` lists (numbers as written), bold, inline
 * code, fenced blocks, headings as bold lines, links as their text with the URL in `title`.
 * React elements only: raw HTML in the text shows as literal text.
 */
export function Markdown({ text }: { text: string }) {
  return <div className="md">{blocks(text)}</div>;
}
