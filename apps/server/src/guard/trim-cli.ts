/**
 * The trim hook's entry (#1045): the file a seat's PostToolUse trim command runs. It reads stdin,
 * asks `trimMain` and prints its answer. Any failure prints nothing and exits 0: the result stays
 * whole.
 */
import { writeSync } from "node:fs";
import { trimMain } from "./trim.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

readStdin()
  .then((stdin) => {
    const out = Buffer.from(trimMain(stdin, process.argv[2] ?? ""));
    for (let at = 0; at < out.length; ) at += writeSync(1, out, at);
  })
  .catch(() => {})
  .finally(() => process.exit(0));
