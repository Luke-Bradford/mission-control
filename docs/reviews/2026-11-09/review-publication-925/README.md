# Negated completion text in GitHub review output

This is a bounded continuation of pipeline ticket #925. It does not complete that parent's
24-hour observation requirement.

## Observed failure

Native review 1363 of PR #1654 reported spec and quality PASS with no findings on
`fe6895814b9244bffbdba2db4ece54c89a2f9f2d`. Its summary said the continuation did not close
the parent performance issue. The generated GitHub text contained a closing keyword directly
before that issue reference. The text guard withheld the comment, leaving mc/review pending.
Reconstructing the comment through the real text check returned a closing-reference refusal.

A controller publication projection corrected the outbound sentence without editing the review
row or immutable report. The normal publisher then passed the unchanged text check, posted the
actual passing status and allowed the ordinary guarded merge. This change removes the need for
that one-off projection in subsequent reviews.

## Behavior

The formatter reuses the existing closing-reference grammar. An immediately negated, bare
issue reference uses plain wording: `does not close #933` becomes `does not close issue 933`.
It handles ordinary negations and contractions without changing the general GitHub classifiers.
Named repository and URL references are left to the existing reference checks.

Only free prose is formatted: external review summaries/findings, and the prose fields of the
compact QA section in a crew-owned PR body. Review rows and immutable reports stay verbatim.
Commands, counts, source heads, paths, reviewer identity and report links are not rewritten.
A generated note discloses the prose rendering. Both existing publication paths still check the
complete resulting text before writing.

Positive closing commands, mentions, secrets and cross-repository references remain refused.
A reported command containing disallowed text stays unchanged and withholds publication; it is
never rewritten to resemble a command that was not run. A blocking verdict stays a failure after
its prose is formatted. Repeated publisher instances retain the existing single-comment behavior.

## Regression evidence

On unchanged baseline `71e4412ebd3fc15113800589af8b2d33b104ec2c`, the external-publication
regression uses a real stored QA report and the real text check. Its ordinary summary case passes;
its negated-parent case fails because no comment is posted. The native-publication regression
also fails through the real PR-body edit guard before the compact-QA renderer correction. An
earlier native fixture omitted its required visual-pair array; that fixture error was corrected
and is not counted as a reproducer.

The corrected focused Store-backed publication, native publisher, QA archive and core guard suites
pass 1,610 cases. They check unchanged stored evidence, successful and failed verdict publication,
restart idempotency, exact command preservation, and the existing text refusals. Workspace lint,
typechecks and production build pass; final committed-head validation and the required full local
suite are recorded in the PR. The controller waits for the preserved author's active related-test
run before starting its own full suite.

## Security and delivery

No new GitHub verb or privilege is introduced. The text checks, ownership, current-head review/CI,
merge approvals, quotas, installer policy and observed-loop restrictions remain in force. The
shared formatter is not called by ordinary author PR/commit text validation. Fresh independent
most-capable review and exact-head CI are required before merge, followed by normal Update.
