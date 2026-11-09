# Dependencies server read

The approved Dependencies design has one read-only server contract for Board, FLIGHT and QA. This build extends the existing dependency module; it does not replace the engine's wait tracking.

The graph follows every wait and resolves PR references through their carried tickets. It groups work under terminal roots, repeats a shared dependent under each root, reports cycles, and keeps all descendants for the web's disclosure. A merge frees only dependents whose final direct wait ends; it does not free grandchildren waiting on intervening work.

The adapter joins stored ticket dependencies, stacked PRs, active holds, PR flow and author-seat queues. Unknown ages remain null. Queue ages require a recorded transition into the queue; a run's earlier start is not used. Operator holds and head-bound operator/controller checks retain their next owner. Reads do not observe waits, release work or call GitHub.

The token-protected GET /api/dependencies returns DependencyChain[] for a configured repoId, or all configured repositories when omitted. Invalid queries return 400; an unknown repository returns 404. The route inventory and runbook document the contract before the web readers ship.

## Validation

- 70 existing and new core/dependency/PR-flow cases pass; the final stored-read file adds a twelfth test exercising scoped HTTP reads.
- All 427 API cases pass, including authentication, invalid scopes and route inventory.
- The populated HTTP test snapshots every SQLite table before and after repeated reads; no row changes. Core tests cover cycles, unread and untracked roots, multiple blockers, deterministic sorting and complete disclosure inputs.
- Lint, typecheck and production build pass. The local toolchain reports Node 25.9 against the repository's Node >=26 requirement; CI supplies its configured toolchain.

## Stored-data experiment

The retained JSON contains aggregate results only. A consistent private SQLite backup of the running hub was opened with the new server read. Six fixed-clock reads returned the same 8,353 bytes and SHA-256, with nine chains and 25 distinct work references. The first read took 212.19 ms; the next five took 40.11–43.30 ms. A separate read-only connection's data_version stayed 2 throughout. Startup migrations, before the read interval, ran only on the copy.

These timings describe this frozen copy and host. They are not an idle CPU or memory claim. No raw message, ticket title, question text, transcript, credential or live database is published here.

## Scope

The three web builds remain separate and depend on this server change merging. Parent #1196 is complete for its research/design criteria; this document does not claim the full Dependencies feature has shipped. Fresh independent whole-branch review, exact-head CI and any required merge clearance still apply.

## Wait timing and combined ordering: review 1345

Each outstanding blocker now keeps its own observed start. Adding a blocker preserves the first blocker's start and assigns the new one the current observation. Removing and later re-adding it starts a new edge clock. Existing stored records without per-edge starts fall back to their known set start.

The all-repository endpoint sorts the combined chains with the same exported comparator used by scoped chains. The new transition regression and the two-repository HTTP ordering check both fail on the reviewed head, then pass after correction. All 44 dependency graph, release and chain cases pass, plus lint, workspace types and build. No additional full local-suite pass is claimed for this bounded existing-PR update; fresh full CI and independent QA remain required.

## CI readiness regressions

The dependency change's web/core CI job failed two unchanged preparations: CommsLength measured graph geometry before metrics/font/ResizeObserver layout settled, and daemon-memory's setup allowed only Vitest's short default poll for a valid handshake/replay. The same two unchanged files pass45 cases in isolation. Their source and graph styles are identical between the reviewed dependency head and the baseline checkout used here. No production dependency or UI style code changes in this follow-up.

CommsLength now first asserts the exact scenario row count, waits for font readiness and two animation frames, then applies the same strict containment, reachability and clipping assertions. It does not poll until the graph happens to fit. The daemon mock deliberately delays opening by1.5seconds, within the real10second HELLO deadline. This reproduces the original zero-versus-two presence failure under the old setup. Setup now uses the actual HELLO_TIMEOUT_MS bound; replay ordering, page requests and frame-headroom assertions remain unchanged. Mock pending opens are cancelled on termination.

All89 graph, daemon and dependency cases pass, including all scenarios and the delayed-handshake regression, on both the earlier local runtime and the app's configured Node26.13.0. Configured-runtime lint and workspace types pass. Fresh full CI and independent QA remain required. No failure assertion, quota stop, provider limit, observed loop or product contract is relaxed.
