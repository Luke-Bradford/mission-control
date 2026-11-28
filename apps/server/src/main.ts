import {
  flushInstructionNotices,
  importInstructionFocus as importConfiguredInstructionFocus,
  startInstructionFocusRetry,
} from "./instructions/notices.ts";
/**
 * Mission Control server: loads config, opens the store, starts the collectors' scheduler and serves
 * the API on 127.0.0.1:7420 (loopback only; mutating routes need the operator token in <data dir>/operator-token).
 *   MC_CONFIG  config path (default ~/.config/mission-control/config.yaml)
 *   MC_DB      sqlite path (default ~/.local/share/mission-control/mc.sqlite; its dir is created 0700)
 *   MC_PORT    port (default: the live port; 1024–65535), e.g. for a preview server beside the live hub
 *   MC_LIVE_PORT  the live hub's port (default 7420); a server on any other port is a preview
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

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  evidenceSectionText,
  LOOPBACK_HOST,
  QA_RETENTION_DAYS,
  type RepoId,
  ROLE_PROMPT_DIR,
  type Run,
} from "@mc/core";
import { buildApp, crewGuardDeps } from "./api.ts";
import { LocalNotifications } from "./attention/local-notifications.ts";
import { releaseWaitingOperator } from "./attention/needs-you-actions.ts";
import { buildAuditPack } from "./audit/pack.ts";
import { AUDIT_TICK_MS, auditTick } from "./audit/timer.ts";
import { routineBriefChoices } from "./brief/routine.ts";
import { ChangeBus } from "./bus.ts";
import { CliHold } from "./cli/update.ts";
import {
  fetchBoard,
  fetchCardNow,
  fetchQueueCard,
  fetchTicket,
  githubToken,
  makeGql,
} from "./collectors/github.ts";
import { commsInboxContext } from "./comms/index.ts";
import {
  messageUnpausedSeat,
  pauseAwareSupervisor,
  pausedSeat,
  startUnpausedRun,
} from "./config/crew-pause.ts";
import { ensureConfigFile, starterLogText } from "./config/hub-settings.ts";
import { loadProfiles, PROFILES_FILE } from "./config/profiles.ts";
import {
  ConfigError,
  crewAllowed,
  findHubRoot,
  isPreview,
  loadConfig,
  portFromEnv,
  writableConfigPath as writableConfigPathOf,
} from "./config.ts";
import { createCrewReloader } from "./crew-apply.ts";
import { runFirstClean } from "./disk/first-clean.ts";
import { notLivePrKeys } from "./disk/live.ts";
import {
  DISK_CLEAN_SETTING,
  DISK_SWEEP_EVERY_MS,
  diskBudgetBytes,
  sweepDataFolder,
} from "./disk/sweep.ts";
import { cachedDiskUse } from "./disk/use.ts";
import { releaseAtAccountStop } from "./engine/account-release.ts";
import { createEngine, type Engine, reviewerOf } from "./engine/engine.ts";
import { createPublisher } from "./engine/publish.ts";
import { refillQueues, takeNext } from "./engine/queue.ts";
import { RepoRulesError, readRepoRules } from "./engine/rules.ts";
import { recordingShotSaves, runSilenceCheck } from "./engine/silence.ts";
import { seedExternalReviewAsks } from "./external-pr-control.ts";
import { refreshAuthors } from "./flight/collaborators.ts";
import { flightConflicts } from "./flight/conflicts.ts";
import { renderHudInHelper } from "./flight/hud-render.ts";
import { hudShotStore } from "./flight/hud-store.ts";
import { MergeConflicts } from "./flight/merge-conflicts.ts";
import { deliversToFlight, readFlightMode } from "./flight/mode.ts";
import { operatorCall } from "./flight/operator-call.ts";
import { createCrewTidy } from "./flight/tidy.ts";
import { createFlightTools } from "./flight/tools.ts";
import { createFlightWatch } from "./flight/watch.ts";
import { checkCardFieldOptions, editCardFields, type Move, moveCard } from "./github/board.ts";
import {
  cloneState,
  configuredChecks,
  createCheckRecorder,
  seatWorktree,
} from "./guard/check-runs.ts";
import { lockChanged, TestLock } from "./guard/lock.ts";
import { processAlive } from "./guard/process-alive.ts";
import { attentionItems, markHubStarted, NO_LOCK } from "./hud/hud.ts";
import { createGh, ghCommand } from "./mcp/gh.ts";
import { McpCalls } from "./mcp/server.ts";
import { RunTokens } from "./mcp/tokens.ts";
import {
  createMcTools,
  KNOWN_SECRETS_TIMEOUT_MS,
  type McToolsDeps,
  prTextProblem,
  readKnown,
} from "./mcp/tools.ts";
import { newOperatorToken, writeControllerToken, writeOperatorToken } from "./operator.ts";
import { peerIsSeat } from "./peer-process.ts";
import { createPrEvidence, evidenceReviewDeps } from "./pr-evidence/capture.ts";
import { evidenceDemoRender } from "./pr-evidence/demo-render.ts";
import {
  evidenceSideStarter,
  removeStaleEvidenceWork,
  runEvidenceCommand,
} from "./pr-evidence/hubs.ts";
import { readHeadWebPageGraph } from "./pr-evidence/import-graph.ts";
import {
  deleteEvidenceRelease,
  publishEvidenceRelease,
  sweepEvidenceReleases,
} from "./pr-evidence/releases.ts";
import { prEvidenceStore } from "./pr-evidence/store.ts";
import { createEvidenceSweep, postPrEvidence, trustedEvidenceHead } from "./pr-evidence/sweep.ts";
import { appPreviewPaths, startAppPreview } from "./preview/app.ts";
import { previewBrowserInHelper } from "./preview/browser.ts";
import { PREVIEW_ACTIVITY_HEADER, PreviewManager } from "./preview/previews.ts";
import { originRepo, resolveHubRepo, resolvePreviewRepo } from "./preview/repo.ts";
import { createReviewPreviews, WEB_AREA_LABEL } from "./preview/review.ts";
import { trustedPullRequest } from "./preview/trust.ts";
import { createQaReports } from "./qa/reports.ts";
import { claimAs, readLogin } from "./queue/claim.ts";
import {
  prepareQueueReorderSnapshot,
  type QueueReorderDeps,
  reorderQueue,
} from "./queue/queue-reorder.ts";
import { createBranchTidy, SWEEP_EVERY_MS, TIDY_EVERY_MS } from "./repo/branch-tidy.ts";
import { crewLeftoverFootprint } from "./repo/crew-leftovers.ts";
import { clearLeftovers, closeFinishedPreviews, LEFTOVERS_EVERY_MS } from "./repo/leftovers.ts";
import { EVIDENCE_FOLDERS, keepOutOfSpotlight } from "./repo/no-index.ts";
import { branchOwned, createExternalReviews, readExternalSubject } from "./review/external.ts";
import { rotatingLog } from "./run/rotating-log.ts";
import { CMUX_COMMAND, createCmux } from "./runtime/cmux.ts";
import { startCodexDiscovery } from "./runtime/codex-discovery.ts";
import { watchPreviewParent } from "./runtime/preview-parent.ts";
import { installHubErrorHandlers } from "./runtime/process-errors.ts";
import { restoreRuns } from "./runtime/restore.ts";
import { createSupervisor, type Supervisor } from "./runtime/supervisor.ts";
import { createScheduler, refreshOnSeatFree } from "./scheduler.ts";
import { CREW_APP_DEFAULTS, CREW_APP_STATE_SETTING, createCrewApps } from "./sessions/apps.ts";
import { createSessionChecks } from "./sessions/checks.ts";
import { applyCmuxSessionEvent, startCmuxEvents } from "./sessions/events.ts";
import { createBranchPrs } from "./sessions/pr.ts";
import { createSessions, probeLocal, SESSIONS_APP_WATCH_MS } from "./sessions/sessions.ts";
import { createSessionSidebar } from "./sessions/sidebar.ts";
import {
  createSeatTerminal,
  type SeatTerminal,
  terminalCommandPolicy,
  terminalSandboxProfile,
  terminalScratchDir,
  terminalSuite,
} from "./sessions/terminal.ts";
import { createSessionWatch } from "./sessions/watch.ts";
import { onSignal } from "./shutdown.ts";
import { crewDir } from "./store/crew-paths.ts";
import { Store } from "./store.ts";
import { hubFileServiceRestart } from "./telemetry/file-service-restart.ts";
import { MACHINE_CAPACITY_DEFAULTS, storedMachineCapacity } from "./telemetry/machine-capacity.ts";
import { transcriptFootprint } from "./transcript/lifecycle.ts";
import {
  commitsOf,
  createAutoUpdate,
  createHeldUpdateNote,
  createQuietGate,
  createUpdater,
  crewRefusal,
  headSha,
  raiseUpdatePersonNote,
  UPDATE_EXIT_DELAY_MS,
  UPDATE_LOG,
} from "./update.ts";

export const HOST = LOOPBACK_HOST;
/** `pnpm build` output of apps/web, served by this process. */
const WEB_ROOT = fileURLToPath(new URL("../../web/dist", import.meta.url));

