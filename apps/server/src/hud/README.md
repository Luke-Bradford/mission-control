# hud

The builders for what the HUD pages show: `hud.ts` (crew rows, Needs-you items), `views.ts` (overview and
activity), `overview.ts`, `agent-detail.ts`, `timeline.ts`, `ticket-history.ts` and `topic-gate.ts`. They
read the store and return already-shaped views; the routes in `../api.ts` serve them.
