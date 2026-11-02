# Test evidence in Code Health

Test health separates imported named-test attempts from polled CI job states and reviewer claims.
It never starts a workflow, test, seat, paid review or schedule. These routes do not write to GitHub,
change a test, mark one skipped or quarantine one. This implements the definitions in
`docs/research/2026-11-01-code-health-plan.md`; it changes no CI workflow.

## Import an existing result

`POST /api/code-health/test-reports` requires the operator header and a configured repository ID.
A seat bearer cannot supply operator authority. The body contains normalized result data, never a
file path or URL to fetch. The server accepts at most one MiB and 2,000 attempt entries per report.
The actor comes from authenticated operator configuration, not a body field. Known-secret lookup
failures refuse the import; stored labels are cleaned before insertion.

Version 1 fields are:

| Field | Meaning |
| --- | --- |
| `repo`, `headSha` | Configured repository ID and full 40-character commit SHA. |
| `workflow`, `workflowRun` | Workflow name and its numeric run identity, kept as a string. |
| `job`, `jobRun`, `runAttempt` | Job name, numeric job-run identity and positive workflow attempt. |
| `environment` | Explicit environment label, or null when unknown. |
| `completedAt` | Report completion time in Unix milliseconds. It selects the half-open read window. |
| `expectedAttempts` | Declared number of attempt entries, including non-executed states; null means incomplete collection. A declared count must match the entries. |
| `sourceFormat`, `collectionNote` | Optional reporter provenance and collection limitations. The normalized format defaults to `normalized-v1`. |
| `cause`, `causeEvidence` | Optional `unknown`, `infrastructure` or `test` cause. A named cause requires explicit evidence. |
| `cases` | Bounded attempt entries described below. |

Each entry contains a stable reporter `testId`, repo-relative `file`, `suite`, `name`, distinct
`attemptId`, nullable `executionOrder`, `state`, nullable individual `completedAt`, nullable
`duration` and nullable `durationUnit` (`ms` or `s`). States are `passed`, `failed`, `skipped`,
`cancelled` and `not-run`. Unknown timestamps, units, environments and ordering remain unknown.
An individual completion cannot follow its report completion. Report times more than five minutes
ahead of the authenticated import time are refused.

Report identity binds repo, workflow run, job run and run attempt. Attempt identity also includes
the reporter's distinct attempt ID. Stable test identity binds repo and the reporter test ID; its
file/suite/name signature cannot change within one head. A later head may record a moved test.
Identities and raw sensitive labels are hashed where needed. Replaying identical normalized data
returns the original receipt; explicit defaults, JSON key order and transport case order do not
change it. Conflicting evidence under the same report identity returns 409. An import is atomic:
either its report and every attempt are stored, or none are.

## Local Vitest adapter

The repository includes `scripts/import-test-results.ts` for existing local result artifacts.
Without `--post`, it prints normalized JSON for inspection and makes no HTTP request:

```sh
node --experimental-strip-types scripts/import-test-results.ts --vitest result.json --context context.json
node --experimental-strip-types scripts/import-test-results.ts --normalized normalized.json
```

The context supplies the normalized report metadata plus an absolute canonical `workspaceRoot`
and optional `retriesDisabled` attestation. The adapter strips that workspace prefix from reporter
file names and rejects files outside it. The server never receives a filesystem access instruction.
Stable IDs derive from the relative file, ancestor titles and full test name. Duplicate final IDs
are refused rather than inventing project or retry identities.

Supply the exact tested commit and the report's real completion time. For an isolated local
verification, label the workflow and job as local verification and keep its run identities distinct
from GitHub runs. The context contains all report-level fields above except `cases` and
`expectedAttempts`, plus `workspaceRoot` and `retriesDisabled`; optional report fields remain optional.
Set the attestation only when the actual command and runner configuration establish that retries
were disabled. A successful adapter conversion does not prove that attestation.

Vitest final-result JSON does not expose every internal retry or each test's completion time.
Without an explicit `retriesDisabled: true` attestation, imports have unknown attempt completeness,
order and normalized durations. With that attestation, matching reporter totals establish one
observed attempt per final test. Individual completion times stay null. This is complete for the
declared observed report, never a claim that the hub has complete GitHub history.

To post an inspected result, pass `--post --port <port>`. The CLI only posts to loopback, refuses
redirects and uses the operator-token file beside `MC_DB`. It prints only the bounded import
receipt. To verify the path without touching a live hub, use a copied database, a separate token
and an isolated server on a free port. Do not point verification at the live port or import
illustrative fixture data into live CI history.

## Rates, order and classifications

Named-test rates count executed `passed` and `failed` attempts only. Skipped, cancelled and not-run
entries remain inspectable but never enter that denominator or duration samples. An incomplete
observed report or a truncated source withholds its failure percentage. A complete zero-case report
does not invent an executed test or a zero failure rate.

