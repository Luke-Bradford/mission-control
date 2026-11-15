/** An mcp tool is named `mcp__<server>__<tool>`. */
const MCP_TOOL = /^mcp__[^_]+__(.+)$/;

/** Plain labels for the mcp tools worth a sentence, by the tool part of the name. */
const MCP_LABELS: Readonly<Record<string, string>> = {
  screenshot_hud: "Taking a screenshot",
};

/** The tool part of an mcp tool name (`screenshot_hud`); null for any other tool. */
export const mcpToolPart = (name: string): string | null => MCP_TOOL.exec(name)?.[1] ?? null;

/**
 * A tool's name in words: an mcp tool gets its plain label, else its tool part with the underscores
 * as spaces; a built-in or unknown tool keeps its name.
 */
export function toolLabel(name: string): string {
  const part = mcpToolPart(name);
  if (part === null) return name;
  return MCP_LABELS[part] ?? part.replace(/_/g, " ");
}
