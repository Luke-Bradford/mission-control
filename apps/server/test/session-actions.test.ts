import "./temp-home.ts";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import { loadConfig, managedSessionPath } from "../src/config.ts";
import { closeSession, createSession, setSessionSeats } from "../src/config-write.ts";
import { createCrewReloader } from "../src/crew-apply.ts";
import { removeSessionCheckout } from "../src/runtime/checkouts.ts";
import { Store } from "../src/store.ts";

const fault = vi.hoisted(() => ({ rename: false, rm: false }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rm: async (path: string, options: import("node:fs").RmOptions) => {
      if (fault.rm && options.recursive) {
        await fs.rm(join(path, "src"), { recursive: true });
        throw new Error("partial removal");
      }
      return fs.rm(path, options);
    },
    rename: async (a: string, b: string) => {
      if (fault.rename) throw new Error("failed swap");
      return fs.rename(a, b);
    },
  };
});

let dir: string;
let source: string;
let path: string;
let worktrees: string;
const now = Date.parse("2026-10-24T12:00:00Z");
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
const input = (id: string, checkoutStrategy: "shared" | "separate" = "separate") => ({
  id,
  repoId: "shop-app",
  source,
  branch: "feature/harbor",
  checkoutStrategy,
});
const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error("missing fixture");
  return value;
};
const session = (id: string) => required(loadConfig(path).crew?.sessions.find((s) => s.id === id));
const close = async (id: string) => {
  const result = await closeSession(path, id, () => true, now, session(id));
  return removeSessionCheckout(result.session, result.worktrees);
};

