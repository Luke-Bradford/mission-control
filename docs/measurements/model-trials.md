# Model trials

Read-only trials that ask whether a cheaper model or effort does as well as the one in use (#1428). A cheaper option is adopted only after a trial shows it does. A change to a safety step such as RETRO stays with FLIGHT through the delegated path, and needs the trial's evidence.

## How to run one

FLIGHT runs these on a copy of the hub database, within quota (a build seat has no network). The runner reads only: the database opens read-only, git runs only in the clone you name (merge-base with `origin/main`, then diff, no fetch), `gh` is never called, `claude` runs with every tool off in a temp directory, and the only file written is `--out`.

```
sqlite3 <db> ".backup <copy>"
node --experimental-strip-types apps/server/src/cli/model-trial.ts <review|wake|summary> \
  --db <copy> --repo <id> --clone <path> --model <m> [--effort <e>] [--baseline <substring>] \
  [--count 20] --out <file.md>
```

The runner is `apps/server/src/cli/model-trial.ts`. Each result ends with an empty `Decision:` line for the person who ran it to fill in.

## The trials

| Trial | What it replays | Adopt when |
| --- | --- | --- |
| `review` | The newest `--count` round-1 reviews that had blocking findings, on merged PRs, from runs whose model contains `--baseline`. The model gets `roles/RETRO.md` and the PR diff. A recorded Critical or Important finding counts as caught when the trial gives a Critical or Important finding on the same file within 10 lines (line 0 means the whole file). | Every recorded blocking finding is caught, or each miss is shown to be false. |
| `wake` | FLIGHT wakes that have a `wake_id` and at least one decision. Truth is "acted" when any decision of that wake is not `wait`. Reports agreement and false waits (the model said wait, FLIGHT acted). | Zero false waits. |
| `summary` | The stored run summary beside the model's one-line version. The runner has only the stored summary, not the transcript, so this checks wording and cost, not whether a summary is accurate. | A person reads the lines and finds them as good. |

A review whose commit is not in the clone is skipped and an older eligible one stands in, until `--count` reviews complete; the result states completed, eligible and skipped totals and any shortfall.

Small samples prove little. Report the count with every result, and do not generalise from fewer than 20 items.

## Results

Copy this block for each trial.

```
### <trial> <model> <effort>, <date>

- Items: <n>
- Result: <caught / agreement / false waits>
- Cost: <total>, <per item>
- What it would save: <or "no saving">
- Decision: <adopt | keep the current model | run again with ...> and why
```

Track round 3+ share and tokens per merged ticket before and after each adopted change in Audit's "Before and after each change" table; the figures there are correlations, not causes.
