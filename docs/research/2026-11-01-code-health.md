# Code-health research — 1 November 2026

Stage 1 of #1185. This report records the evidence available for an Audit redesign. It does not approve a plan, create a mockup or change the product. The operator sees this report before planning starts; the plan and mockup each need approval before the following stage.

## What comparable tools make useful

| Tool and primary source | Grain, visual and drill-through | What fits this crew |
| --- | --- | --- |
| [CodeScene: complexity trends](https://docs.enterprise.codescene.io/versions/6.9.14/guides/technical/complexity-trends.html) | A file hotspot opens historical complexity and size trends. Shape distinguishes stable frequently changed code from increasing complexity. | Use change frequency to find candidates, then show review findings and file history. The hub has no complexity analysis: size is a proxy, not complexity or a verdict. |
| [SonarQube: metric definitions](https://docs.sonarsource.com/sonarqube-server/2025.6/user-guide/code-metrics/metrics-definition) | Separate whole-code and new-code measures; debt is estimated remediation effort, with a defined denominator for its ratio. | Separate newly introduced findings from older code. Do not invent remediation hours or debt percentages from review counts. |
| [GitHub: repository statistics](https://docs.github.com/en/rest/metrics/statistics) | Code-frequency data provides weekly added/deleted lines at repository grain. | A change-volume trend gives context. It cannot distinguish planned features from unplanned repairs, and repository totals cannot prove a fragile file. |
| [BuildPulse](https://buildpulse.io/) | Its test view ranks failures by disruption, with failure patterns, frequency and linked commits for investigation. | Rank evidence-backed disruption and link to reproductions. Do not use the number of red jobs as a count of broken tests. |
| [Trunk: test detection](https://docs.trunk.io/flaky-tests/detection), [overview](https://docs.trunk.io/flaky-tests/overview) | Per-test monitors distinguish broken tests, flaky tests and lifecycle labels. Pass-on-retry concerns a failure then pass on the same commit; the test detail retains execution history. | Keep flaky and consistently broken cases separate. The hub currently lacks stable per-test CI identities and execution histories. |
| [Datadog: flaky-test management](https://docs.datadoghq.com/tests/flaky_management/) | Test-level triage combines state, failure rate and pipeline/time impact with investigation and remediation actions. | A recommendation should identify an affected test and its supporting attempts, not only a job name. |
| [DORA: delivery metrics](https://dora.dev/guides/dora-metrics/) | Deployment rework is the share of deployments needed because of production incidents, separate from delivery throughput. | Call the hub's measure review rework. Review rounds and bug labels do not establish DORA deployment rework. The necessary production-incident/deployment linkage is not recorded. |

These are patterns to evaluate during planning, not decisions to clone a vendor's layout or install a service. The linked documentation was checked on 1 November 2026. No vendor account was connected and no repository data was sent to one.

## What the copied database actually supports

The [numeric inventory](evidence/2026-11-01-code-health-inventory.json) contains counts and ranges from a private read-only database copy. It includes no tokens, transcript text, reviewer prose, operator decisions or machine paths. Review observations span 21 October–1 November; CI observations span 29 October–1 November. Finding and resolution coverage follows the parent review window; resolution timestamps require the resolving review. These are observed coverage windows, not a promised retention period.

| Measure | Source and observed range | Grain and limits |
| --- | --- | --- |
| Review findings | `review_findings` joined to `reviews`: 2,277 findings on 333 distinct file strings; 1,362 categorised. | Finding, file, review and PR. 915 findings (40.2%) lack a category. Category charts must display that missing coverage. A repeated finding is not necessarily a new defect. |
| Review rework | `reviews`: 1,049 rows, 322 PRs; 320 PRs have a reported review. Maximum reported round: 103 at round 1, 128 at 2, 87 at 3, 2 at 4. | Group by repo and PR before calculating rates. 217/320 (67.8%) reached at least round 2. Rows include retries and superseded reviews; counting rows as PRs would inflate rework. |
| CI outcomes and reruns | `ci_runs`: 10,652 job observations, including nonterminal/cancelled states. 69 repo/SHA/job-name groups contain both success and failure. | Job and commit. Those 69 are mixed-outcome candidates, not confirmed flaky tests or proven fail-then-pass retries. Preserve workflow, attempt, chronology and environment before classification. Conclusions are stored in uppercase. |
| Changed files and churn | `pr_files`: 13,273 paths across 1,276 PRs and 3,447 distinct paths, joined PR/history observations spanning 1 October–1 November. `pull_requests` has total additions/deletions on all 1,198 cached rows. | File membership is available; per-file added/deleted lines are not in `pr_files`. PR totals cannot be assigned equally to every changed file. Git numstats or a new collector would be needed for actual per-file churn. |
| File size | `map_cache` has 1,152 file line counts at analysed commit `5f1b0fcb2ee8b492b56f167dcf5b822b81cc706d`. | A default-branch snapshot, not a historical size series or the current worktree. Largest production files in that snapshot include `store.ts` (7,555 lines) and `api.ts` (5,192). Show analysed SHA and age. Size alone does not justify splitting a file. |
| Finding resolutions | Resolution fields live on `review_findings`; 582 rows carry resolution text. | A statement about a finding needs its resolving review and head. Stored `state='open'` alone cannot be presented as the outstanding backlog: some such rows already carry a resolution. |
| Test duration | `review_tests`: 1,289 reported commands, observed 29 October–1 November; raw durations 0–600,000; 269,929 passed and 5,728 failed executions reported in aggregate. | Review command, optionally a file. Repeated runs are counted again. These are neither unique test cases nor complete CI coverage. The collection schema does not specify a duration unit: normalize provenance before charting; zero remains distinct from missing. |
| Linked escaped defects | `escaped_defects`: 53 links against 48 PRs. | An explicit issue/PR relationship, not a deployment incident rate. The relationship and its method remain inspectable before drawing a conclusion. |

The source readers are in `apps/server/src/store.ts`: `reviewsOfPr`, `findingsOf`, `ciRunsOfPr`, `prFilePaths`, `reviewTests` and the map-cache readers. `GET /api/audit` in `apps/server/src/api.ts` calls `store.audit` and core’s `capAudit`. The plan must inspect existing QA, hotspots and repo-health routes before reusing their definitions. The inventory's raw table grain takes precedence over a convenient existing label.

## Separating fragility from planned work

No single recorded measure reliably does this. Use explicit evidence classes instead:

- **Observed review rework:** report the denominator and rounds, without claiming a production failure. A specification correction, reviewer retry and implementation defect have different causes.
- **Linked escaped defect:** retain the issue/PR link and classification method. A label alone is weaker evidence than an explicit relationship.
- **Repeat-change candidate:** changes to the same file within 14 days can nominate an investigation. Planned follow-up work and feature series must remain visible explanations.
- **Flake candidate:** same-commit mixed job outcomes require chronological attempts and test-level results before a named test is called flaky. Cancellation, machine failure and a failed assertion remain distinct.
- **Scope uncertainty:** a finding outside a ticket's declared files could matter, but the hub does not retain a complete authoritative historical file scope for every ticket. Do not infer it from a seat's broad area globs.

A useful recommendation states the observation, coverage, uncertainty and next action, with one drill-through to the underlying evidence. It should not create a ticket or quarantine a test automatically. For example: “This PR needed three reported review rounds; inspect the recurring correctness findings before extending this module.” That is supported by the available records. “This module caused 40% of production incidents” is not.

## Questions the plan must settle

The next stage must define each panel's one question, measure, window, chart, evidence target and recommendation rule. It must reconcile #989, #1125, #1126, #1128 and #773 against what has actually landed. The operator approves that plan before a mockup. The later mockup must use measured numbers, show missing coverage, and fit the requested desktop sizes before any build tickets are filed.
