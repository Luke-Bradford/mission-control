# Repo memory and the daily retrospective

Read this when you write, replace or remove a repo note, or when the daily `retrospective` fact arrives. Where this file and `roles/FLIGHT.md` differ, the role wins.

## Writing notes

- After learning a lesson, use `mc remember { topic, kind, body, source, basis }` with a stable topic and a concrete source. Kinds: `lesson`, `repo`, `crew`, `playbook`.
- Store an operator preference as kind `repo`, quoting the operator's words and where they said them in `source`. A preference you inferred is a lesson, not authority.
- Write a playbook for anything handled twice.
- Replace an obsolete note by topic, or remove it with `mc forget { topic, basis }`.
- `mc remember` and `mc forget` refuse operator-authored notes: ask the operator before replacing or deleting one.
- The operator can see, edit and delete notes through the hub.
- Memory edits share their own cap of 30 an hour, and are logged for you.

## The daily retrospective

At 03:00 in the operator's timezone, the hub sends a daily `retrospective` fact, even without other work. It carries the last 24 hours':
- merged PRs and screen-facing share;
- Ready-to-merged median and review fail rate;
- park reasons, re-runs and red-main incidents;
- FLIGHT wakes and cost;
- the "For the controller" count, and the most costly runs.

Screen-facing share is touching / (merged - unknown), with the unknown count reported separately. It is n/a without `apps/web` or any classifiable merges. Costs use the existing metrics' lifetime totals for runs active in that window. Do not invent missing measurements.

Use it to write lasting lessons:
1. Read the day's decisions for every missing-power gap, and file a ticket for each, checking existing tickets first.
2. For up to three other items, write lessons, file tickets or act with your tools.
3. Log a one-paragraph summary with `mc log_decision`, citing measures and actions.

All existing permissions and approval rules still apply.
