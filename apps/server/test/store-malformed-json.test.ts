import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { trustedAuthor } from "../src/flight/collaborators.ts";
import { urgentChange } from "../src/flight/state.ts";
import { changedWakeFacts } from "../src/flight/watch.ts";
import { readWaitRecord, WAIT_RECORD_SETTING } from "../src/queue/dependencies.ts";
import { Store } from "../src/store.ts";

let dir: string;
let store: Store;
let raw: { db: { prepare(sql: string): { run(...a: (string | number | null)[]): unknown } } };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-malformed-"));
  store = new Store(join(dir, "mc.db"));
  raw = store as unknown as typeof raw;
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("stored JSON that will not parse", () => {
  it("is skipped by the merged-PR read instead of failing it", () => {
    const insert = raw.db.prepare(
      "INSERT INTO pr_history (repo_id, number, merged_at, record) VALUES ('mc', ?, ?, ?)",
    );
    insert.run(1, 10, "{not json");
    insert.run(2, 20, JSON.stringify({ number: 2 }));
    const prs = store.prHistory("mc");
    expect(prs).toHaveLength(1);
    expect(prs[0]?.number).toBe(2);
  });

  it("drops an unreadable FLIGHT ledger entry and keeps the good ones", () => {
    const insert = raw.db.prepare(
      "INSERT INTO flight_ledger (session_id, key, kind, status, updated_at, entry) VALUES ('s', ?, 'k', 'open', 1, ?)",
    );
    insert.run("a", "{broken");
    insert.run("b", JSON.stringify({ key: "b" }));
    expect(store.flightLedger("s").map((e) => e.key)).toEqual(["b"]);
  });

  it("reads a ticket plan whose mockups will not parse as having none", () => {
    raw.db
      .prepare(
        "INSERT INTO ticket_plans (repo_id, issue, state, required, mockups, requested_at) VALUES ('mc', 5, 'awaiting-plan', 0, '[oops', 1)",
      )
      .run();
    expect(store.plans.get("mc", 5)?.mockups).toEqual([]);
  });

  it("compares FLIGHT wake facts without throwing when either side will not parse", () => {
    expect(urgentChange("{oops", "{}")).toBe(false);
    expect(changedWakeFacts("{oops", JSON.stringify({ prs: [1] }))).toEqual(["prs (1)"]);
  });

  it("reads a malformed collaborator cache as untrusted and a malformed wait record as empty", () => {
    store.setSetting("collaborator:o/mc:someone", "{oops");
    expect(trustedAuthor(store, "o/mc", "someone", 1)).toBe(false);
    store.setSetting(`${WAIT_RECORD_SETTING}:mc`, "[unclosed");
    expect(readWaitRecord(store, "mc")).toEqual({ waiting: {} });
  });
});
