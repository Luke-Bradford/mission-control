/** Select only the running hub's repository for branch previews, including separate crew clones. */
import { execFile } from "node:child_process";
import type { RepoId } from "@mc/core";
import type { CcConfig, CrewSessionConfig } from "./config.ts";

const READ_ORIGIN_MS = 5_000;

async function originRepo(checkout: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", checkout, "config", "--get", "remote.origin.url"],
      { encoding: "utf8", timeout: READ_ORIGIN_MS, maxBuffer: 4096 },
      (error, stdout) => {
        if (error) return resolve(null);
        const match =
          /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(
            stdout.trim(),
          );
        resolve(match?.[1]?.toLowerCase() ?? null);
      },
    );
  });
}

/** Missing or mismatched origins leave previews unavailable; directory equality alone is insufficient. */
export async function resolvePreviewRepo(
  hubRoot: string | null,
  repos: readonly Pick<CcConfig["repos"][number], "id" | "github">[],
  sessions: readonly Pick<CrewSessionConfig, "repoId" | "checkout">[],
): Promise<RepoId | undefined> {
  if (hubRoot === null || sessions.length === 0) return undefined;
  const hubRepo = await originRepo(hubRoot);
  if (hubRepo === null) return undefined;
  for (const configured of repos) {
    if (configured.github.toLowerCase() !== hubRepo) continue;
    // The API starts previews from the first session for this repo; validate that exact checkout.
    const session = sessions.find((candidate) => candidate.repoId === configured.id);
    if (session && (await originRepo(session.checkout)) === hubRepo) return configured.id;
  }
  return undefined;
}
