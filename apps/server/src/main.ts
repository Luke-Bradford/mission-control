/**
 * Mission Control server: loads config, opens the store, starts the collectors' scheduler and serves
 * the API on 127.0.0.1:7420 (loopback only; no sign-in).
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
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOOPBACK_HOST, type RepoId } from "@mc/core";
import { buildApp, crewGuardDeps } from "./api.ts";
import { ChangeBus } from "./bus.ts";
import { claimAs, readLogin } from "./claim.ts";
import { CliHold } from "./cli-update.ts";
import { fetchCardNow, fetchTicket, githubToken, makeGql } from "./collectors/github.ts";
import {
  ConfigError,
  crewAllowed,
  findHubRoot,
  isPreview,
  loadConfig,
  portFromEnv,
} from "./config.ts";
import { createCrewReloader } from "./crew-apply.ts";
import { createEngine } from "./engine/engine.ts";
import { createPublisher } from "./engine/publish.ts";
import { refillQueues, takeNext } from "./engine/queue.ts";
import { RepoRulesError, readRepoRules } from "./engine/rules.ts";
import { createFlightTools } from "./flight/tools.ts";
import { createFlightWatch } from "./flight/watch.ts";
import { type Move, moveCard } from "./github-board.ts";
import { lockChanged, TestLock } from "./guard/lock.ts";
import { createGh, ghCommand } from "./mcp/gh.ts";
import { McpCalls } from "./mcp/server.ts";
import { RunTokens } from "./mcp/tokens.ts";
import { createMcTools, KNOWN_SECRETS_TIMEOUT_MS, type McToolsDeps } from "./mcp/tools.ts";
import { loadProfiles, PROFILES_FILE } from "./profiles.ts";
import { restoreRuns } from "./runtime/restore.ts";
import { createSupervisor } from "./runtime/supervisor.ts";
import { createScheduler } from "./scheduler.ts";
import { onSignal } from "./shutdown.ts";
import { Store } from "./store.ts";
import { createAutoUpdate, createUpdater, crewRefusal, headSha, UPDATE_LOG } from "./update.ts";

export const HOST = LOOPBACK_HOST;
/** `pnpm build` output of apps/web, served by this process. */
const WEB_ROOT = fileURLToPath(new URL("../../web/dist", import.meta.url));

async function main(): Promise<void> {
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
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(dbPath), 0o700); // tighten a directory that already existed, too
  const hubStartedAt = Date.now();
  const store = new Store(dbPath);
  const bus = new ChangeBus();
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
  const scheduler = createScheduler({
    config,
    store,
    bus,
    cliHold,
    debug:
      process.env.MC_DEBUG === "1" ? (line) => process.stderr.write(`cc: ${line}\n`) : undefined,
    log: (line) => log(line),
    lockState: () => lock.state(),
    // lazy: the updater is built below; the check only runs once the scheduler starts
    autoUpdate: () => autoUpdate?.() ?? Promise.resolve("off"),
  });
  const preview = isPreview(port, process.env);
  // The hub's own checkout: Update runs in it, and seats run the guard hook from it.
  const hubRoot = findHubRoot();
  // The `gh` login this hub claims tickets as, read once below; null leaves the engine taking nothing.
  let hubLogin: string | null = null;
  // A repo's board rules as the engine reads them: the queue, FLIGHT and every start use them.
  const engineRules = async (repoId: RepoId) => {
    const repo = config.repos.find((r) => r.id === repoId);
    const session = config.crew?.sessions.find((s) => s.repoId === repoId);
    if (repo === undefined || session === undefined) {
      return new RepoRulesError(`${repoId}: no crew session reads this repo's rules`);
    }
    return readRepoRules(repo.github, session.checkout);
  };
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
    fetchTicket: async (repo, n) => fetchTicket(repo, n, makeGql(await githubToken())),
    // lazy: `gh` is declared below
    claim: (repo, n) => claimAs(gh, hubRoot ?? process.cwd(), () => hubLogin)(repo, n),
    enabled: crewEnabled,
    tokens,
    lock,
    cliHold,
    hubPort: port,
    hubRoot: hubRoot ?? "",
  });

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
  const mcDeps: McToolsDeps = {
    config,
    store,
    bus,
    inClone: (checkout, fn) => supervisor.inClone(checkout, fn),
    profiles,
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
    move: async (m: Move) => {
      const moved = await moveCard({ gql: makeGql(await githubToken()), store, config }, m);
      // a card that moved shows on the boards now, not at the next poll
      if (moved.ok && moved.changed) void scheduler.tick("github");
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
    pollGithub: () => void scheduler.tick("github"),
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
  scheduler.setEngine(engine);

  // FLIGHT's mc tools: after the engine, which later tools wake.
  const flightTools = createFlightTools({
    config,
    store,
    bus,
    supervisor,
    login: hubLogin,
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
    config,
    store,
    bus,
    supervisor,
    enabled: engineOn,
    login: hubLogin,
    // a seat with a pending change is not started until it settles; the reloader exists below
    blocked: (seatId) =>
      cliHold.reason !== null || crewReloader.status().pending.some((p) => p.seatId === seatId),
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
  const autoUpdate =
    updater === undefined
      ? undefined
      : createAutoUpdate({
          enabled: config.updates?.hub === "auto",
          updater,
          blocked: () =>
            crewRefusal(config, supervisor, (id) => store.seatSession(id)) ??
            (lock.state().holder !== null ? "the test lock is held" : null),
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
    log: (line) => log(`crew: ${line}`),
  });

  const app = buildApp({
    config,
    store,
    bus,
    logger: true,
    webRoot: WEB_ROOT,
    // A setup that created fields, or an added repo, refreshes the boards now, not at the next poll.
    refreshBoards: () => void scheduler.tick("github"),
    machine: () => scheduler.machine(),
    hubLogin: () => hubLogin,
    noLoopWrites: process.env.MC_NO_LOOP_WRITES === "1",
    // Add-repo writes back to the file this process loaded, and only that file.
    configPath,
    crewReloader,
    // A preview writes only a config file it was explicitly pointed at, never the live one.
    seatWrites: !preview || process.env.MC_CONFIG !== undefined,
    supervisor,
    engine,
    updater,
    // the guard and /mcp: tokens, the test lock, and each seat judged by its configured role
    ...crewGuardDeps(config, tokens, lock),
    mcpCalls,
    mcpTools: () => [...mcTools, ...flightTools],
  });
  log = (line) => app.log.warn(line);
  for (const line of early.splice(0)) log(line);

  const shutdown = onSignal({
    drain: () => mcpCalls.idle(),
    stopCrew: () => supervisor.stopAll(),
    stop: async () => {
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

  // before the first request: a seat that kept running meets its token and its hold again
  if (crewEnabled) {
    const r = restoreRuns({ store, dbPath, tokens, lock, log: (line) => log(line) });
    if (r.tokens + r.holds > 0) {
      log(`crew: restored ${r.tokens} token(s) and ${r.holds} test-lock hold(s)`);
    }
  }
  await app.listen({ host: HOST, port });
  scheduler.start();
  supervisor.start();
  // After the supervisor has taken the crew lock (it does so before returning), so the engine's
  // first look at the seats works; its resumed runs start in the background, so no idle event of
  // theirs is missed.
  engine.start();
  crewReloader.start();
  flightWatch.start();
}

main().catch((e: unknown) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