beforeEach(() => {
  fault.rename = false;
  fault.rm = false;
  dir = mkdtempSync(join(tmpdir(), "mc-session-actions-"));
  source = join(dir, "harbor");
  path = join(dir, "config.yaml");
  worktrees = join(dir, "runs");
  mkdirSync(source);
  git(source, "init", "-b", "feature/harbor");
  mkdirSync(join(source, "src"));
  mkdirSync(join(source, ".github"));
  writeFileSync(join(source, "src", "harbor.txt"), "harbor\n");
  writeFileSync(join(source, ".github", "fixture.txt"), "fixture\n");
  git(source, "add", ".");
  git(source, "commit", "-qm", "fixture");
  git(source, "update-ref", "refs/remotes/origin/feature/harbor", "HEAD");
  git(source, "remote", "add", "origin", "https://github.com/octo-org/shop-app.git");
  const doc = parseDocument(
    readFileSync(resolve(import.meta.dirname, "../../../config.example.yaml"), "utf8"),
  );
  doc.setIn(["crew", "node"], process.execPath);
  doc.setIn(["crew", "worktrees"], worktrees);
  doc.setIn(["crew", "sessions"], []);
  writeFileSync(path, doc.toString());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("session actions", () => {
  it("creates independent sessions for one repo and returns real top-level folders", async () => {
    const before = readFileSync(join(source, ".git", "config"), "utf8");
    const first = await createSession(path, input("harbor-one"), now);
    await createSession(path, input("harbor-two"), now);
    expect(first.folders).toEqual([".github", "src"]);
    expect(loadConfig(path).crew?.sessions.map((s) => s.id)).toEqual(["harbor-one", "harbor-two"]);
    expect(session("harbor-one").checkout).not.toBe(session("harbor-two").checkout);
    expect(readFileSync(join(source, ".git", "config"), "utf8")).toBe(before);
    expect(git(source, "status", "--porcelain")).toBe("");
  });

  it("preserves upstream HEAD when the source is on a feature branch", async () => {
    git(source, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(source, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    writeFileSync(join(source, "src", "harbor.txt"), "feature commit");
    git(source, "commit", "-am", "feature");
    git(source, "update-ref", "refs/remotes/origin/feature/harbor", "HEAD");
    git(source, "branch", "source-only");
    git(source, "tag", "source-tag");
    await createSession(path, input("harbor-one"), now);
    const checkout = session("harbor-one").checkout;
    expect(git(checkout, "symbolic-ref", "refs/remotes/origin/HEAD")).toBe(
      "refs/remotes/origin/main",
    );
    expect(git(checkout, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags")).toBe(
      "refs/heads/feature/harbor",
    );
    expect(git(checkout, "rev-parse", "refs/remotes/origin/main")).not.toBe(
      git(checkout, "rev-parse", "HEAD"),
    );
    // later fetches bring every branch, so origin's default branch keeps up after main moves
    expect(git(checkout, "config", "--get-all", "remote.origin.fetch")).toBe(
      "+refs/heads/*:refs/remotes/origin/*",
    );
    writeFileSync(join(checkout, ".DS_Store"), "finder");
    expect(await close("harbor-one")).toBe("removed");
  });

  it("reports partial removal separately from unproven ownership", async () => {
    await createSession(path, input("harbor-one"), now);
    const checkout = session("harbor-one").checkout;
    fault.rm = true;
    expect(await close("harbor-one")).toBe("removal-failed-partway");
    expect(existsSync(checkout)).toBe(true);
    expect(existsSync(join(checkout, "src"))).toBe(false);
  });

  it("refuses duplicate ids, branch mismatch and shared checkout overlap", async () => {
    await createSession(path, input("harbor-one", "shared"), now);
    await expect(createSession(path, input("harbor-one"), now)).rejects.toMatchObject({
      kind: "duplicate",
    });
    await expect(createSession(path, input("harbor-two", "shared"), now)).rejects.toMatchObject({
      kind: "invalid",
    });
    await close("harbor-one");
    git(source, "branch", "feature/other");
    await expect(
      createSession(path, { ...input("harbor-three", "shared"), branch: "feature/other" }, now),
    ).rejects.toThrow("different branch");
  });

  it("rolls back a newly owned clone when the atomic save fails", async () => {
    const before = readFileSync(path, "utf8");
    fault.rename = true;
    await expect(createSession(path, input("harbor-one"), now)).rejects.toMatchObject({
      kind: "write",
    });
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(managedSessionPath(worktrees, "harbor-one"))).toBe(false);
    expect(existsSync(source)).toBe(true);
  });

  it("never deletes unmanaged checkouts", async () => {
    await createSession(path, input("harbor-one", "shared"), now);
    expect(await close("harbor-one")).toBe("unmanaged");
    expect(existsSync(source)).toBe(true);
  });

  it.each(["dirty", "untracked", "unpushed", "stash", "branch", "ignored"])(
    "keeps a managed clone with %s data",
    async (kind) => {
      await createSession(path, input("harbor-one"), now);
      const checkout = session("harbor-one").checkout;
      git(checkout, "update-ref", "refs/remotes/origin/feature/harbor", "HEAD");
      if (kind === "dirty") writeFileSync(join(checkout, "src", "harbor.txt"), "changed\n");
      if (kind === "untracked") writeFileSync(join(checkout, "notes.txt"), "notes\n");
      if (kind === "ignored") {
        writeFileSync(join(checkout, ".git", "info", "exclude"), "ignored.txt\n");
        writeFileSync(join(checkout, "ignored.txt"), "keep");
      }
      if (kind === "stash") {
        writeFileSync(join(checkout, "src", "harbor.txt"), "stash");
        git(checkout, "stash");
      }
      if (kind === "branch") git(checkout, "checkout", "-b", "local");
      if (kind === "unpushed" || kind === "branch") {
        writeFileSync(join(checkout, "src", "harbor.txt"), "changed\n");
        git(checkout, "commit", "-am", "local change");
      }
      expect(await close("harbor-one")).toBe(
        ["unpushed", "stash", "branch"].includes(kind) ? "retained-unpushed" : "retained-dirty",
      );
      expect(existsSync(checkout)).toBe(true);
      await expect(createSession(path, input("harbor-one"), now)).rejects.toThrow(checkout);
    },
  );

  it("removes only a proven clean owned clone whose commits are upstream", async () => {
    await createSession(path, input("harbor-one"), now);
    await createSession(path, input("harbor-two"), now);
    const checkout = session("harbor-one").checkout;
    expect(await close("harbor-one")).toBe("removed");
    expect(existsSync(checkout)).toBe(false);
    expect(existsSync(session("harbor-two").checkout)).toBe(true);
    expect(existsSync(source)).toBe(true);
  });

  it("keeps registered worktrees and commits still held by reflogs", async () => {
    await createSession(path, input("harbor-one"), now);
    const checkout = session("harbor-one").checkout;
    const linked = join(dir, "active-worktree");
    git(checkout, "worktree", "add", "--detach", linked, "HEAD");
    expect(await close("harbor-one")).toBe("retained-unproven");
    expect(existsSync(linked)).toBe(true);
    expect(existsSync(checkout)).toBe(true);
    await createSession(path, input("harbor-two"), now);
    const other = session("harbor-two").checkout;
    writeFileSync(join(other, "src", "harbor.txt"), "local change");
    git(other, "commit", "-am", "local change");
    git(other, "reset", "--hard", "HEAD~1");
    expect(await close("harbor-two")).toBe("retained-unpushed");
    expect(existsSync(other)).toBe(true);
  });

  it("retains clones without upstream evidence or matching ownership", async () => {
    git(source, "update-ref", "-d", "refs/remotes/origin/feature/harbor");
    await createSession(path, input("harbor-one"), now);
    const owned = session("harbor-one");
    expect(await removeSessionCheckout(owned, worktrees)).toBe("retained-unpushed");
    expect(
      await removeSessionCheckout(
        { ...owned, managedCheckout: { ...required(owned.managedCheckout), token: "wrong" } },
        worktrees,
      ),
    ).toBe("retained-unproven");
    expect(existsSync(owned.checkout)).toBe(true);
  });

  it("refuses observed-loop destinations, linked worktrees and aliased checkouts", async () => {
    const doc = parseDocument(readFileSync(path, "utf8"));
    doc.setIn(["loops", 0, "worktree"], source);
    writeFileSync(path, doc.toString());
    await expect(createSession(path, input("harbor-one", "shared"), now)).rejects.toMatchObject({
      kind: "invalid",
    });
    await expect(createSession(path, input("harbor-one"), now)).rejects.toThrow(
      "shares its git repository",
    );
    doc.setIn(["loops", 0, "worktree"], join(dir, "observed"));
    writeFileSync(path, doc.toString());
    await createSession(path, input("harbor-one", "shared"), now);
    const alias = join(dir, "alias");
    symlinkSync(source, alias);
    await expect(
      createSession(path, { ...input("harbor-two", "shared"), source: alias }, now),
    ).rejects.toMatchObject({ kind: "invalid" });
  });

  it("refuses missing branches and repo mismatches without creating a destination", async () => {
    await expect(
      createSession(path, { ...input("harbor-one"), branch: "feature/missing" }, now),
    ).rejects.toMatchObject({ kind: "invalid" });
    await expect(
      createSession(path, { ...input("harbor-one"), repoId: "site-builder" }, now),
    ).rejects.toThrow("origin does not match");
    expect(existsSync(managedSessionPath(worktrees, "harbor-one"))).toBe(false);
    const linked = join(dir, "linked");
    git(source, "worktree", "add", "--detach", linked, "HEAD");
    await expect(
      createSession(path, { ...input("harbor-one"), source: linked }, now),
    ).rejects.toThrow("standalone clone");
    expect(existsSync(linked)).toBe(true);
  });

  it("never adopts or removes an unmanaged directory at the managed destination", async () => {
    const destination = managedSessionPath(worktrees, "harbor-one");
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, "keep.txt"), "keep");
    await expect(createSession(path, input("harbor-one"), now)).rejects.toThrow(
      "destination already exists",
    );
    expect(readFileSync(join(destination, "keep.txt"), "utf8")).toBe("keep");
    expect(loadConfig(path).crew?.sessions).toEqual([]);
  });

  it("closes stopped seats, but refuses idle seats and concurrent config changes", async () => {
    await createSession(path, input("harbor-one", "shared"), now);
    await setSessionSeats(
      path,
      "harbor-one",
      [],
      [{ id: "pilot", role: "GUIDO", accountId: "claude-main", model: "sonnet", area: [] }],
      now,
    );
    const config = loadConfig(path);
    const store = new Store(":memory:");
    const bus = new ChangeBus();
    const reloader = createCrewReloader({
      configPath: path,
      config,
      store,
      bus,
      supervisor: { on: () => () => {}, seatBusy: () => false },
    });
    const row = {
      seatId: "pilot",
      runId: null,
      cliSessionId: null,
      reason: null,
      worktree: null,
      updatedAt: now,
    };
    const save = () =>
      required(reloader.removeSession)("harbor-one", (stopped, expected) =>
        closeSession(path, "harbor-one", stopped, now, expected),
      );
    try {
      store.setSeatSession({ ...row, state: "idle" });
      await expect(save()).rejects.toThrow("Stop or remove the 1 agent(s)");
      store.setSeatSession({ ...row, state: "stopped" });
      const aside = vi
        .spyOn(store, "asideRuns")
        .mockReturnValue([{ agentId: "pilot" } as ReturnType<Store["asideRuns"]>[number]]);
      await expect(save()).rejects.toThrow("Stop or remove the 1 agent(s)");
      aside.mockRestore();
      const activeRun = vi
        .spyOn(store, "seatRun")
        .mockReturnValue({ endedAt: null } as ReturnType<Store["seatRun"]>);
      await expect(save()).rejects.toThrow("Stop or remove the 1 agent(s)");
      activeRun.mockRestore();

      const doc = parseDocument(readFileSync(path, "utf8"));
      doc.setIn(["crew", "sessions", 0, "branch"], "feature/other");
      writeFileSync(path, doc.toString());
      await expect(save()).rejects.toThrow("session changed on disk");
      doc.setIn(["crew", "sessions", 0, "branch"], "feature/harbor");
      writeFileSync(path, doc.toString());
      await save();
      expect(config.crew?.sessions).toEqual([]);
      expect(existsSync(source)).toBe(true);
    } finally {
      store.close();
    }
  });

  it("refuses active agents and restores live membership after a failed save", async () => {
    await createSession(path, input("harbor-one", "shared"), now);
    const config = loadConfig(path);
    const store = new Store(":memory:");
    const bus = new ChangeBus();
    const reloader = createCrewReloader({
      configPath: path,
      config,
      store,
      bus,
      supervisor: { on: () => () => {}, seatBusy: () => false },
    });
    try {
      required(config.crew?.sessions[0]).seats.push({
        id: "pilot",
        role: "GUIDO",
        accountId: "claude-main",
        model: "sonnet",
        area: [],
      });
      await expect(
        required(reloader.removeSession)("harbor-one", async () => {
          throw new Error("must not run");
        }),
      ).rejects.toThrow("Stop or remove the 1 agent(s)");
      required(config.crew?.sessions[0]).seats = [];
      fault.rename = true;
      await expect(
        required(reloader.removeSession)("harbor-one", (stopped, expected) => {
          expect(config.crew?.sessions).toEqual([]);
          return closeSession(path, "harbor-one", stopped, now, expected);
        }),
      ).rejects.toMatchObject({ kind: "write" });
      expect(config.crew?.sessions.map((s) => s.id)).toEqual(["harbor-one"]);
      fault.rename = false;
      await required(reloader.removeSession)("harbor-one", (stopped, expected) =>
        closeSession(path, "harbor-one", stopped, now, expected),
      );
      expect(config.crew?.sessions).toEqual([]);
      expect(reloader.status().sessions).toEqual([]);
    } finally {
      store.close();
    }
  });
  it.each(["process", "run", "aside"])(
    "defers live add while another session has an active %s",
    async (kind) => {
      await createSession(path, input("harbor-one", "shared"), now);
      await setSessionSeats(
        path,
        "harbor-one",
        [],
        [{ id: "pilot", role: "GUIDO", accountId: "claude-main", model: "sonnet", area: [] }],
        now,
      );
      const config = loadConfig(path);
      const store = new Store(":memory:");
      const reloader = createCrewReloader({
        configPath: path,
        config,
        store,
        bus: new ChangeBus(),
        supervisor: { on: () => () => {}, seatBusy: () => kind === "process" },
      });
      const run = vi
        .spyOn(store, "seatRun")
        .mockReturnValue(
          kind === "run" ? ({ endedAt: null } as ReturnType<Store["seatRun"]>) : undefined,
        );
      const aside = vi
        .spyOn(store, "asideRuns")
        .mockReturnValue(
          kind === "aside" ? [{ agentId: "pilot" } as ReturnType<Store["asideRuns"]>[number]] : [],
        );
      try {
        await createSession(path, input("harbor-two"), now, config);
        expect((await reloader.reload()).restartNeeded).toContain("crew.sessions");
        expect(config.crew?.sessions.map((s) => s.id)).toEqual(["harbor-one"]);
      } finally {
        run.mockRestore();
        aside.mockRestore();
        store.close();
      }
    },
  );

  it("adds and closes through the routes, applying membership live without sockets", async () => {
    const config = loadConfig(path);
    const store = new Store(":memory:");
    const bus = new ChangeBus();
    const crewReloader = createCrewReloader({
      configPath: path,
      config,
      store,
      bus,
      supervisor: { on: () => () => {}, seatBusy: () => false },
    });
    const app = buildApp({ config, store, bus, configPath: path, crewReloader, seatWrites: true });
    const post = (url: string, payload: object) =>
      app.inject({ method: "POST", url, payload, headers: { "content-type": "application/json" } });
    try {
      expect(
        (await post("/api/crew/sessions", { ...input("harbor-one"), extra: true })).statusCode,
      ).toBe(400);
      const added = await post("/api/crew/sessions", input("harbor-one"));
      expect(added.statusCode).toBe(200);
      expect(added.json().folders).toEqual([".github", "src"]);
      expect(config.crew?.sessions.map((s) => s.id)).toEqual(["harbor-one"]);
      expect((await post("/api/crew/sessions", input("harbor-one"))).statusCode).toBe(409);
      const closed = await post("/api/crew/sessions/harbor-one/close", {});
      expect(closed.statusCode).toBe(200);
      expect(closed.json().checkout).toBe("removed");
      expect(closed.json().retainedPath).toBeNull();
      expect(config.crew?.sessions).toEqual([]);
      expect((await post("/api/crew/sessions/harbor-one/close", {})).statusCode).toBe(404);
      await post("/api/crew/sessions", input("harbor-two"));
      const checkout = session("harbor-two").checkout;
      git(checkout, "worktree", "add", "--detach", join(dir, "seat-worktree"), "HEAD");
      const retained = await post("/api/crew/sessions/harbor-two/close", {});
      expect(retained.statusCode).toBe(200);
      expect(retained.json().retainedPath).toBe(checkout);
      expect(retained.json().outcome).toContain("unproven");
    } finally {
      await app.close();
      store.close();
    }
  });
});