Retry sequences stay within one repo, head, workflow run, job and environment. Explicit run-attempt
and per-test execution-order metadata establish order. JSON array position and poll time never do.
Missing order, duplicate positions, inconsistent job identities, gaps in run attempts or reversed
completion times leave the sequence uncertain. Every recorded attempt remains available for
reproduction.

- **Candidate:** a named test has an observed failure, without enough ordered or causal evidence
  for a stronger judgement. Mixed polled job states are separate job-level candidates.
- **Confirmed flaky:** an ordered failure is followed by success at the same scope, observed counts
  are complete, and an existing exact-head QA finding supports the named test's flaky judgement.
- **Consistently failing:** at least two ordered executed attempts failed, with complete observed counts.
- **Infrastructure:** each observed failure has the importer's explicit infrastructure cause evidence.

These are evidence classifications, not permission to skip a test. A job-level candidate never
acquires a test name or a confirmed flaky label from polling alone.

Durations normalize documented seconds or milliseconds to milliseconds, within the same stable
test/file/environment scope. The nearest-rank p50/p95 includes its sample count and environment.
Unknown units, environment or duration remain unnormalised. Legacy reviewer command-duration values
have no documented unit and are never reinterpreted as test milliseconds.

## Link existing QA evidence

`POST /api/code-health/test-qa` records an operator classification of an existing reported reviewer
finding. It creates no review. The body contains `repo`, hashed `testId`, full `headSha`, `reviewId`,
zero-based `findingPosition`, `judgement` (`stale`, `wrong`, `slow` or `flaky`) and `specEvidence`.
It is limited to 16 KiB. Caller-supplied actor or reviewer fields are refused.

The imported test, source review and finding must match the exact repo/head and test file. A stale
proposal requires the `test-stale` category; the other judgements require `test-wrong`. The finding
must name a positive source line, concrete scenario and correction. The proposal adds the relevant
specification evidence. Age alone and empty/redacted placeholders cannot establish staleness.
Evidence retains the original reviewer separately from the operator who linked/classified it.
Replays are idempotent; conflicting evidence is refused. The source snapshot survives later native
review retention. No proposal changes an attempt's recorded result.

## Bounded readers and collection gaps

The selected 7-, 30- or 90-day window uses report completion time, including its start and excluding
its end. A source read selects at most 20,001 attempt rows to detect a 20,000-row bound. Truncated
or partial sources state their gap and withhold failure percentages. Test summaries contain at most
50 disruption groups, 50 duration groups and 50 QA proposals, with omitted counts. Issued evidence
references stay confined to repo, source revision, test/head/series or environment; evidence pages
contain at most 50 rows. A stale reference cannot silently switch to new observations.

Overview recommendations inspect indexed report metadata and existence checks, without loading the
20,000-row named-attempt payload. Imported results remove the corresponding missing-source note;
partial counts or absent explicit order metadata keep their specific gaps. Metadata availability
does not prove a valid chronological retry sequence or complete GitHub history. The Test health tab
performs the bounded reconstruction before publishing classifications.

HTTP requests read local stored evidence. Neither the dashboard nor its evidence drawer runs git,
opens an imported file, fetches a report URL or starts paid collection. No private machine paths,
credentials or other-project identities belong in committed examples or verification receipts.

## Verification record

Implementation commit `7fc2e8b0658dbd6e8c933fb7cc82ab597a004078` was checked on 2 November 2026.
The focused server block passed 124 tests in nine files; the API access/inventory subset passed
another 17. Server/core types and repository lint passed. A separate clean-commit run of
`code-health-test-reports.test.ts`, with `--maxWorkers=1 --retry=0 --reporter=json`, passed 19 tests.
That actual local artifact normalized through the CLI and posted to an ephemeral server backed by
a copied database. The authenticated replay returned the same report and its 19 attempts. This was
local verification, not a GitHub workflow or live-history import.

The copied real cohort contained no imported named-test reports. Its 7-, 30- and 90-day reads took
11–14 ms cold for Overview and 5.8–6.4 ms cold for Test health; cached reads were below 0.1 ms.
These measurements describe that sparse local cohort, not a populated-history performance claim.

A separate synthetic scratch database tested the reader boundary through the actual importer:
20,001 attempts remained stored, 20,000 were selected, failure percentage stayed unknown, and each
50-row duration/disruption summary disclosed 19,950 omitted groups. On the same machine, ingestion
took 1.27 s, the bounded source read 65 ms, aggregation 118 ms and Overview collection metadata 6 ms.
The metadata query used the covering repo/window index. These are single local observations, not a
service latency guarantee. The synthetic cohort never entered the copied real cohort or live hub.
