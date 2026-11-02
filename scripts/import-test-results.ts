/** Explicit local artifact import; no workflow edit, test execution, URL fetch or QA spend. */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { TEST_REPORT_BYTES_MAX, TestReport } from "../apps/server/src/code-health/test-reports.ts";
import { vitestTestReport } from "../apps/server/src/code-health/vitest-report.ts";

function jsonFile(path: string): unknown {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > TEST_REPORT_BYTES_MAX)
    throw new Error("Invalid bounded local JSON file");
  return JSON.parse(readFileSync(path, "utf8"));
}
const usage =
  "node --experimental-strip-types scripts/import-test-results.ts (--vitest report.json --context context.json | --normalized report.json) [--post] [--port 7420]\nWithout --post, writes normalized JSON to stdout for inspection.\n";
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    process.stdout.write(usage);
    return;
  }
  const values = new Map<string, string>();
  let post = false;
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === "--post") {
      if (post) throw new Error("Duplicate flag");
      post = true;
      continue;
    }
    if (
      !["--vitest", "--context", "--normalized", "--port"].includes(key) ||
      values.has(key) ||
      !args[index + 1] ||
      args[index + 1].startsWith("--")
    )
      throw new Error("Invalid arguments");
    values.set(key, args[++index]);
  }
  const normalized = values.get("--normalized"),
    vitest = values.get("--vitest"),
    context = values.get("--context");
  if ((normalized ? 1 : 0) + (vitest ? 1 : 0) !== 1 || !!vitest !== !!context)
    throw new Error("Choose one report format");
  const report = normalized
    ? TestReport.parse(jsonFile(normalized))
    : vitestTestReport(jsonFile(vitest as string), jsonFile(context as string));
  if (!post) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const port = Number(values.get("--port") ?? 7420);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid loopback port");
  const db = resolve(
    process.env.MC_DB ?? join(homedir(), ".local", "share", "mission-control", "mc.sqlite"),
  );
  const token = readFileSync(join(dirname(db), "operator-token"), "utf8").trim();
  const response = await fetch(`http://127.0.0.1:${port}/api/code-health/test-reports`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30000),
    headers: { "content-type": "application/json", "x-mc-operator": token },
    body: JSON.stringify(report),
  });
  if (!response.ok) {
    process.stderr.write(
      `Import refused (HTTP ${response.status}). Inspect the hub and result metadata before retrying.\n`,
    );
    process.exitCode = 1;
    return;
  }
  const result = (await response.json()) as { id?: unknown; attempts?: unknown; reused?: unknown };
  if (
    typeof result.id !== "string" ||
    !/^ctr_[a-f0-9]{64}$/.test(result.id) ||
    typeof result.attempts !== "number" ||
    !Number.isSafeInteger(result.attempts) ||
    result.attempts < 0 ||
    result.attempts > 2000 ||
    typeof result.reused !== "boolean"
  )
    throw new Error("Invalid import receipt");
  process.stdout.write(
    `${JSON.stringify({ id: result.id, attempts: result.attempts, reused: result.reused })}\n`,
  );
}
try {
  await main();
} catch {
  process.stderr.write(
    "Import failed. Check the bounded local JSON files and import context. Use --help for the format.\n",
  );
  process.exitCode = 1;
}
