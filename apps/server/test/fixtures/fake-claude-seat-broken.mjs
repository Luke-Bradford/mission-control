// A stand-in for a `claude` that starts fine bare but breaks under a seat's own settings: the seat
// start passes `--mcp-config` (and the guard hook), a bare `claude -p` does not. Everything else is
// fake-claude.mjs.
if (process.argv.includes("--mcp-config")) {
  process.stderr.write("Error: invalid seat settings (unknown key in mcp config)\n");
  process.exit(1);
}
await import("./fake-claude.mjs");
