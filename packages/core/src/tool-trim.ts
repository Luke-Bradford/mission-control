/**
 * Cutting a huge tool result before it enters a seat's context (#1045). The guard's PostToolUse
 * trim hook (`apps/server/src/guard/trim-cli.ts`) hands the CLI's `tool_response` to
 * `trimToolResponse` and, when it answers, returns the cut form as `updatedToolOutput`. Pure: the
 * hook writes the full text to the run's folder and names it in the marker.
 */

/** A result over this many bytes is cut. */
export const TOOL_TRIM_OVER = 32 * 1024;
/** What a cut result keeps from its start. */
export const TOOL_TRIM_HEAD = 8 * 1024;
/** What a cut result keeps from its end (or from its last failing line, for Bash). */
export const TOOL_TRIM_TAIL = 4 * 1024;
/** The folder under the run's temp root that holds the full outputs. */
export const TOOL_OUTPUT_DIR = "tool-output";

/** A line a build or test command printed about a failure. */
const FAILING_LINE = /\bFAIL(?:ED)?\b|\berror\b/i;
/**
 * Tools whose bulk (`originalFile`, a whole-file patch) never reaches the model: their result text
 * names the path only, so there is nothing to save and a cut would only cost a copy per call.
 */
const UNSHOWN_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Only an MCP tool's output may become one plain text; the CLI rejects that shape for the rest. */
const MCP_PREFIX = "mcp__";
/** The one tool whose output is a build or test run. */
const COMMAND_TOOL = "Bash";

export const toolTrimMarker = (cut: number, fullPath: string): string =>
  `[mc: ${cut} bytes cut; the full output is at ${fullPath}]`;

const enc = new TextEncoder();
const dec = new TextDecoder();
const isContinuation = (b: number | undefined): boolean => b !== undefined && (b & 0xc0) === 0x80;

/** `text` as head, a marker line and tail; the bytes are cut at a character edge. */
function cutText(text: string, tool: string, fullPath: string): string {
  const bytes = enc.encode(text);
  let headEnd = TOOL_TRIM_HEAD;
  while (headEnd > 0 && isContinuation(bytes[headEnd])) headEnd--;
  let tailStart = bytes.length - TOOL_TRIM_TAIL;
  let tailEnd = bytes.length;
  if (tool === COMMAND_TOOL) {
    // the last failing line and what follows it, rather than whatever the output ended on
    let failAt = -1;
    let lineAt = 0;
    for (const l of text.split("\n")) {
      if (FAILING_LINE.test(l)) failAt = lineAt;
      lineAt += l.length + 1;
    }
    if (failAt >= 0) {
      const failStart = enc.encode(text.slice(0, failAt)).length;
      if (failStart < tailStart) {
        tailStart = failStart;
        tailEnd = failStart + TOOL_TRIM_TAIL;
      }
    }
  }
  tailStart = Math.max(tailStart, headEnd);
  while (tailStart < bytes.length && isContinuation(bytes[tailStart])) tailStart++;
  while (tailEnd < bytes.length && isContinuation(bytes[tailEnd])) tailEnd--;
  const head = dec.decode(bytes.subarray(0, headEnd));
  const tail = dec.decode(bytes.subarray(tailStart, Math.max(tailStart, tailEnd)));
  const cut = bytes.length - headEnd - Math.max(0, tailEnd - tailStart);
  return `${head}\n${toolTrimMarker(cut, fullPath)}\n${tail}`;
}

/** Every string in `v` bigger than a cut result is cut on its own; the rest keeps its shape. */
function cutLeaves(v: unknown, tool: string, fullPath: string): unknown {
  if (typeof v === "string") {
    return enc.encode(v).length > TOOL_TRIM_HEAD + TOOL_TRIM_TAIL ? cutText(v, tool, fullPath) : v;
  }
  if (Array.isArray(v)) return v.map((x) => cutLeaves(x, tool, fullPath));
  if (typeof v === "object" && v !== null) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cutLeaves(x, tool, fullPath)]));
  }
  return v;
}

const sizeOf = (s: string): number => enc.encode(s).length;

/**
 * The cut form of a tool's `tool_response` and the full text to keep, or null when the result is
 * not over `TOOL_TRIM_OVER` (or cannot be cut in its own shape). The cut form keeps the response's shape (a Bash result stays an object,
 * an MCP result stays a content array) by cutting its long strings; an MCP result with no such
 * string becomes one cut text, and any other tool's is left whole.
 */
export function trimToolResponse(
  tool: string,
  response: unknown,
  fullPath: string,
): { output: unknown; full: string } | null {
  if (UNSHOWN_TOOLS.has(tool)) return null;
  const full = typeof response === "string" ? response : JSON.stringify(response);
  if (full === undefined || sizeOf(full) <= TOOL_TRIM_OVER) return null;
  const cut = cutLeaves(response, tool, fullPath);
  const shaped = typeof cut === "string" ? cut : JSON.stringify(cut);
  if (sizeOf(shaped) <= TOOL_TRIM_OVER) return { output: cut, full };
  // the shape cannot be kept: only a tool that may return plain text is given one, else it stays whole
  if (!tool.startsWith(MCP_PREFIX)) return null;
  return { output: cutText(full, tool, fullPath), full };
}
