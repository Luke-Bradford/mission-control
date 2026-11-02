import type { CcConfig } from "../config.ts";
import type { Store } from "../store.ts";
import { cleanCodeHealth } from "./clean.ts";
import { riskPath } from "./risk.ts";

/** Scope must be explicit ticket data. References, examples and seat-area globs do not qualify. */
export function declaredTicketFiles(body: string): string[] {
  if (body.length > 65536) return [];
  const files = new Set<string>();
  let inScope = false,
    comment = false,
    fence: { char: string; length: number } | null = null;
  for (const line of body.split(/\r?\n/)) {
    if (comment) {
      if (line.includes("-->")) comment = false;
      continue;
    }
    if (line.includes("<!--")) {
      comment = !line.includes("-->");
      continue;
    }
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (mark && mark[1][0] === fence.char && mark[1].length >= fence.length) fence = null;
      continue;
    }
    if (mark) {
      fence = { char: mark[1][0], length: mark[1].length };
      continue;
    }
    const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      inScope = /^(?:files(?: to change)?|file scope|paths|affected files|touched files):?$/i.test(
        heading[1].trim(),
      );
      continue;
    }
    if (!inScope) continue;
    const item = /^ {0,3}[-*+]\s+(?:`([^`\r\n]+)`|([^\s`]+))/.exec(line);
    if (!item) continue;
    const path = item[1] ?? item[2];
    if (
      !riskPath(path) ||
      [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      ["*", "?", "[", "]", "{", "}"].some((char) => path.includes(char))
    )
      continue;
    if (
      !item[1] &&
      !path.includes("/") &&
      !/\.[A-Za-z0-9]+$/.test(path) &&
      !/^(?:Dockerfile|Makefile|LICENSE|README)$/.test(path)
    )
      continue;
    files.add(path);
    if (files.size >= 100) break;
  }
  return [...files];
}

/** Optional, local advice. Secret lookup failure omits context instead of leaking source text. */
export function createFileContext(deps: {
  config: CcConfig;
  store: Store;
  knownSecrets: () => Promise<readonly string[]>;
  now?: () => number;
  secretsTimeoutMs?: number;
}) {
  const now = deps.now ?? Date.now;
  return async (repoId: string, body: string): Promise<string | null> => {
    const paths = declaredTicketFiles(body);
    if (!paths.length || !deps.config.repos.some((repo) => repo.id === repoId)) return null;
    const checkout = deps.config.crew?.sessions.find(
      (session) => session.repoId === repoId,
    )?.checkout;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      deps.store.refreshCodeHealthRecommendations(repoId, now(), checkout);
      const rows = deps.store.codeHealthFileRecommendations(repoId, paths, now());
      if (!rows.length) return null;
      const secrets = await Promise.race([
        deps.knownSecrets(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error("Secret lookup unavailable")),
            deps.secretsTimeoutMs ?? 5000,
          );
        }),
      ]);
      const items: unknown[] = [];
      for (const row of rows) {
        if (!row.scope?.file || !paths.includes(row.scope.file)) continue;
        const value = cleanCodeHealth(
          {
            recommendation: row.id,
            file: row.scope.file,
            rule: row.rule,
            decision: row.state.kind === "snoozed" ? "snooze elapsed" : row.state.kind,
            linkedWork: row.linkedWork,
            observation: row.observation,
            uncertainty: row.uncertainty,
            proposal: row.proposal,
            target: row.target,
            analysedSha: row.scope.sizeSha ?? null,
            collectedAt: row.scope.sizeCapturedAt ?? null,
          },
          secrets,
        ) as Record<string, unknown>;
        if (value.file !== row.scope.file || value.recommendation !== row.id) continue;
        for (const [key, limit] of [
          ["observation", 600],
          ["uncertainty", 400],
          ["proposal", 400],
        ] as const)
          if (typeof value[key] === "string") value[key] = value[key].slice(0, limit);
        const candidate = [...items, value];
        if (JSON.stringify(candidate).length <= 4000) items.push(value);
        if (items.length === 3) break;
      }
      return items.length ? JSON.stringify(items) : null;
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
