/**
 * The guard hook's entry: the file a seat's hook command runs, always, with no "am I main?" gate
 * (a node without `import.meta.main` would otherwise run nothing, exit 0, and let the tool run).
 *
 * The seat's hook command (Task 6 builds it from this; each part single-quoted):
 *
 *   '<crew.node>' --experimental-strip-types '<hub root>/apps/server/src/guard/hook-cli.ts' \
 *     '<token file>' 'http://127.0.0.1:<port>/api/guard/check' || exit 2
 *
 * It reads all of stdin, asks `hookMain`, prints its answer and exits with its code. `postHttp`
 * rejects with node's own error (`code` ECONNREFUSED or ECONNRESET), which `hookMain` retries. Any failure of
 * its own once loaded, and its hard deadline, print the "unreachable" deny and exit 2. A failure to
 * load the module (node missing, an import that fails) exits 1 (127 for a missing node) before any
 * of this runs: the `|| exit 2` wrapper turns that into exit 2, which blocks the tool.
 */
import { writeSync } from "node:fs";
import { request } from "node:http";
import { HOOK_DEADLINE_MS } from "@mc/core";
import { FAILED, type HookResult, hookMain } from "./hook.ts";

/** The one stderr line on a failure; the CLI shows it (and the command line) to the model. */
const FAILED_LINE = "mc-guard: no verdict from Mission Control\n";
/** The most of the hub's reply the hook reads. */
const MAX_REPLY = 64 * 1024;

/** POST with `node:http`: unlike `fetch`, it sets no headers or body timeout of its own. */
function postHttp(
  url: string,
  token: string,
  body: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        agent: false,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_REPLY) req.destroy(new Error("reply too large"));
          else chunks.push(c);
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function finish(r: HookResult): never {
  let exit = r.exit;
  try {
    const out = Buffer.from(r.out);
    for (let at = 0; at < out.length; ) at += writeSync(1, out, at);
  } catch {
    // a deny that could not be printed must still block (exit 0 with no stdout runs the tool)
    exit = 2;
  }
  if (exit !== 0) {
    try {
      writeSync(2, FAILED_LINE);
    } catch {
      // the exit code still blocks
    }
  }
  process.exit(exit);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const fail = () => finish(FAILED);
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
// covers reading stdin too: a CLI that never closes it still gets a deny in time
setTimeout(fail, HOOK_DEADLINE_MS);
readStdin()
  .then((stdin) => hookMain(stdin, [process.argv[2] ?? "", process.argv[3] ?? ""], postHttp))
  .then(finish, fail);
