import type { DatabaseSync } from "node:sqlite";
import { riskFile } from "./risk.ts";
import { type FileSizeSnapshot, SIZE_FILES_MAX, SIZE_SCOPE_VERSION } from "./size-source.ts";

type Db = Pick<DatabaseSync, "prepare">;
const SHA = /^[a-f0-9]{40,64}$/;
export function installFileSizes(db: Pick<DatabaseSync, "exec">) {
  db.exec(`CREATE TABLE IF NOT EXISTS code_health_size_snapshots(
    repo_id TEXT NOT NULL,checkout TEXT NOT NULL,sha TEXT NOT NULL,version INTEGER NOT NULL,
    at INTEGER NOT NULL,file_count INTEGER NOT NULL,PRIMARY KEY(repo_id,checkout,sha,version));
    CREATE INDEX IF NOT EXISTS code_health_sizes_age ON code_health_size_snapshots(repo_id,checkout,version,at DESC,sha);
    CREATE TABLE IF NOT EXISTS code_health_file_sizes(
    repo_id TEXT NOT NULL,checkout TEXT NOT NULL,sha TEXT NOT NULL,version INTEGER NOT NULL,
    path TEXT NOT NULL,lines INTEGER NOT NULL CHECK(typeof(lines)='integer' AND lines>=0),
    PRIMARY KEY(repo_id,checkout,sha,version,path));
    CREATE INDEX IF NOT EXISTS code_health_sizes_path ON code_health_file_sizes(repo_id,checkout,version,path,sha);
    CREATE TABLE IF NOT EXISTS code_health_size_sources(
    repo_id TEXT PRIMARY KEY,checkout TEXT NOT NULL,sha TEXT,version INTEGER NOT NULL,
    checked_at INTEGER NOT NULL,status TEXT NOT NULL,elapsed_ms REAL,excluded_binary_files INTEGER)`);
}
export function recordFileSizes(
  db: Db,
  repoId: string,
  checkout: string,
  snapshot: FileSizeSnapshot,
  at: number,
) {
  if (
    snapshot.version !== SIZE_SCOPE_VERSION ||
    !SHA.test(snapshot.analysedSha) ||
    snapshot.files.length > SIZE_FILES_MAX ||
    !Number.isSafeInteger(at) ||
    at < 0 ||
    !snapshot.files.every(
      (file) => riskFile(file.path) && Number.isSafeInteger(file.lines) && file.lines >= 0,
    ) ||
    new Set(snapshot.files.map((file) => file.path)).size !== snapshot.files.length
  )
    throw Error("Invalid file-size snapshot");
  const key = [repoId, checkout, snapshot.analysedSha, snapshot.version];
  const existing = db
    .prepare(
      "SELECT at,file_count FROM code_health_size_snapshots WHERE repo_id=? AND checkout=? AND sha=? AND version=?",
    )
    .get(...key);
  if (!existing) {
    db.prepare("INSERT INTO code_health_size_snapshots VALUES(?,?,?,?,?,?)").run(
      ...key,
      at,
      snapshot.files.length,
    );
    const insert = db.prepare("INSERT INTO code_health_file_sizes VALUES(?,?,?,?,?,?)");
    for (const file of snapshot.files) insert.run(...key, file.path, file.lines);
  }
  db.prepare(`INSERT INTO code_health_size_sources VALUES(?,?,?,?,?,'available',?,?)
    ON CONFLICT(repo_id)DO UPDATE SET checkout=excluded.checkout,sha=excluded.sha,version=excluded.version,
    checked_at=excluded.checked_at,status=excluded.status,elapsed_ms=excluded.elapsed_ms,excluded_binary_files=excluded.excluded_binary_files`).run(
    ...key,
    at,
    snapshot.elapsedMs,
    snapshot.excludedBinaryFiles,
  );
  // Keep two recent observations, the current source, and one observation per UTC day for90 days.
  const rows = db
    .prepare(
      `SELECT checkout,sha,at FROM code_health_size_snapshots WHERE repo_id=? AND version=? ORDER BY at DESC,sha DESC LIMIT 1001`,
    )
    .all(repoId, snapshot.version) as { checkout: string; sha: string; at: number }[];
  if (rows.length > 1000) throw Error("Size snapshot retention bound exceeded");
  const id = (row: { checkout: string; sha: string }) => JSON.stringify([row.checkout, row.sha]);
  const keep = new Set([id({ checkout, sha: snapshot.analysedSha }), ...rows.slice(0, 2).map(id)]),
    days = new Set<number>();
  for (const row of rows)
    if (row.at >= at - 90 * 86400000) {
      const day = Math.floor(row.at / 86400000);
      if (!days.has(day)) {
        keep.add(id(row));
        days.add(day);
      }
    }
  for (const row of rows.filter((row) => !keep.has(id(row))).slice(0, 2)) {
    db.prepare(
      "DELETE FROM code_health_file_sizes WHERE repo_id=? AND checkout=? AND sha=? AND version=?",
    ).run(repoId, row.checkout, row.sha, snapshot.version);
    db.prepare(
      "DELETE FROM code_health_size_snapshots WHERE repo_id=? AND checkout=? AND sha=? AND version=?",
    ).run(repoId, row.checkout, row.sha, snapshot.version);
  }
}
export function fileSizeSource(db: Db, repoId: string, checkout: string) {
  const row = db
    .prepare(`SELECT s.sha,s.version,s.checked_at,s.status,s.elapsed_ms,s.excluded_binary_files,h.at,h.file_count
    FROM code_health_size_sources s LEFT JOIN code_health_size_snapshots h ON h.repo_id=s.repo_id AND h.checkout=s.checkout AND h.sha=s.sha AND h.version=s.version
    WHERE s.repo_id=? AND s.checkout=?`)
    .get(repoId, checkout);
  if (!row) return null;
  const available = row.status === "available" && row.version === SIZE_SCOPE_VERSION;
  if (
    available &&
    (!SHA.test(String(row.sha)) ||
      !Number.isSafeInteger(row.at) ||
      !Number.isSafeInteger(row.file_count) ||
      Number(row.file_count) < 0 ||
      Number(row.file_count) > SIZE_FILES_MAX)
  )
    throw Error("Unreadable size source");
  if (available) {
    const count = db
      .prepare(
        "SELECT COUNT(*) AS n FROM code_health_file_sizes WHERE repo_id=? AND checkout=? AND sha=? AND version=?",
      )
      .get(repoId, checkout, String(row.sha), SIZE_SCOPE_VERSION);
    if (count?.n !== row.file_count) throw Error("Incomplete size snapshot");
  }
  const last = db
    .prepare(
      "SELECT sha,at FROM code_health_size_snapshots WHERE repo_id=? AND checkout=? AND version=? ORDER BY at DESC,sha DESC LIMIT 1",
    )
    .get(repoId, checkout, SIZE_SCOPE_VERSION);
  if (
    last &&
    (!SHA.test(String(last.sha)) || !Number.isSafeInteger(last.at) || Number(last.at) < 0)
  )
    throw Error("Unreadable historical size provenance");
  const files = available
    ? sizeEvidence(db, { repoId, checkout, sha: String(row.sha), offset: 0, limit: 50 })
    : [];
  return {
    analysedSha: row.sha === null ? null : String(row.sha),
    lastCapturedSha: last ? String(last.sha) : null,
    lastCapturedAt: last ? Number(last.at) : null,
    version: Number(row.version),
    checkedAt: Number(row.checked_at),
    collectedAt: row.at === null ? null : Number(row.at),
    status: available ? "available" : "unavailable",
    elapsedMs: Number(row.elapsed_ms),
    excludedBinaryFiles: Number(row.excluded_binary_files),
    files: files.slice(0, 50),
  };
}
export function checkFileSizes(db: Db, repoId: string, checkout: string, sha: string, at: number) {
  db.prepare(
    "UPDATE code_health_size_sources SET checked_at=? WHERE repo_id=? AND checkout=? AND sha=? AND version=? AND status='available'",
  ).run(at, repoId, checkout, sha, SIZE_SCOPE_VERSION);
}
export function failFileSizes(
  db: Db,
  repoId: string,
  checkout: string,
  sha: string | null,
  at: number,
) {
  db.prepare(`INSERT INTO code_health_size_sources(repo_id,checkout,sha,version,checked_at,status)VALUES(?,?,?,?,?,'unavailable')
    ON CONFLICT(repo_id)DO UPDATE SET checkout=excluded.checkout,sha=excluded.sha,checked_at=excluded.checked_at,status=excluded.status`).run(
    repoId,
    checkout,
    sha,
    SIZE_SCOPE_VERSION,
    at,
  );
}
function validateRows(rows: { path: string; lines: number }[]) {
  if (rows.some((row) => !riskFile(row.path) || !Number.isSafeInteger(row.lines) || row.lines < 0))
    throw Error("Unreadable size file row");
  return rows;
}
export function sizeEvidence(
  db: Db,
  query: {
    repoId: string;
    checkout: string;
    sha: string;
    file?: string;
    offset: number;
    limit: number;
  },
) {
  return validateRows(
    db
      .prepare(
        `SELECT path,lines FROM code_health_file_sizes WHERE repo_id=? AND checkout=? AND sha=? AND version=? ${query.file === undefined ? "" : "AND path=?"} ORDER BY lines DESC,path LIMIT ? OFFSET ?`,
      )
      .all(
        query.repoId,
        query.checkout,
        query.sha,
        SIZE_SCOPE_VERSION,
        ...(query.file === undefined ? [] : [query.file]),
        query.limit + 1,
        query.offset,
      ) as { path: string; lines: number }[],
  );
}
export function sizeHistoryEvidence(
  db: Db,
  query: {
    repoId: string;
    checkout: string;
    file: string;
    from: number;
    until: number;
    offset: number;
    limit: number;
  },
) {
  const rows = db
    .prepare(`SELECT f.path,f.lines,h.sha,h.at FROM code_health_file_sizes f JOIN code_health_size_snapshots h
    ON h.repo_id=f.repo_id AND h.checkout=f.checkout AND h.sha=f.sha AND h.version=f.version
    WHERE f.repo_id=? AND f.checkout=? AND f.version=? AND f.path=? AND h.at>=? AND h.at<?
    ORDER BY h.at,h.sha LIMIT ? OFFSET ?`)
    .all(
      query.repoId,
      query.checkout,
      SIZE_SCOPE_VERSION,
      query.file,
      query.from,
      query.until,
      query.limit + 1,
      query.offset,
    ) as { path: string; lines: number; sha: string; at: number }[];
  validateRows(rows);
  if (rows.some((row) => !SHA.test(row.sha) || !Number.isSafeInteger(row.at)))
    throw Error("Unreadable size history point");
  return rows;
}
export function fileSizeHistory(
  db: Db,
  repoId: string,
  checkout: string,
  paths: readonly string[],
  from: number,
  until: number,
  currentSha: string,
) {
  if (paths.length > 50) throw Error("Size history path limit");
  return paths.map((path) => {
    const rows = sizeHistoryEvidence(db, {
      repoId,
      checkout,
      file: path,
      from,
      until,
      offset: 0,
      limit: 100,
    });
    if (rows.length > 100) throw Error("Size history observation limit");
    const points = (rows.length > 1 ? [rows[0], rows[rows.length - 1]] : rows).map(
      ({ at, sha, lines }) => ({ at, sha, lines }),
    );
    return {
      path,
      points,
      comparable:
        points.length > 1 &&
        points[0].sha !== points[points.length - 1].sha &&
        points[points.length - 1].sha === currentSha,
    };
  });
}
