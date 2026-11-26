import "./temp-home.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { starterLogText } from "../src/config/hub-settings.ts";
import { DEFAULT_PORT, parseConfig } from "../src/config.ts";

const runbook = readFileSync(
  resolve(import.meta.dirname, "../../../docs/runbooks/work-mac.md"),
  "utf8",
);

/** The runbook's fenced blocks of one language. */
const blocks = (lang: string): string[] =>
  [...runbook.matchAll(new RegExp(`\`\`\`${lang}\\n([\\s\\S]*?)\`\`\``, "g"))].map(
    (m) => m[1] ?? "",
  );

describe("work-Mac runbook", () => {
  it("has every setup step: tools, cmux socket, clone and build, first start, launchd, the hour check", () => {
    for (const step of [
      "pnpm install",
      "pnpm build",
      "socketControlMode",
      starterLogText("<path>"),
      "operator-token",
      "launchctl bootstrap",
      "Check after one hour",
    ])
      expect(runbook).toContain(step);
  });

  it("runs the hub as live on the chosen port, on loopback", () => {
    expect(runbook).toContain('MC_LIVE_PORT="$MC_PORT"');
    expect(runbook).toContain("<key>MC_LIVE_PORT</key><string><port></string>");
    expect(runbook).toContain("http://127.0.0.1:$MC_PORT/");
  });

  it("gives launchd a PATH built from the folders of the installed node and cmux", () => {
    expect(runbook).toContain('dirname "$(command -v node)"');
    expect(runbook).toContain('dirname "$(command -v cmux)"');
    expect(runbook).toContain("<key>PATH</key><string><path></string>");
  });

  it("names no path, label or port of the hub's own Mac", () => {
    expect(runbook).not.toMatch(/\/Users\//);
    expect(runbook).not.toContain("mc-node");
    expect(runbook).not.toContain(String(DEFAULT_PORT));
  });

  it("shows a starter config that loads with no accounts, repositories, loops or crew", () => {
    const [yaml] = blocks("yaml");
    expect(yaml).toBeDefined();
    const config = parseConfig(yaml ?? "", "work-mac.md");
    expect(config.accounts).toEqual([]);
    expect(config.repos).toEqual([]);
    expect(config.loops).toEqual([]);
    expect(config.crew).toBeUndefined();
  });
});
