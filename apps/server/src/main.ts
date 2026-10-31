/**
 * Mission Control server: loads config, opens the store, starts the collectors' scheduler and serves
 * the API on 127.0.0.1:7420 (loopback only; mutating routes need the operator token in <data dir>/operator-token).
 *   MC_CONFIG  config path (default ~/.config/mission-control/config.yaml)
 *   MC_DB      sqlite path (default ~/.local/share/mission-control/mc.sqlite; its dir is created 0700)
 *   MC_PORT    port (default 7420; 1024–65535), e.g. for a preview server beside the live hub
 *   MC_NO_LOOP_WRITES  `1`: Pause/Resume answer 409 and never write into a loop (preview servers);
 *               this, or any port but 7420, also makes the server a preview that Update refuses
 *               and that runs no crew
 *   MC_NO_CREW  `1`: the crew supervisor is off: nothing is started or resumed, crew actions answer
 *               409 (any server)
 *   MC_CREW     `1`: a preview runs crew after all (it still needs the crew lock)
 *   MC_GH_COMMAND  the gh the engine's PR step runs (a fake one for a crew trial); honoured only by
 *               a preview started with MC_CREW=1, ignored (and logged) anywhere else
 *   MC_DEBUG   `1`: debug lines on stderr (each backfill tick's run count and duration)
 */

import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { LOOPBACK_HOST, type RepoId } from "@mc/core";
import { buildApp, crewGuardDeps } from "./api.ts";
import { createBranchTidy, SWEEP_EVERY_MS, TIDY_EVERY_MS } from "./branch-tidy.ts";
import { ChangeBus } from "./bus.ts";
import { claimAs, readLogin } from "./claim.ts";
import { CliHold } from "./cli-update.ts";
import {
  fetchBoard,
  fetchCardNow,
  fetchQueueCard,
  fetchTicket,
  githubToken,
  makeGql,
} from "./collectors/github.ts";
import { commsInboxContext } from "./comms.ts";
import {
  ConfigError,
  configuredAgents,
  crewAllowed,
  findHubRoot,
  isPreview,
  loadConfig,
  portFromEnv,
} from "./config.ts";
import { createCrewReloader } from "./crew-apply.ts";
import {
  messageUnpausedSeat,
  pauseAwareSupervisor,
  pausedSeat,
  startUnpausedRun,
} from "./crew-pause.ts";
import { createEngine } from "./engine/engine.ts";
import { createPublisher } from "./engine/publish.ts";
import { refillQueues, takeNext } from "./engine/queue.ts";
import { RepoRulesError, readRepoRules } from "./engine/rules.ts";
import { refreshAuthors } from "./flight/collaborators.ts";
import { renderHudInHelper } from "./flight/hud-render.ts";
import { hudShotStore } from "./flight/hud-store.ts";
import { createFlightTools } from "./flight/tools.ts";
import { createFlightWatch } from "./flight/watch.ts";
import { checkCardFieldOptions, editCardFields, type Move, moveCard } from "./github-board.ts";
import { cloneState, configuredChecks, createCheckRecorder } from "./guard/check-runs.ts";
import { lockChanged, TestLock } from "./guard/lock.ts";
import { markHubStarted } from "./hud.ts";
import {
  MACHINE_CAPACITY_DEFAULTS,
  machineCapacity,
  machineCapacitySince,
} from "./machine-capacity.ts";
import { CallRing, type RingSource } from "./map/ring.ts";
import { createGh, ghCommand } from "./mcp/gh.ts";
import { McpCalls } from "./mcp/server.ts";
import { RunTokens } from "./mcp/tokens.ts";
import { createMcTools, KNOWN_SECRETS_TIMEOUT_MS, type McToolsDeps } from "./mcp/tools.ts";
import { newOperatorToken, writeOperatorToken } from "./operator.ts";
import { PREVIEW_ACTIVITY_HEADER, PreviewManager } from "./previews.ts";
import { loadProfiles, PROFILES_FILE } from "./profiles.ts";
import { type QueueReorderDeps, reorderQueue } from "./queue-reorder.ts";
import { startCodexDiscovery } from "./runtime/codex-discovery.ts";
import { restoreRuns } from "./runtime/restore.ts";
import { createSupervisor } from "./runtime/supervisor.ts";
import { createScheduler, refreshOnSeatFree } from "./scheduler.ts";
import { setSeatFocus } from "./seat-focus.ts";
import { onSignal } from "./shutdown.ts";
import { crewDir, Store } from "./store.ts";
import {
  createAutoUpdate,
  createHeldUpdateNote,
  createUpdater,
  crewRefusal,
  headSha,
  UPDATE_LOG,
} from "./update.ts";

