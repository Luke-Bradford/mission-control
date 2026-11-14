# Triaging items

Read this when `items` holds anything, or when you pass an item up or dismiss one. Where this file and `roles/FLIGHT.md` differ, the role wins. `mc brief_item`'s description carries its fields and limits.

## The triage window

- `items` holds everything waiting for triage, oldest first. Each carries `triageRemainingMs`: the time left in your triage window for it. For anything that arrived while you were away, the window counts from your run's start.
- Past the window, the operator sees one "FLIGHT is not triaging" item, counting what waits on you, instead of the items themselves.
- These reach the operator as themselves anyway:
  - approvals, decisions, flags and rate limits;
  - a missed stuck run or error (stalled, blocked, parked, waiting on the test lock, or errored);
  - a run parked on budget or account.
- A held hub Update (`hub-update-held`) is yours on a superuser repo while you are live, with the usual triage window counted from when it was first held. Run it in a quiet gap with `POST /api/update` through `mc operator`; while seats work, the call holds new runs and waits for their turns to end, and a 409 naming a seat means call again. You may keep it, but not hold it. It goes to the operator when you are stopped or your window passes. `hub-update-person` (a symlink or gitlink, a pnpm purge, a checkout off main) is the operator's from the start.
- While you are stopped or not running, that item counts only the seats' questions and chatter; everything else goes to the operator directly.
- It clears as you triage the items, or come back.

## Settle, keep or pass up

- Settle what your tools allow.
- Keep what the crew, the controller or you can handle with `mc brief_item { key, for: "flight", assessment, did, ask, recommendation, options?, basis }`. Kept items appear as "FLIGHT is handling". Clear their cause when resolved, or pass them up later.
- Pass up only what "What belongs to the operator" lists (product direction, money, security exceptions, irreversible or external actions, the floor and approvals). Use `for: "operator"` and a recommendation.
- For a decision with no item of its own, ask with an `@CAPCOM` question in your reply: it appears immediately.
- Never keep an approval or floor decision from the operator.

## Dismissing resolved items

- Use `mc dismiss_item { key, basis }` to settle an attention item whose subject is resolved. Do it in the same wake you resolve it, so Needs you holds only live decisions.
- Besides what its description protects, it refuses:
  - escalations from other loops;
  - rate limits;
  - your own questions to the operator;
  - a person's message for the operator;
  - flags not raised about a run;
  - notes on a run under an operator hold.
