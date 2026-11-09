# Complete operator briefs: reviewed contract and implementation map

Parent [#759](https://github.com/Luke-Bradford/mission-control/issues/759).
Server [#1389](https://github.com/Luke-Bradford/mission-control/issues/1389), L.
Dependent web [#1390](https://github.com/Luke-Bradford/mission-control/issues/1390), M.

The controller published these independently reviewed contracts on 3 November 2026:

- [Server contract](published-server-child.md)
- [Web contract](published-web-child.md)
- [Parent acceptance contract](published-parent-update.md)
- [Publication identities](publication.json)

The [original audit](audit/README.md), original drafts and [hash manifest](audit/manifest.json)
retain the source-based refinement, exact 9981 baseline and original limits. Current implementation
starts from main d192dd83d42299dfe52aedccf2791c4ab91b0169; its successor changes from9981 were native
Overview proposal documentation/assets, with no brief product-contract delta. The older 7d878cfe
private planning worktree is unchanged. Its unresolved-policy wording and breaker-alias gap are
historical; roadmap line35 supplies the FYI policy and PR1376 fixed the alias.

## Implementation sequence

1. Prove intake/legacy-default boundaries red on unchanged production; retain exact commands/results.
2. Add shared content/action types, strict operator validation and server source/action identity.
   Keep ordinary for:flight intake lightweight and old data readable without fabricated authority.
3. Add durable decision epochs/receipts and bound explicit-choice dispatch for every contract family.
   Share existing typed paths and preserve actor provenance, source/head/hold and final run checks.
4. Integrate positive ordinary-guidance/direct-queue defaults with #741's existing40-minute ledger,
   recovery and transactional outcome semantics; never default protected/unverified operations.
5. Update every producer/read model and retain current shipped UI compatibility until1390.
6. Run bounded meaningful affected checks and workspace types/lint/build in the shared lane;
   freeze source/tests/evidence for fresh independent review and normal CI. No full local suite.

This document records planned implementation, not completion. No live/provider/crew/observed-loop,
real GitHub operation test, live breaker or deployment is needed or claimed. Existing direct
FLIGHT/operator authority remains intact. No new policy approval wait or scheduling daemon is introduced.