export const HOST = LOOPBACK_HOST;
/** `pnpm build` output of apps/web, served by this process. */
const WEB_ROOT = fileURLToPath(new URL("../../web/dist", import.meta.url));

export async function main(): Promise<void> {
  const configPath =
    process.env.MC_CONFIG ?? join(homedir(), ".config", "mission-control", "config.yaml");
  // absolute: the crew's prompt and transcript paths derive from it, and a seat runs elsewhere
  const dbPath = resolve(
    process.env.MC_DB ?? join(homedir(), ".local", "share", "mission-control", "mc.sqlite"),
  );

  let config: ReturnType<typeof loadConfig>;
  let port: number;
  try {
    port = portFromEnv(process.env.MC_PORT);
    config = loadConfig(configPath);
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`config error: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
  const preview = isPreview(port, process.env);
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(dbPath), 0o700); // tighten a directory that already existed, too
  const operatorToken = newOperatorToken(); // per boot; seats cannot read the data dir
  writeOperatorToken(dirname(dbPath), operatorToken);
  const hubStartedAt = Date.now();
  markHubStarted(hubStartedAt);
  const store = new Store(dbPath);
  const bus = new ChangeBus();
  const previewRoot = join(dirname(dbPath), "previews");
  if (!preview) {
    await rm(previewRoot, { recursive: true, force: true });
    await Promise.all(
      (config.crew?.sessions ?? []).map(({ checkout }) =>
        runPreviewCommand("git", ["-C", checkout, "worktree", "prune"]).catch(() => {}),
      ),
    );
  }
  const previewCheckouts = new Map<string, { checkout: string; worktree: string; ref: string }>();
  const previews = isPreview(port, process.env)
    ? undefined
    : new PreviewManager({
        capacity: () => {
          const capacityConfig = config.crew?.machineCapacity;
          const c = capacityConfig ?? MACHINE_CAPACITY_DEFAULTS;
          return machineCapacity(
            store.machineSamples(machineCapacitySince(Date.now(), c)),
            Date.now(),
            c,
          );
        },
        exists: async (candidate) =>
          await new Promise<boolean>((resolve) => {
            const probe = createServer();
            probe.once("error", () => resolve(true));
            probe.listen({ host: HOST, port: candidate }, () => probe.close(() => resolve(false)));
          }),
        start: async ({ pr, branch: _branch, checkout, port: previewPort, token, signal }) => {
          const root = join(previewRoot, String(pr));
          const previewDb = join(root, "mc.sqlite");
          const worktree = join(root, "worktree");
          const previewRef = `refs/mc-preview/${pr}`;
          let child: ChildProcess | null = null;
          try {
            await rm(root, { recursive: true, force: true });
            mkdirSync(root, { recursive: true, mode: 0o700 });
            chmodSync(root, 0o700);
            const source = new DatabaseSync(dbPath);
            try {
              source.prepare("VACUUM INTO ?").run(previewDb);
            } finally {
              source.close();
            }
            await runPreviewCommand(
              "git",
              ["-C", checkout, "fetch", "origin", `+pull/${pr}/head:${previewRef}`],
              undefined,
              signal,
            );
            await runPreviewCommand(
              "git",
              ["-C", checkout, "worktree", "add", "-f", "--detach", worktree, previewRef],
              undefined,
              signal,
            );
            previewCheckouts.set(previewDb, { checkout, worktree, ref: previewRef });
            await runPreviewCommand(
              "pnpm",
              ["install", "--offline", "--frozen-lockfile"],
              worktree,
              signal,
            );
            await runPreviewCommand("pnpm", ["--filter", "@mc/web", "build"], worktree, signal);
            child = spawn(
              process.execPath,
              ["--experimental-strip-types", "apps/server/src/main.ts"],
              {
                cwd: worktree,
                env: previewEnvironment(previewPort, previewDb, pr, token, port),
                stdio: "ignore",
                signal,
              },
            );
            const started = child;
            await waitForPreview(started, previewPort, signal);
            return {
              dbPath: previewDb,
              stop: async () => await stopPreview(started),
            };
          } catch (e) {
            if (child) await stopPreview(child).catch(() => {});
            const checkoutInfo = previewCheckouts.get(previewDb);
            if (checkoutInfo) {
              await runPreviewCommand("git", [
                "-C",
                checkoutInfo.checkout,
                "worktree",
                "remove",
                "--force",
                checkoutInfo.worktree,
              ]).catch(() => {});
              await runPreviewCommand("git", [
                "-C",
                checkoutInfo.checkout,
                "update-ref",
                "-d",
                checkoutInfo.ref,
              ]).catch(() => {});
              previewCheckouts.delete(previewDb);
            }
            await rm(root, { recursive: true, force: true });
            throw e;
          }
        },
        remove: async (previewDb) => {
          const checkoutInfo = previewCheckouts.get(previewDb);
          if (checkoutInfo) {
            await runPreviewCommand("git", [
              "-C",
              checkoutInfo.checkout,
              "worktree",
              "remove",
              "--force",
              checkoutInfo.worktree,
            ]).catch(() => {});
            await runPreviewCommand("git", [
              "-C",
              checkoutInfo.checkout,
              "update-ref",
              "-d",
              checkoutInfo.ref,
            ]).catch(() => {});
            previewCheckouts.delete(previewDb);
          }
          await rm(dirname(previewDb), { recursive: true, force: true });
        },
      });
  // per-run bearer tokens for /mcp and the guard: the supervisor issues one at each spawn and
  // revokes it at the process's exit
  const tokens = new RunTokens();
  // the /mcp calls in flight: a restart lets them finish before it lets go of the crew
  const mcpCalls = new McpCalls();
  // one full suite at a time across every seat; the supervisor frees a run's hold when its call
  // ends, its turn ends or its process exits
  const lock = new TestLock({ onChange: lockChanged(bus), holds: store, log: (line) => log(line) });
  // set by the CLI update check while the CLI fails its smoke test: no run starts or resumes
  const cliHold = new CliHold();
  let browserStreamCount = 0;
  const scheduler = createScheduler({
    config,
    teamsEnabled: !isPreview(port, process.env),
    store,
    bus,
    cliHold,
    debug:
      process.env.MC_DEBUG === "1" ? (line) => process.stderr.write(`cc: ${line}\n`) : undefined,
    log: (line) => log(line),
    lockState: () => lock.state(),
    hasViewClients: () => browserStreamCount > 0,
    // lazy: the updater is built below; the check only runs once the scheduler starts
    autoUpdate: () => autoUpdate?.() ?? Promise.resolve("off"),
    deliverDefault: async (seatId, text) => {
      await supervisor.message(seatId, text, { interrupt: false });
    },
  });
  const previewActivity = (() => {
    const url = process.env.MC_PREVIEW_ACTIVITY_URL;
    const token = process.env.MC_PREVIEW_ACTIVITY_TOKEN;
    if (!url || !token) return undefined;
    return () => {
      void fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", [PREVIEW_ACTIVITY_HEADER]: token },
        body: "{}",
      }).catch(() => {});
    };
  })();
  const previewParentPid = process.env.MC_PREVIEW_PARENT_PID;
  if (preview && previewParentPid !== undefined) {
    const parentPid = Number(previewParentPid);
    if (Number.isSafeInteger(parentPid) && parentPid > 1) {
      setInterval(() => {
        try {
          process.kill(parentPid, 0);
        } catch {
          process.exit(0);
        }
      }, 15_000).unref();
    }
  }
  // The hub's own checkout: Update runs in it, and seats run the guard hook from it.
  const hubRoot = findHubRoot();
  // An implicit branch preview reads the live config as its snapshot, but must never write it.
  const writableConfigPath =
    !preview || process.env.MC_CONFIG !== undefined ? configPath : undefined;
  const previewRepoId = config.crew?.sessions.find(
    (session) => hubRoot !== null && resolve(session.checkout) === hubRoot,
  )?.repoId;
  // The `gh` login this hub claims tickets as, read once below; null leaves the engine taking nothing.
  let hubLogin: string | null = null;
  // A repo's board rules as the engine reads them: the queue, FLIGHT and every start use them.
  const engineRules = async (repoId: RepoId, mainSha?: string) => {
    const repo = config.repos.find((r) => r.id === repoId);
    const session = config.crew?.sessions.find((s) => s.repoId === repoId);
    if (repo === undefined || session === undefined) {
      return new RepoRulesError(`${repoId}: no crew session reads this repo's rules`);
    }
    const notes: string[] = [];
    const rules = await readRepoRules(repo.github, session.checkout, repo.rules, notes, mainSha);
    for (const note of notes) log(`engine: ${note}`);
    return rules;
  };
  // The checks a repo configures (`mc.checks`): seats' shell calls are recorded against the commit
  // they ran on, and `mc push` asks for the record.
  const runChecks = configuredChecks(store, engineRules);
  const checkRecorder = createCheckRecorder({
    store,
    checks: runChecks,
    state: cloneState(config, store),
    log: (line) => log(line),
  });
  // Crew runs only on a server that may (the live hub, or a preview told MC_CREW=1), only with a
  // crew config, and only where the guard hook can be found.
  const crewEnabled =
    crewAllowed(preview, process.env) && config.crew !== undefined && hubRoot !== null;
  // The template profiles sit beside config.yaml; read afresh for each start, never cached.
  const profilesPath = join(dirname(configPath), PROFILES_FILE);
  const profiles = () => loadProfiles(profilesPath);
  const supervisor = createSupervisor({
    config,
    store,
    bus,
    dbPath,
    rules: engineRules,
    login: () => hubLogin,
    profiles,
    checks: checkRecorder,
    fetchTicket: async (repo, n) => fetchTicket(repo, n, makeGql(await githubToken())),
    // lazy: `gh` is declared below
    claim: (repo, n) => claimAs(gh, hubRoot ?? process.cwd(), () => hubLogin)(repo, n),
    enabled: crewEnabled,
    tokens,
    lock,
    cliHold,
    hubPort: port,
    hubRoot: hubRoot ?? "",
    inbox: (seatId, runId) => commsInboxContext(store, seatId, runId),
  });
  // a seat that frees up is about to take new work: read the boards first
  refreshOnSeatFree(
    (fn) => supervisor.on(fn),
    () => scheduler.refreshBoards(),
  );

  // Lines from before the server exists (and the mc tools' own) go to the server log once it does.
  const early: string[] = [];
  let log: (line: string) => void = (line) => void early.push(line);
  const gh = createGh(ghCommand(process.env, preview, (line) => log(line)));
  if (config.crew !== undefined) {
    hubLogin = await readLogin(gh, hubRoot ?? process.cwd());
    if (hubLogin === null) log("gh: could not read the signed-in login; the engine takes nothing");
  }

  // The mc tools: commit and push run in the session clone's queue, the one the supervisor's
  // checkouts use. The push and PR scans read the GitHub token afresh for each call.
  const deliverComms = (seatId: string, _text: string, _from: string): void => {
    void messageUnpausedSeat(store, supervisor, seatId, "", {
      interrupt: false,
      questions: "none",
    }).catch((e: unknown) => {
      log(
        `comms: could not deliver inbox to ${seatId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  };
  const mcDeps: McToolsDeps = {
    config,
    store,
    bus,
    inClone: (checkout, fn) => supervisor.inClone(checkout, fn),
    profiles,
    checks: runChecks,
    checkDrops: (runId) => checkRecorder.drops(runId),
    gh,
    dbPath,
    // its own timeout: a hung gh is killed, not only abandoned (readKnown has a timeout too)
    knownSecrets: async () => [await githubToken(KNOWN_SECRETS_TIMEOUT_MS)],
    log: (line) => log(line),
    onEvidence: (seatId, runId) => supervisor.emitEvidence(seatId, runId),
    onFindings: (seatId, runId) => supervisor.emitFindings(seatId, runId),
    onPlanned: (_s, runId) => {
      supervisor.endRunByEngine(runId).catch((e: unknown) => {
        log(
          `mc report_plan: could not end ${runId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    },
    crewIds: () => config.crew?.sessions.flatMap((s) => s.seats.map((seat) => seat.id)) ?? [],
    onComms: deliverComms,
  };
  const mcTools = createMcTools(mcDeps);

  // The first loop's engine: off in a preview (or with MC_NO_LOOP_WRITES=1), with crew off, and
  // while another process holds the crew lock. It makes the pushes and PRs the seats' report
  // asks for, and moves each run's card.
  const engineOn =
    !preview &&
    process.env.MC_NO_LOOP_WRITES !== "1" &&
    config.crew !== undefined &&
    hubRoot !== null;
  /** Each seat's consecutive transient take failures; one map for the hub's life. */
  const transientTakes = new Map<string, number>();
  const engineBoard = {
    edit: async (repoId: string, issue: number, fields: { size?: string; priority?: string }) =>
      editCardFields({ gql: makeGql(await githubToken()), store, config }, repoId, issue, fields),
    checkFields: async (repoId: string, fields: { size?: string; priority?: string }) =>
      checkCardFieldOptions({ gql: makeGql(await githubToken()), config }, repoId, fields),
    read: async (repoId: string, issue: number) => {
      const repo = config.repos.find((r) => r.id === repoId);
      return repo === undefined
        ? null
        : fetchQueueCard(repo, issue, makeGql(await githubToken()), Date.now());
    },
    move: async (m: Move) => {
      const moved = await moveCard({ gql: makeGql(await githubToken()), store, config }, m);
      // a card that moved shows on the boards now, not at the next poll
      if (moved.ok && moved.changed) scheduler.refreshBoards();
      return moved;
    },
  };
  const engine = createEngine({
    config,
    store,
    bus,
    supervisor,
    publisher: createPublisher(mcDeps),
    board: engineBoard,
    pollGithub: () => scheduler.refreshBoards(),
    fetchTicket: async (repo, n) => fetchTicket(repo, n, makeGql(await githubToken())),
    rules: engineRules,
    refillQueues: () =>
      refillQueues({
        config,
        store,
        rules: engineRules,
        login: hubLogin,
        fetchTicket: async (repo, n) => fetchTicket(repo, n, makeGql(await githubToken())),
        profiles,
        now: Date.now,
        onNotes: () => bus.emit("attention"),
      }),
    takeNext: (seatId) =>
      takeNext(
        {
          config,
          store,
          supervisor,
          login: hubLogin,
          rules: engineRules,
          readCard: async (repoId, issue) => {
            const repo = config.repos.find((r) => r.id === repoId);
            return repo === undefined
              ? null
              : fetchCardNow(repo, issue, makeGql(await githubToken()));
          },
          enabled: engineOn,
          transientTakes,
          now: Date.now,
          log: (line) => log(`engine: ${line}`),
          onNotes: () => bus.emit("attention"),
        },
        seatId,
      ),
    enabled: engineOn,
    crewOn: () => supervisor.status().enabled,
    hubStartedAt,
    log: (line) => log(`engine: ${line}`),
  });
  mcDeps.syncMain = (runId) => engine.writerSyncMain(runId);
  scheduler.setEngine(engine);

  const queueReorder: QueueReorderDeps = {
    config,
    store,
    rules: engineRules,
    profiles,
    get login() {
      return hubLogin;
    },
    enabled: () => engine.status().on && supervisor.status().enabled,
    now: Date.now,
    readBoard: async (repoId) => {
      const repo = config.repos.find((r) => r.id === repoId);
      if (!repo) throw new Error("Repository unavailable.");
      return (await fetchBoard(repo, makeGql(await githubToken()), Date.now())).items;
    },
    readCard: async (repoId, issue) => {
      const repo = config.repos.find((r) => r.id === repoId);
      if (!repo) throw new Error("Repository unavailable.");
      return fetchQueueCard(repo, issue, makeGql(await githubToken()), Date.now());
    },
    fetchTicket: async (repo, n) => fetchTicket(repo, n, makeGql(await githubToken())),
    edit: (repoId, issue, fields) => engineBoard.edit(repoId, issue, fields),
  };

  // FLIGHT's HUD screenshots are kept under the private data dir, for a week.
  const hudShots = hudShotStore(join(dirname(dbPath), "hud-screenshots"));

  // FLIGHT's mc tools: after the engine, which later tools wake.
  const flightTools = createFlightTools({
    hudShots,
    hubOrigin: `http://${HOST}:${port}`,
    screenshotHud: renderHudInHelper,
    focus: (seatId, focus) => {
      if (preview && process.env.MC_CONFIG === undefined)
        throw new Error("Focus writes unavailable.");
      return setSeatFocus(config, configPath, crewReloader, seatId, focus, Date.now());
    },
    queueReorder: (seatId, move, above) => reorderQueue(queueReorder, seatId, move, above),
    seen: (runId, state) => flightWatch.seen(runId, state),
    config,
    store,
    bus,
    supervisor: {
      ...supervisor,
      startRun: (...args) => startUnpausedRun(store, supervisor, ...args),
      message: (...args) => messageUnpausedSeat(store, supervisor, ...args),
    },
    login: hubLogin,
    lockState: () => lock.state(),
    profiles,
    gh,
    dbPath,
    knownSecrets: mcDeps.knownSecrets,
    log: (line) => log(line),
    engine,
    rules: engineRules,
    board: engineBoard,
    fetchTicket: async (repo, n) => fetchTicket(repo, n, makeGql(await githubToken())),
  });

  // Keeps FLIGHT running and wakes it with a digest; off with the engine (preview, no loop writes).
  const flightWatch = createFlightWatch({
    refreshAuthors: async (repoId) => {
      const repo = config.repos.find((r) => r.id === repoId);
      if (repo) await refreshAuthors(store, gh, crewDir(dbPath), repoId, repo.github, Date.now());
    },
    config,
    store,
    bus,
    supervisor: pauseAwareSupervisor(store, supervisor),
    enabled: engineOn,
    login: hubLogin,
    lockState: () => lock.state(),
    // a seat with a pending change is not started until it settles; the reloader exists below
    blocked: (seatId) =>
      pausedSeat(store, seatId) !== null ||
      cliHold.reason !== null ||
      crewReloader.status().pending.some((p) => p.seatId === seatId),
    log: (line) => log(line),
  });

  // Update runs in this process's own checkout, and never on a preview server.
  const updater =
    hubRoot === null
      ? undefined
      : createUpdater({
          root: hubRoot,
          // read once: the code this process runs, whatever a later pull does to HEAD
          startSha: await headSha(hubRoot),
          logPath: join(dirname(dbPath), UPDATE_LOG),
          preview,
          // never throws: a supervisor without the lock answers from memory, not its seat rows
          crewRefusal: () => crewRefusal(config, supervisor, (id) => store.seatSession(id)),
          // the signal path: the crew stops first, then the scheduler and the server; exit 0
          exit: () => void shutdown("update"),
        });

  // `updates.hub: auto`: the scheduler's `update` job runs Update when it would pass (never on a preview).
  const heldUpdateNote = createHeldUpdateNote(store, bus, config.updates?.hub === "auto");
  const autoUpdate =
    updater === undefined
      ? undefined
      : createAutoUpdate({
          enabled: config.updates?.hub === "auto",
          updater,
          held: heldUpdateNote,
          blocked: () =>
            crewRefusal(config, supervisor, (id) => store.seatSession(id)) ??
            (lock.state().holder !== null ? "the test lock is held" : null),
          locked: () => (lock.state().holder !== null ? "the test lock is held" : null),
          headSha: () => (hubRoot === null ? Promise.resolve(null) : headSha(hubRoot)),
          // the hub restarts at once; the Activity page reads the line after it
          record: (text) => store.addHubEvent(text, Date.now()),
        });

  // Seat and role changes in config.yaml apply live; the file it reads is the one this process loaded.
  const crewReloader = createCrewReloader({
    configPath,
    config,
    store,
    bus,
    supervisor,
    rotateFlight: () => flightWatch.rotate(),
    log: (line) => log(`crew: ${line}`),
  });

  const mapRing = new CallRing(() => {
    const seats = new Set(
      configuredAgents(config)
        .filter((a) => a.kind === "crew")
        .map((a) => a.id),
    );
    return store.runsActiveSince(Date.now() - 15 * 60_000).flatMap((run): RingSource[] => {
      if (!seats.has(run.agentId)) return [];
      const session = store.seatSession(run.agentId);
      const cwd =
        run.loop?.aside?.worktree ?? (session?.runId === run.id ? session.worktree : null);
      return cwd
        ? [
            {
              id: run.id,
              seat: run.agentId,
              repoId: run.repoId,
              cwd,
              transcriptPath: run.transcriptPath,
              vendor: run.vendor,
              current: session?.runId === run.id,
            },
          ]
        : [];
    });
  });
  const app = buildApp({
    previews,
    previewRepoId,
    previewActivity,
    hudShots,
    queueReorder,
    mapRing,
    warmMap: true,
    operatorToken,
    gh,
    knownSecrets: mcDeps.knownSecrets,
    deliverComms,
    config,
    store,
    bus,
    logger: true,
    webRoot: WEB_ROOT,
    profilesPath,
    // A setup that created fields, or an added repo, refreshes the boards now, not at the next poll.
    refreshBoards: () => scheduler.refreshBoards(),
    machine: () => scheduler.machine(),
    onStreamCount: (count) => {
      browserStreamCount = count;
    },
    hubLogin: () => hubLogin,
    noLoopWrites: process.env.MC_NO_LOOP_WRITES === "1",
    // Add-repo writes back to the file this process loaded, and only that file.
    configPath: writableConfigPath,
    crewReloader: writableConfigPath === undefined ? undefined : crewReloader,
    // A preview writes only a config file it was explicitly pointed at, never the live one.
    seatWrites: !preview || process.env.MC_CONFIG !== undefined,
    supervisor,
    engine,
    updater,
    // the guard and /mcp: tokens, the test lock, and each seat judged by its configured role
    ...crewGuardDeps(config, tokens, lock, store),
    checks: checkRecorder,
    mcpCalls,
    mcpTools: () => [...mcTools, ...flightTools],
  });
  log = (line) => app.log.warn(line);
  for (const line of early.splice(0)) log(line);
  let stopDiscovery = () => {};
  app.addHook("onClose", async () => stopDiscovery());

  const shutdown = onSignal({
    drain: () => mcpCalls.drain(),
    stopCrew: () => supervisor.stopAll(),
    stop: async () => {
      await previews?.closeAll();
      stopDiscovery();
      crewReloader.stop();
      flightWatch.stop();
      engine.stop();
      await scheduler.stop();
    },
    close: () => app.close(),
    log: { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) },
    exit: (code) => process.exit(code),
  });
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  const previewExpiry = previews ? setInterval(() => void previews.expire(), 60_000) : null;
  app.addHook("onClose", async () => {
    if (previewExpiry) clearInterval(previewExpiry);
    await previews?.closeAll();
  });

  // before the first request: a seat that kept running meets its token and its hold again
  if (crewEnabled) {
    const r = restoreRuns({ store, dbPath, tokens, lock, log: (line) => log(line) });
    if (r.tokens + r.holds > 0) {
      log(`crew: restored ${r.tokens} token(s) and ${r.holds} test-lock hold(s)`);
    }
  }
  await app.listen({ host: HOST, port });
  // newsyslog sends SIGTERM to this pid; launchd reopens the rotated log on restart.
  if (!preview) {
    const pidPath = join(dirname(dbPath), "server.pid");
    writeFileSync(pidPath, String(process.pid), { mode: 0o600 });
    process.once("exit", () => {
      unlinkSync(pidPath);
    });
  }
  scheduler.start();
  supervisor.start();
  // After the supervisor has taken the crew lock (it does so before returning), so the engine's
  // first look at the seats works; its resumed runs start in the background, so no idle event of
  // theirs is missed.
  engine.start();
  // Branch tidying writes to GitHub, so it runs wherever the engine does.
  if (engineOn) {
    const tidy = createBranchTidy({
      config,
      store,
      gh,
      dbPath,
      inClone: (checkout, fn) => supervisor.inClone(checkout, fn),
      log,
    });
    const quietly = (what: string, run: () => Promise<string[]>) => () => {
      run().catch((e: unknown) => {
        log(`branch tidy: ${what} failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    };
    const everyTenMinutes = quietly("closed-PR pass and local prune", async () => [
      ...(await tidy.closedPass()),
      ...(await tidy.pruneLocal()),
    ]);
    setInterval(everyTenMinutes, TIDY_EVERY_MS).unref();
    setInterval(quietly("sweep", tidy.sweep), SWEEP_EVERY_MS).unref();
    setTimeout(quietly("sweep", tidy.sweep), TIDY_EVERY_MS).unref();
  }
  crewReloader.start();
  flightWatch.start();
  stopDiscovery = startCodexDiscovery({
    config,
    bus,
    store,
    supervisor,
    log,
    models: { dataDir: dirname(dbPath) },
  });
}

/** A branch preview never inherits an explicit live config path, which would permit config writes. */
export function previewEnvironment(
  previewPort: number,
  previewDb: string,
  pr: number,
  token: string,
  parentPort: number,
): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.MC_CONFIG;
  return {
    ...env,
    MC_PORT: String(previewPort),
    MC_DB: previewDb,
    MC_NO_LOOP_WRITES: "1",
    MC_NO_CREW: "1",
    MC_PREVIEW_ACTIVITY_URL: `http://${HOST}:${parentPort}/api/previews/${pr}/activity`,
    MC_PREVIEW_ACTIVITY_TOKEN: token,
    MC_PREVIEW_PARENT_PID: String(process.pid),
  };
}

const PREVIEW_READY_MS = 30_000;
const PREVIEW_STOP_MS = 10_000;

async function runPreviewCommand(
  command: string,
  args: string[],
  cwd?: string,
  signal?: AbortSignal,
): Promise<void> {
  const child = spawn(command, args, {
    cwd,
    stdio: "ignore",
    signal,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`preview ${command} did not finish successfully`)),
    );
  });
}

async function waitForPreview(
  child: ChildProcess,
  previewPort: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + PREVIEW_READY_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("preview start cancelled");
    if (child.exitCode !== null) throw new Error("preview server stopped before it was ready");
    try {
      const response = await fetch(`http://${HOST}:${previewPort}/api/health`, {
        signal: signal ?? AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // The child is still loading its server modules.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("preview server did not become ready");
}

async function stopPreview(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<true>((resolve) => setTimeout(() => resolve(true), PREVIEW_STOP_MS)),
  ]);
  if (!timedOut) return;
  child.kill("SIGKILL");
  await exited;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