/** Interrupt a stranded Codex turn after its test process ended without a final tool result. */
export function notifyLostCheck(
  store: { run(runId: string): Pick<Run, "agentId"> | null },
  supervisor: Pick<Supervisor, "message">,
  log: (line: string) => void,
  runId: string,
  commands: readonly string[],
): void {
  const run = store.run(runId);
  if (run === null) return;
  void supervisor
    .message(
      run.agentId,
      `The test command ended without a final result: ${commands.join(", ")}. Run it again; do not keep polling the lost command.`,
      { interrupt: true, questions: "none", expectedRunId: runId },
    )
    .catch((e: unknown) =>
      log(`checks: could not tell ${run.agentId} about a lost command: ${String(e)}`),
    );
}

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
    port = portFromEnv(process.env.MC_PORT, process.env);
    // A first start has no file: write a starter, so Setup can take the operator from there.
    if (!isPreview(port, process.env)) {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      if (ensureConfigFile(configPath, zone))
        process.stdout.write(`${starterLogText(configPath)}\n`);
    }
    config = loadConfig(configPath);
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`config error: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
  const preview = isPreview(port, process.env);
  // Preview hubs must share the hub's repository, not the isolated crew clone.
  const hubRoot = findHubRoot();
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(dbPath), 0o700); // tighten a directory that already existed, too
  const operatorToken = newOperatorToken(); // per boot; FLIGHT alone also receives it in memory
  writeOperatorToken(dirname(dbPath), operatorToken);
  const controllerToken = newOperatorToken(); // the controller's own key, per boot
  writeControllerToken(dirname(dbPath), controllerToken);
  const hubStartedAt = Date.now();
  markHubStarted(hubStartedAt);
  const store = new Store(dbPath);
  const bus = new ChangeBus();
  const previewRoot = join(dirname(dbPath), "previews");
  if (!preview) {
    await rm(previewRoot, { recursive: true, force: true });
    const previewSources = new Set([
      ...(hubRoot === null ? [] : [hubRoot]),
      ...(config.crew?.sessions ?? []).map(({ checkout }) => checkout),
    ]);
    await Promise.all(
      [...previewSources].map((checkout) =>
        runPreviewCommand("git", ["-C", checkout, "worktree", "prune"]).catch(() => {}),
      ),
    );
  }
  const previewRepoId = await resolvePreviewRepo(
    hubRoot,
    config.repos,
    config.crew?.sessions ?? [],
  );
  const hubRepo = previewRepoId ?? (await resolveHubRepo(hubRoot, config.repos));
  if (hubRepo !== undefined) config.hubRepo = hubRepo;
  const hubGithub = hubRoot === null ? null : await originRepo(hubRoot);
  if (hubGithub !== null) config.hubGithub = hubGithub;
  // Read at call time: `gh` is built below, and a build only starts once the hub is serving.
  const trustedHead = async (pr: number, sha?: string, repoId?: string): Promise<boolean> => {
    const github = config.repos.find((r) => r.id === (repoId ?? previewRepoId))?.github;
    if (github === undefined || hubRoot === null) return false;
    return await trustedPullRequest(store, gh, hubRoot, github, pr, sha, Date.now());
  };
  const previewCheckouts = new Map<string, { checkout: string; worktree: string; ref: string }>();
  const previews = isPreview(port, process.env)
    ? undefined
    : new PreviewManager({
        ...(previewRepoId === undefined ? {} : { hubRepoId: previewRepoId }),
        trusted: ({ pr, sha, repoId }) => trustedHead(pr, sha, repoId),
        capacity: () => {
          const capacityConfig = config.crew?.machineCapacity;
          const c = capacityConfig ?? MACHINE_CAPACITY_DEFAULTS;
          return storedMachineCapacity(store, Date.now(), c);
        },
        exists: async (candidate) =>
          await new Promise<boolean>((resolve) => {
            const probe = createServer();
            probe.once("error", () => resolve(true));
            probe.listen({ host: HOST, port: candidate }, () => probe.close(() => resolve(false)));
          }),
        start: async ({
          repoId,
          pr,
          sha,
          port: previewPort,
          token,
          signal,
          checkout: repoCheckout,
        }) => {
          if (hubRoot === null) throw new Error("the hub checkout is unavailable for previews");
          // one folder per repo and PR: two repos can have the same PR number
          const root = join(
            previewRoot,
            repoId === undefined || repoId === previewRepoId
              ? String(pr)
              : `${encodeURIComponent(repoId)}-${pr}`,
          );
          const previewDb = join(root, "mc.sqlite");
          if (repoId !== undefined && repoId !== previewRepoId) {
            // Another repo's app: its own run command in a worktree of its own clone.
            const { worktree, ref } = appPreviewPaths(root, pr);
            const runCommand = config.repos.find((r) => r.id === repoId)?.runCommand;
            await rm(root, { recursive: true, force: true });
            mkdirSync(root, { recursive: true, mode: 0o700 });
            previewCheckouts.set(previewDb, { checkout: repoCheckout, worktree, ref });
            try {
              const app = await startAppPreview(
                {
                  run: runPreviewCommand,
                  spawnApp: (command, cwd, env, sig) =>
                    spawn("sh", ["-c", command], {
                      cwd,
                      env: { ...process.env, ...env },
                      stdio: "ignore",
                      signal: sig,
                    }),
                  wait: (child, p, sig) => waitForPreview(child as ChildProcess, p, sig, "any"),
                  stop: (child) => stopPreview(child as ChildProcess),
                },
                {
                  checkout: repoCheckout,
                  root,
                  pr,
                  ...(sha === undefined ? {} : { sha }),
                  runCommand,
                  port: previewPort,
                  signal,
                },
              );
              return { dbPath: previewDb, stop: app.stop };
            } catch (e) {
              await runPreviewCommand("git", [
                "-C",
                repoCheckout,
                "worktree",
                "remove",
                "--force",
                worktree,
              ]).catch(() => {});
              await runPreviewCommand("git", ["-C", repoCheckout, "update-ref", "-d", ref]).catch(
                () => {},
              );
              previewCheckouts.delete(previewDb);
              await rm(root, { recursive: true, force: true });
              throw e;
            }
          }
          const checkout = hubRoot;
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
              ["-C", checkout, "worktree", "add", "-f", "--detach", worktree, sha ?? previewRef],
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
  // One measurement of the hub's disk use (a walk of many gigabytes) serves the panel, the sweep and the disk flag.
  const hubDiskUse = cachedDiskUse({
    dataDir: dirname(dbPath),
    worktrees: config.crew?.worktrees,
  });
  const fileServiceRestart = hubFileServiceRestart(preview, join(dirname(dbPath), "diagnostics"));
  const scheduler = createScheduler({
    config,
    ...(fileServiceRestart === undefined ? {} : { restartFileService: fileServiceRestart }),
    hubDiskUse: () => {
      void hubDiskUse.read().catch(() => {});
      return hubDiskUse.last();
    },
    teamsEnabled: !isPreview(port, process.env),
    boardWrites: !preview,
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
    // Lazy: supervisor, shared queue services and mcDeps are initialized before scheduler.start.
    defaultChoices: () =>
      routineBriefChoices(
        {
          config,
          store,
          now: Date.now,
          supervisor,
          queue: queueReorder,
          knownSecrets: mcDeps.knownSecrets,
          bus,
        },
        () => lock.state(),
      ),
    // lazy: the supervisor is built below, and the check only runs once the scheduler starts
    seatCheck: (tool) => supervisor.checkCli(tool),
    // lazy: `gh` is built below; the job only runs once the scheduler starts
    releaseWaiting: () =>
      releaseWaitingOperator({ config, store, gh, dbPath, log: (line) => log(line) }),
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
  const previewParentTimer =
    preview && previewParentPid !== undefined
      ? watchPreviewParent(Number(previewParentPid))
      : undefined;
  const writableConfigPath = writableConfigPathOf(configPath, preview, process.env);
  // A web PR's screenshot pairs: kept under the private data dir, captured on the live hub only.
  const evidenceStore = prEvidenceStore(join(dirname(dbPath), "pr-evidence"));
  const evidenceCheckout = hubRoot ?? undefined;
  const prEvidence =
    !preview && previewRepoId !== undefined && evidenceCheckout !== undefined
      ? createPrEvidence({
          store: evidenceStore,
          repoId: previewRepoId,
          trusted: ({ pr, sha }) => trustedHead(pr, sha),
          workDir: join(dirname(dbPath), "pr-evidence-work"),
          baseUrl: `http://${HOST}:${port}`,
          webGraph: async (sha, signal) => {
            await runEvidenceCommand(
              "git",
              ["-C", evidenceCheckout, "fetch", "origin", sha],
              undefined,
              signal,
            );
            return readHeadWebPageGraph(evidenceCheckout, sha, signal);
          },
          // Read the remote's immutable default head directly: another preview fetch must not
          // overwrite our baseline through the checkout's shared FETCH_HEAD.
          mainSha: async (signal) =>
            (
              await gitOutput(
                evidenceCheckout,
                ["ls-remote", "--exit-code", "origin", "HEAD"],
                signal,
              )
            ).split(/\s/)[0] ?? "",
          snapshot: async (to) => {
            const source = new DatabaseSync(dbPath);
            try {
              source.prepare("VACUUM INTO ?").run(to);
            } finally {
              source.close();
            }
          },
          startSide: evidenceSideStarter({
            checkout: evidenceCheckout,
            root: join(dirname(dbPath), "pr-evidence-work", "sides"),
            run: runEvidenceCommand,
            freePort,
            launch: async ({ worktree, port: sidePort, db, signal }) => {
              const child = spawn(
                process.execPath,
                ["--experimental-strip-types", "apps/server/src/main.ts"],
                {
                  cwd: worktree,
                  env: evidenceEnvironment(sidePort, db),
                  stdio: "ignore",
                },
              );
              try {
                await waitForPreview(child, sidePort, signal);
              } catch (e) {
                await stopPreview(child).catch(() => {});
                throw e;
              }
              return { stop: async () => await stopPreview(child) };
            },
          }),
          render: evidenceDemoRender,
          changeText: async ({ sha, mainSha, paths, signal }) => {
            await runEvidenceCommand(
              "git",
              ["-C", evidenceCheckout, "fetch", "origin", sha, mainSha],
              undefined,
              signal,
            );
            const diff = await gitOutput(
              evidenceCheckout,
              ["diff", "--unified=0", `${mainSha}...${sha}`, "--", ...paths],
              signal,
            );
            return diff
              .split("\n")
              .filter((l) => /^[+-](?![+-])/.test(l))
              .join("\n");
          },
          unpublish: async (pr) => {
            const repo = config.repos.find((r) => r.id === previewRepoId);
            if (
              repo !== undefined &&
              !(await deleteEvidenceRelease(gh, evidenceCheckout, repo.github, pr))
            )
              throw new Error(`the release for PR ${pr} could not be deleted`);
          },
          publish: async ({ pr, sha, images, signal }) => {
            signal.throwIfAborted();
            const repo = config.repos.find((r) => r.id === previewRepoId);
            if (repo === undefined) throw new Error("the hub's repo is not configured");
            return publishEvidenceRelease({
              gh,
              cwd: evidenceCheckout,
              repo: repo.github,
              pr,
              sha,
              images,
              scratch: join(dirname(dbPath), "pr-evidence-work", "release"),
            });
          },
          log: (line) => log(line),
        })
      : undefined;
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
  const flightAreas = async (repoId: RepoId) => {
    const rules = await engineRules(repoId);
    return rules instanceof RepoRulesError ? undefined : rules.areas;
  };
  const flightMergeChecks = new MergeConflicts();
  const flightConflictFiles = async (repoId: RepoId) => {
    const checkout = config.crew?.sessions.find((x) => x.repoId === repoId)?.checkout;
    return checkout === undefined
      ? undefined
      : await flightConflicts(flightMergeChecks, checkout, store.pullRequests(repoId));
  };
  // The checks a repo configures (`mc.checks`): seats' shell calls are recorded against the commit
  // they ran on, and `mc push` asks for the record.
  const runChecks = configuredChecks(store, engineRules);
  let supervisor!: Supervisor;
  const checkRecorder = createCheckRecorder({
    store,
    checks: runChecks,
    state: cloneState(config, store),
    worktree: seatWorktree(store),
    processAlive,
    onLost: (runId, commands) => notifyLostCheck(store, supervisor, log, runId, commands),
    log: (line) => log(line),
  });
  // Crew runs only on a server that may (the live hub, or a preview told MC_CREW=1), only with a
  // crew config, and only where the guard hook can be found.
  const crewEnabled =
    crewAllowed(preview, process.env) && config.crew !== undefined && hubRoot !== null;
  // Crew checkouts and evidence images churn constantly; keep Spotlight (and its file-change
  // service) out of them.
  keepOutOfSpotlight(
    [
      ...EVIDENCE_FOLDERS.map((name) => join(dirname(dbPath), name)),
      ...(crewEnabled && config.crew !== undefined ? [config.crew.worktrees] : []),
    ],
    (line) => log(line),
  );
  // The template profiles sit beside config.yaml; read afresh for each start, never cached.
  const profilesPath = join(dirname(configPath), PROFILES_FILE);
  const profiles = () => loadProfiles(profilesPath);
  // RETRO's screenshots on a review's preview are kept with the review for the QA retention window.
  const reviewShots = hudShotStore(join(dirname(dbPath), "review-screenshots"), {
    keep: 2_000,
    maxAgeMs: QA_RETENTION_DAYS * 86_400_000,
  });
  // A repo's web PR is previewed by its own `run_command` (the hub's repo: the hub's web app).
  const reviewPreviews =
    previews === undefined
      ? undefined
      : createReviewPreviews({
          previews,
          files: (repoId, pr) => store.prFilePaths(repoId, pr),
          // the repo's own web area; `apps/web/**` is only the default on the hub's own repo
          webGlobs: async (repoId) => {
            const configured = (await flightAreas(repoId))?.[WEB_AREA_LABEL] ?? [];
            return configured.length > 0 || repoId !== previewRepoId ? configured : ["apps/web/**"];
          },
          checkout: (repoId) =>
            config.crew?.sessions.find((s) => s.repoId === repoId)?.checkout ?? null,
          log: (line) => log(line),
        });
  supervisor = createSupervisor({
    // every Claude seat runs as a cmux workspace the operator can see, type into and clear
    cmuxCommand: [CMUX_COMMAND],
    auditPack: (seatId) =>
      buildAuditPack({ config, store, busy: supervisor.busy(), now: Date.now(), seatId }),
    flightEnvironment: async () => ({
      GH_TOKEN: await githubToken(KNOWN_SECRETS_TIMEOUT_MS),
      MC_HUB: `http://${HOST}:${port}`,
      MC_OPERATOR_TOKEN: operatorToken,
    }),
    config,
    store,
    bus,
    dbPath,
    rules: engineRules,
    login: () => hubLogin,
    profiles,
    checks: checkRecorder,
    fetchTicket: async (repo, n) => fetchTicket(repo, n, makeGql(await githubToken())),
    externalReviewSubject: async (repo, review) => {
      const subject = await readExternalSubject(
        gh,
        hubRoot ?? process.cwd(),
        repo,
        review.prNumber,
        review.sha,
      );
      if (!subject) return null;
      const pr = store.pullRequest(repo.id, review.prNumber);
      if (
        pr?.headSha !== review.sha ||
        branchOwned(config, store, repo.id, subject.branch, pr?.ticket)
      )
        return null;
      const linked = pr?.ticket?.startsWith(`${repo.id}#`)
        ? Number(pr.ticket.slice(repo.id.length + 1))
        : null;
      if (linked !== null && Number.isSafeInteger(linked) && linked > 0) {
        const ticket = await fetchTicket(repo, linked, makeGql(await githubToken()));
        if (!ticket) throw new Error("The linked review ticket could not be read.");
        const body = `${ticket.body}\n\n## PR description (untrusted author context)\n\n${subject.ticket.body}`;
        subject.ticket = {
          ...ticket,
          body: Array.from(body).slice(0, 20_000).join(""),
          bodyTruncated:
            ticket.bodyTruncated ||
            subject.ticket.bodyTruncated ||
            Array.from(body).length > 20_000,
          bodyLength: Math.max(Array.from(body).length, ticket.bodyLength ?? 0),
        };
      }
      return subject;
    },
    // lazy: `gh` is declared below
    claim: (repo, n) => claimAs(gh, hubRoot ?? process.cwd(), () => hubLogin)(repo, n),
    enabled: crewEnabled,
    tokens,
    lock,
    cliHold,
    hubPort: port,
    hubRoot: hubRoot ?? "",
    ...(prEvidence === undefined
      ? {}
      : { evidence: evidenceReviewDeps(prEvidence, evidenceStore, previewRepoId as RepoId) }),
    inbox: (seatId, runId) => commsInboxContext(store, seatId, runId),
    ...(reviewPreviews === undefined ? {} : { reviewPreviews }),
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
  // A hub that died mid-capture left database copies, checkouts and git worktree registrations in
  // the work folder. Nothing else uses it yet (no capture starts before the engine does), so clear it.
  if (prEvidence !== undefined && evidenceCheckout !== undefined) {
    try {
      const removed = await removeStaleEvidenceWork({
        workDir: join(dirname(dbPath), "pr-evidence-work"),
        checkout: evidenceCheckout,
        run: runEvidenceCommand,
      });
      if (removed.length > 0)
        log(`removed ${removed.length} stale screenshot capture folder(s): ${removed.join(", ")}`);
    } catch (e) {
      log(
        `could not clear stale screenshot capture folders: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
  const qaReports = createQaReports({
    store,
    config,
    gh,
    cwd: hubRoot ?? process.cwd(),
    knownSecrets: async () => [
      await githubToken(KNOWN_SECRETS_TIMEOUT_MS),
      operatorToken,
      controllerToken,
    ],
    evidence: evidenceStore,
    reviewShots,
  });
  if (config.crew !== undefined) {
    hubLogin = await readLogin(gh, hubRoot ?? process.cwd());
    if (hubLogin === null) log("gh: could not read the signed-in login; the engine takes nothing");
  }

  // The mc tools: commit and push run in the session clone's queue, the one the supervisor's
  // checkouts use. The push and PR scans read the GitHub token afresh for each call.
  const deliverComms = (seatId: string, _text: string, from: string): void => {
    // outside crew mode FLIGHT takes only the operator's messages; the rest wait for his next one
    if (!deliversToFlight(store, config, seatId, from)) return;
    void messageUnpausedSeat(store, supervisor, seatId, "", {
      interrupt: false,
      questions: "none",
    }).catch((e: unknown) => {
      log(
        `comms: could not deliver inbox to ${seatId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  };
  let crewApps: ReturnType<typeof createCrewApps> | null = null;
  let seatTerminal: SeatTerminal | null = null;
  const mcDeps: McToolsDeps = {
    crewApps: () => crewApps,
    terminalRun: async (input) => {
      if (seatTerminal === null) throw new Error("The seat terminal is unavailable.");
      return seatTerminal.run(input);
    },
    qaReports,
    rules: engineRules,
    qaReportBaseUrl: `http://${HOST}:${port}`,
    config,
    store,
    bus,
    inClone: (checkout, fn) => supervisor.inClone(checkout, fn),
    profiles,
    checks: runChecks,
    checkDrops: (runId) => checkRecorder.drops(runId),
    pendingChecks: (runId) => checkRecorder.pending(runId),
    lostCheck: (runId, command) => checkRecorder.lost(runId, command),
    gh,
    dbPath,
    // its own timeout: a hung gh is killed, not only abandoned (readKnown has a timeout too)
    knownSecrets: async () => [
      await githubToken(KNOWN_SECRETS_TIMEOUT_MS),
      operatorToken,
      controllerToken,
    ],
    log: (line) => log(line),
    onEvidence: (seatId, runId) => supervisor.emitEvidence(seatId, runId),
    onFindings: (seatId, runId) => supervisor.emitFindings(seatId, runId),
    onPlanned: (_s, runId) => supervisor.endRunByEngine(runId),
    onAudited: (_s, runId) => {
      supervisor.endRunByEngine(runId).catch((e: unknown) => {
        log(
          `mc report_audit: could not end ${runId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    },
    crewIds: () => config.crew?.sessions.flatMap((s) => s.seats.map((seat) => seat.id)) ?? [],
    onComms: deliverComms,
    ...(prEvidence === undefined
      ? {}
      : {
          // the section for the PR's current head, so a rewrite of the body keeps it
          prEvidenceSection: (run: Run) => {
            const n = run.loop?.prNumber;
            const sha = n == null ? null : store.pullRequest(run.repoId, n)?.headSha;
            const manifest = n == null || !sha ? null : evidenceStore.manifest(run.repoId, n, sha);
            return manifest === null ? null : evidenceSectionText(manifest, prEvidence.baseUrl);
          },
        }),
    ...(reviewPreviews === undefined
      ? {}
      : {
          previewBrowser: {
            ready: (runId) => reviewPreviews.ready(runId),
            identity: (runId) => reviewPreviews.identity(runId),
            browse: (job, guard) => previewBrowserInHelper(job, guard),
            saveShot: recordingShotSaves(store, (png) => reviewShots.save(png), Date.now),
          },
        }),
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
  const engine: Engine = createEngine({
    config,
    store,
    bus,
    supervisor,
    publisher: createPublisher(mcDeps),
    externalReviews: createExternalReviews({
      reportBaseUrl: `http://${HOST}:${port}`,
      config,
      store,
      gh,
      cwd: hubRoot ?? process.cwd(),
      reviewer: (repoId, pick) => {
        const session = config.crew?.sessions.find((value) => value.repoId === repoId);
        const first = session?.seats[0];
        return first
          ? (reviewerOf(config, first.id, pick?.role, {
              store,
              now: Date.now(),
              ...(pick?.avoid === undefined ? {} : { avoid: pick.avoid }),
            })?.id ?? null)
          : null;
      },
      ...(prEvidence === undefined ? {} : { evidence: prEvidence }),
      evidenceManifest: (repo, pr, sha) => evidenceStore.manifest(repo, pr, sha),
      enabled: () => engine.status().on,
      now: Date.now,
      log: (text) => log(text),
      textAllowed: async (text, repo, pr) =>
        prTextProblem(text, {
          repo,
          issue: pr,
          known: await readKnown(mcDeps, "external_review"),
          label: "QA review",
          allowOwnRepoRefs: true,
        }) === null,
    }),
    ...(prEvidence === undefined ? {} : { evidence: prEvidence }),
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
    releaseAtAccountStop: () =>
      releaseAtAccountStop({
        config,
        store,
        supervisor,
        enabled: engineOn,
        now: Date.now,
        log: (line) => log(`engine: ${line}`),
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

  const branchTidy = createBranchTidy({
    config,
    store,
    gh,
    dbPath,
    inClone: (checkout, fn) => supervisor.inClone(checkout, fn),
    log: (line) => log(line),
  });
  const crewTidy = createCrewTidy({
    config,
    store,
    pruneLocal: () => branchTidy.pruneLocal(),
    inClone: (checkout, fn) => supervisor.inClone(checkout, fn),
    isStarting: (path) => supervisor.isStartingWorktree(path),
  });
  // set once the app exists: `mc operator` calls its routes in process
  let hubApp: ReturnType<typeof buildApp> | null = null;

  // Every cmux workspace on this Mac (the Sessions page, and FLIGHT's cmux_sessions and cmux_send).
  // A preview hub reads them but never tells a session its app stopped.
  const cmux = createCmux([CMUX_COMMAND], (m) => log(m));
  crewApps = createCrewApps({
    cmux,
    repos: () =>
      config.repos.flatMap((repo) => {
        const commands = repo.appCommands ?? CREW_APP_DEFAULTS[repo.id.toLowerCase()];
        return commands?.length ? [{ id: repo.id, commands }] : [];
      }),
    seats: () =>
      store
        .liveSeatRuns()
        .flatMap(({ seatId, worktree, run }) =>
          worktree === null ? [] : [{ id: seatId, runId: run.id, repoId: run.repoId, worktree }],
        ),
    probe: probeLocal,
    log: (m) => log(m),
    state: {
      get: () => store.getSetting(CREW_APP_STATE_SETTING),
      set: (value) => store.setSetting(CREW_APP_STATE_SETTING, value),
    },
  });
  const terminalDir = terminalScratchDir(dbPath);
  seatTerminal = createSeatTerminal({
    cmux,
    dir: terminalDir,
    checks: checkRecorder,
    lock,
    suiteOf: ({ seatId, worktree, command }) => {
      const repoId = store.liveSeatRuns().find((live) => live.seatId === seatId)?.run.repoId;
      return repoId === undefined
        ? null
        : terminalSuite(config, repoId, worktree, command, (c) => checkRecorder.lockedBy(c));
    },
    commandGuard: ({ seatId, worktree, command }) => {
      const repoId = store.liveSeatRuns().find((live) => live.seatId === seatId)?.run.repoId;
      return repoId === undefined
        ? "Terminal command refused: no repository is active."
        : terminalCommandPolicy(config, repoId, worktree, command);
    },
    sandboxProfile: (worktree) =>
      terminalSandboxProfile({
        worktree,
        scratch: terminalDir,
        denyRead: config.crew?.denyRead ?? [],
        denyLocalPorts: [port],
      }),
    log: (m) => log(m),
  });
  const seatIds = () => config.crew?.sessions.flatMap((s) => s.seats.map((seat) => seat.id)) ?? [];
  const branchPrs = createBranchPrs({ store, repos: () => config.repos, gh });
  const notifications = new LocalNotifications(store, config, bus, Date.now);
  let sessionSidebar: ReturnType<typeof createSessionSidebar> | null = null;
  // An operator session's repo checks when it finishes a piece of work, in a repo he turned on.
  const sessionChecks = createSessionChecks({
    cmux,
    store,
    seatIds,
    crewRoots: () => [
      dirname(dbPath),
      ...(config.crew === undefined
        ? []
        : [
            config.crew.worktrees,
            `${config.crew.worktrees}-sessions`,
            ...config.crew.sessions.map((s) => s.checkout),
          ]),
    ],
    configuredChecks: (github) => [
      ...(config.repos.find((r) => r.github.toLowerCase() === github.toLowerCase())?.rules
        ?.checks ?? []),
    ],
    notify: (text) => notifications.notice("checks", text),
    sidebarNotify: (workspaceId, body) =>
      sessionSidebar?.notify(workspaceId, "checkFailed", body) ?? Promise.resolve(),
    log: (m) => log(m),
  });
  const sessions = createSessions({
    cmux,
    store,
    seatIds,
    checks: sessionChecks,
    repos: () => config.repos.map((repo) => ({ id: repo.id, github: repo.github })),
    prs: branchPrs,
    timeZone: () => config.operator.timezone,
    tellApps: process.env.MC_NO_LOOP_WRITES !== "1",
    rolesDir: hubRoot === null ? undefined : join(hubRoot, ROLE_PROMPT_DIR),
    log: (m) => log(m),
  });
  // watch mode: the operator is told when a cmux session waits on him or finishes (read live)
  const sessionWatch = createSessionWatch({
    sessions,
    store,
    bus,
    mode: () => readFlightMode(store),
    log: (m) => log(m),
  });
  sessionSidebar = createSessionSidebar({
    sessions,
    cmux,
    store,
    costToday: (row) => row.spend?.today.costUsd ?? null,
    lastCheck: (row) => sessionChecks.lastResult(row.id),
    writes: process.env.MC_NO_LOOP_WRITES !== "1",
    log: (m) => log(m),
  });
  const cmuxEvents = startCmuxEvents({
    cmux,
    cursorFile: join(dirname(dbPath), "cmux-events.cursor"),
    onChange: () => {
      if (sessionSidebar !== null)
        applyCmuxSessionEvent({ sessions, bus, sidebar: sessionSidebar });
    },
    log: (m) => log(m),
  });

  // FLIGHT's mc tools: after the engine, which later tools wake.
  const flightTools = createFlightTools({
    sessions,
    operator: operatorCall(() => hubApp, operatorToken),
    tidy: crewTidy,
    hudShots,
    evidence: evidenceStore,
    hubOrigin: `http://${HOST}:${port}`,
    screenshotHud: renderHudInHelper,
    queueReorder: (seatId, move, above) => reorderQueue(queueReorder, seatId, move, above),
    prepareQueueReorder: (seatId, move, above) =>
      prepareQueueReorderSnapshot(queueReorder, seatId, move, above),
    seen: (runId, state) => flightWatch.seen(runId, state),
    areas: flightAreas,
    conflicts: flightConflictFiles,
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
    areas: flightAreas,
    conflicts: flightConflictFiles,
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
          person: (reason) => raiseUpdatePersonNote(store, bus, reason),
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

  const importInstructionFocus = () =>
    importConfiguredInstructionFocus({ config, store, bus, log });
  importInstructionFocus();
  // a failed import is tried again on a timer, so its warning clears without anyone at the keyboard
  const stopFocusRetry = startInstructionFocusRetry({ config, store, bus, log });
  const offInstructionNotices = bus.subscribe((topic) => {
    if (topic === "config") importInstructionFocus();
    if (topic === "config" || topic === "flight")
      void flushInstructionNotices({ config, store, bus, supervisor }).catch((error) =>
        log(`instruction notice: ${String(error)}`),
      );
  });
  void flushInstructionNotices({ config, store, bus, supervisor });

  const crewLeftoverPaths = {
    worktrees: config.crew?.worktrees,
    claudeProjects: join(homedir(), ".claude", "projects"),
    codexSessions: join(homedir(), ".codex", "sessions"),
    tmp: tmpdir(),
    previews: previewRoot,
  };
  let leftoverFootprint: Awaited<ReturnType<typeof crewLeftoverFootprint>> | null = null;
  let crewTranscriptFootprint: ReturnType<typeof transcriptFootprint> = null;
  const app = buildApp({
    crewApps,
    sessions,
    onSessionSidebarChange: (on) => {
      if (on) sessionSidebar.reset();
    },
    sessionChecks,
    notifications,
    diskUse: hubDiskUse,
    leftoverFootprint: () => leftoverFootprint,
    transcriptFootprint: () => crewTranscriptFootprint,
    qaReports,
    previews,
    previewRepoId,
    previewActivity,
    hudShots,
    prEvidence: evidenceStore,
    reviewShots,
    queueReorder,
    ticketMove: engineBoard.move,
    ticketRead: engineBoard.read,
    operatorToken,
    controllerToken,
    seatPeer: peerIsSeat,
    gh,
    knownSecrets: mcDeps.knownSecrets,
    deliverComms,
    config,
    store,
    bus,
    logger: { stream: rotatingLog(join(dirname(dbPath), "logs", "server.log")) },
    webRoot: WEB_ROOT,
    profilesPath,
    // A setup that created fields, or an added repo, refreshes the boards now, not at the next poll.
    refreshBoards: () => scheduler.refreshBoards(),
    machine: () => scheduler.machine(),
    onStreamCount: (count) => {
      browserStreamCount = count;
    },
    hubLogin: () => hubLogin,
    needsYou: {
      board: engineBoard,
      rules: engineRules,
      fetchTicket: async (repo, n) => fetchTicket(repo, n, makeGql(await githubToken())),
    },
    noLoopWrites: process.env.MC_NO_LOOP_WRITES === "1",
    prewarmAudit: true,
    // Add-repo writes back to the file this process loaded, and only that file.
    configPath: writableConfigPath,
    // Reads may use the loaded file on any server: a preview shows its rules and cannot save them.
    configReadPath: configPath,
    crewReloader: writableConfigPath === undefined ? undefined : crewReloader,
    // launchd's KeepAlive starts the hub again; a preview has no supervisor, so it cannot restart
    restartHub: preview
      ? undefined
      : () => void setTimeout(() => void shutdown("restart"), UPDATE_EXIT_DELAY_MS),
    // A preview writes only a config file it was explicitly pointed at, never the live one.
    seatWrites: !preview || process.env.MC_CONFIG !== undefined,
    supervisor,
    engine,
    updater,
    // FLIGHT's Update holds new runs while it waits for running turns to end
    updateGate: createQuietGate(cliHold),
    // the guard and /mcp: tokens, the test lock, and each seat judged by its configured role
    ...crewGuardDeps(config, tokens, lock, store),
    repoRules: engineRules,
    checks: checkRecorder,
    mcpCalls,
    mcpTools: () => [...mcTools, ...flightTools],
  });
  hubApp = app;
  log = (line) => app.log.warn(line);
  installHubErrorHandlers(log);
  const backgroundTimers: NodeJS.Timeout[] = [];
  const trackTimer = <T extends NodeJS.Timeout>(timer: T): T => {
    backgroundTimers.push(timer);
    return timer;
  };
  if (previewParentTimer !== undefined) trackTimer(previewParentTimer);
  // a session that names its app is told when it stops answering, whether or not the page is open
  if (process.env.MC_NO_LOOP_WRITES !== "1")
    trackTimer(setInterval(() => void sessions.view(), SESSIONS_APP_WATCH_MS)).unref();
  if (process.env.MC_NO_LOOP_WRITES !== "1") sessionSidebar.start();
  sessionWatch.start();
  app.addHook("onClose", async () => sessionWatch.stop());
  // a preview hub never runs a repo's commands by itself
  if (process.env.MC_NO_LOOP_WRITES !== "1") sessionChecks.start();
  app.addHook("onClose", async () => sessionChecks.stop());
  if (process.env.MC_NO_LOOP_WRITES !== "1") {
    void crewApps.tick().catch((error) => log(String(error)));
    trackTimer(
      setInterval(() => {
        void crewApps?.tick().catch((error) => log(`Crew app tick failed: ${String(error)}`));
        void seatTerminal
          ?.tick(store.liveSeatRuns().map(({ seatId }) => seatId))
          .catch((error) => log(`Seat terminal tick failed: ${String(error)}`));
      }, 60_000),
    ).unref();
  }
  app.addHook("onClose", async () => {
    for (const timer of backgroundTimers.splice(0)) clearTimeout(timer);
    sessionSidebar.stop();
    cmuxEvents.stop();
  });
  for (const line of early.splice(0)) log(line);
  let stopDiscovery = () => {};
  app.addHook("onClose", async () => stopDiscovery());
  let stopEvidenceSweep: (() => void) | undefined;
  app.addHook("onClose", async () => {
    stopEvidenceSweep?.();
    await prEvidence?.stop();
  });

  const shutdown = onSignal({
    drain: () => mcpCalls.drain(),
    stopCrew: () => supervisor.stopAll(),
    stop: async () => {
      await prEvidence?.stop();
      await previews?.closeAll();
      stopDiscovery();
      crewReloader.stop();
      stopFocusRetry();
      offInstructionNotices();
      flightWatch.stop();
      sessionWatch.stop();
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
  // External service tooling can identify this hub without inspecting a process command line.
  if (!preview) {
    const pidPath = join(dirname(dbPath), "server.pid");
    writeFileSync(pidPath, String(process.pid), { mode: 0o600 });
    process.once("exit", () => {
      unlinkSync(pidPath);
    });
  }
  // reviews already in flight when this hub updated keep finishing: they count as asked once
  if (!preview) seedExternalReviewAsks(store, Date.now());
  scheduler.start();
  supervisor.start();
  // After the supervisor has taken the crew lock (it does so before returning), so the engine's
  // first look at the seats works; its resumed runs start in the background, so no idle event of
  // theirs is missed.
  engine.start();
  // The AUDIT seat runs on a timer wherever the engine does: never in a preview.
  if (engineOn) {
    const auditPass = () => {
      auditTick({ config, store, supervisor, now: Date.now(), log: (line) => log(line) }).catch(
        (e: unknown) => log(`audit: pass failed: ${e instanceof Error ? e.message : String(e)}`),
      );
    };
    setInterval(auditPass, AUDIT_TICK_MS).unref();
    setTimeout(auditPass, 30_000).unref();
  }
  // Github's board topic and a retry tick cover every open hub-repo PR, including ones without
  // a live run. Preview/read-only hubs never capture or edit Github.
  if (engineOn && prEvidence && previewRepoId && hubRoot) {
    const repo = config.repos.find((r) => r.id === previewRepoId);
    if (repo) {
      const sweep = createEvidenceSweep({
        store,
        evidence: prEvidence,
        repoId: previewRepoId,
        post: (manifest) => postPrEvidence(gh, hubRoot, repo.github, manifest, prEvidence.baseUrl),
        trusted: (pr) => trustedEvidenceHead(gh, hubRoot, repo.github, pr),
        log,
      });
      const unsubscribe = bus.subscribe((topic) => {
        if (topic === "boards") void sweep.tick();
      });
      const retry = trackTimer(setInterval(() => void sweep.tick(), 60_000));
      retry.unref();
      void sweep.tick();
      stopEvidenceSweep = () => {
        sweep.stop();
        clearInterval(retry);
        unsubscribe();
      };
    }
  }
  // Branch tidying writes to GitHub, so it runs wherever the engine does.
  if (engineOn) {
    const tidy = branchTidy;
    const quietly = (what: string, run: () => Promise<string[]>) => () => {
      run().catch((e: unknown) => {
        log(`branch tidy: ${what} failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    };
    const everyTenMinutes = quietly("local prune", () => tidy.pruneLocal());
    trackTimer(setInterval(everyTenMinutes, TIDY_EVERY_MS)).unref();
    trackTimer(setInterval(quietly("sweep", tidy.sweep), SWEEP_EVERY_MS)).unref();
    trackTimer(setTimeout(quietly("sweep", tidy.sweep), TIDY_EVERY_MS)).unref();
  }
  // Local only: pictures, evidence and scratch of finished work are removed from the data folder.
  if (!preview) {
    const dataDir = dirname(dbPath);
    let sweeping = false;
    // true when the sweep ran to the end; false when it was skipped or failed
    const diskSweep = (graceMs?: number): Promise<boolean> => {
      if (sweeping) return Promise.resolve(false);
      sweeping = true;
      return (async () => {
        // a merged PR's pictures stay until the hub runs code that holds its merge commit
        const notLive = await notLivePrKeys(
          hubRoot === null ? undefined : previewRepoId,
          store.mergedPrs(),
          (await updater?.version().catch(() => null))?.sha || null,
          (running) => (hubRoot === null ? Promise.resolve(null) : commitsOf(hubRoot, running)),
        );
        const openPrs = new Set([...store.openPrKeys(), ...notLive]);
        // The PR's pictures on GitHub go the same way as the ones on disk: once the change is live.
        const releaseRepo = config.repos.find((r) => r.id === previewRepoId);
        await sweepEvidenceReleases(
          prEvidence && releaseRepo && hubRoot
            ? { gh, cwd: hubRoot, repoId: releaseRepo.id, github: releaseRepo.github }
            : null,
          openPrs,
          log,
        );
        await sweepDataFolder({
          dataDir,
          now: Date.now,
          openPrs,
          citedAssets: store.qaAssetIdsOfOpenPrs(notLive),
          keptShots: store.reviewShotIdsOfOpenPrs(notLive),
          keptMaterials: store.attentionMaterialAssetIds(
            new Set(
              attentionItems(config, store, Date.now(), NO_LOCK, undefined, null, true).map(
                (item) => item.key,
              ),
            ),
          ),
          budgetBytes: diskBudgetBytes(process.env),
          holdings: () => hubDiskUse.read(),
          ...(graceMs === undefined ? {} : { graceMs }),
          log,
        });
        return true;
      })()
        .catch((e: unknown) => {
          log(`disk sweep failed: ${e instanceof Error ? e.message : String(e)}`);
          return false;
        })
        .finally(() => {
          sweeping = false;
        });
    };
    // The first clean after the cap and live-removal rule has no grace period, so what merged PRs
    // already left behind goes at once; it counts as done only once a sweep has finished.
    const sweepOrFirstClean = () =>
      void runFirstClean(
        {
          get: () => store.getSetting(DISK_CLEAN_SETTING),
          set: (v) => store.setSetting(DISK_CLEAN_SETTING, v),
        },
        diskSweep,
        Date.now,
      );
    trackTimer(setInterval(sweepOrFirstClean, DISK_SWEEP_EVERY_MS)).unref();
    trackTimer(setTimeout(sweepOrFirstClean, 2 * 60_000)).unref();
    // Crew worktrees: a finished PR's go, a set-aside run's lose node_modules. Where the engine runs.
    if (engineOn) {
      const worktreeTidy = () => {
        crewTidy
          .tidyFinished(Date.now())
          .then((r) => {
            if (r.removed.length + r.trimmed.length > 0)
              log(
                `worktree tidy: removed ${r.removed.length} worktree(s), trimmed ${r.trimmed.length} node_modules`,
              );
          })
          .catch((e: unknown) => {
            log(`worktree tidy failed: ${e instanceof Error ? e.message : String(e)}`);
          });
      };
      trackTimer(setInterval(worktreeTidy, TIDY_EVERY_MS)).unref();
      trackTimer(setTimeout(worktreeTidy, TIDY_EVERY_MS)).unref();
    }
  }
  // Local only: Audit checks routine hub activity without GitHub work.
  const silence = () => {
    try {
      runSilenceCheck({ store, config, now: Date.now });
    } catch (e) {
      log(`silence check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  trackTimer(setInterval(silence, 60_000)).unref();
  trackTimer(setTimeout(silence, 60_000)).unref();
  // Local only: what finished work left behind (old questions, holds, parks) is cleared at boot and hourly.
  const leftovers = async () => {
    try {
      for (const text of await clearLeftovers({
        store,
        config,
        now: Date.now(),
        crewLeftovers: crewLeftoverPaths,
      }))
        log(`leftovers: ${text}`);
      crewTranscriptFootprint = transcriptFootprint(store);
      leftoverFootprint = await crewLeftoverFootprint(crewLeftoverPaths);
      const previewsClosed = await closeFinishedPreviews({ previews, store, config });
      if (previewsClosed > 0) log(`leftovers: removed ${previewsClosed} finished preview(s)`);
    } catch (e) {
      log(`leftovers: pass failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  trackTimer(setInterval(() => void leftovers(), LEFTOVERS_EVERY_MS)).unref();
  trackTimer(setTimeout(() => void leftovers(), 5_000)).unref();
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

/** The environment of a hub that serves one commit for screenshots: a read-only preview. */
function evidenceEnvironment(sidePort: number, db: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.MC_CONFIG;
  return {
    ...env,
    MC_PORT: String(sidePort),
    MC_DB: db,
    MC_NO_LOOP_WRITES: "1",
    MC_NO_CREW: "1",
    // the child leaves when this hub does
    MC_PREVIEW_PARENT_PID: String(process.pid),
  };
}

/** A loopback port nothing listens on now. */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen({ host: HOST, port: 0 }, () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address !== null
          ? resolvePort(address.port)
          : reject(new Error("no free port")),
      );
    });
  });
}

/** What a git command prints, trimmed. */
async function gitOutput(checkout: string, args: string[], signal?: AbortSignal): Promise<string> {
  return await new Promise<string>((resolveOut, reject) => {
    execFile(
      "git",
      ["-C", checkout, ...args],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, signal, timeout: 60_000 },
      (err, out) => (err ? reject(err) : resolveOut(out.trim())),
    );
  });
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

/** `health` waits for the hub's `/api/health`; `any` for any HTTP answer (another repo's app). */
async function waitForPreview(
  child: ChildProcess,
  previewPort: number,
  signal?: AbortSignal,
  ready: "health" | "any" = "health",
): Promise<void> {
  const deadline = Date.now() + PREVIEW_READY_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("preview start cancelled");
    if (child.exitCode !== null) throw new Error("preview server stopped before it was ready");
    try {
      const response = await fetch(
        `http://${HOST}:${previewPort}${ready === "health" ? "/api/health" : "/"}`,
        { signal: signal ?? AbortSignal.timeout(500) },
      );
      if (ready === "any" || response.ok) return;
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
