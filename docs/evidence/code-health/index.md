# Code-health design evidence

Stage 3 of #1185. The plan in PR #1335 was approved before this prototype. This gallery requests a separate mockup approval; it creates no build tickets.

Open [the interactive prototype](../../../apps/web/mockups/code-health/index.html) in a browser. Its tabs, evidence dialogs, theme, collection states and actions run locally. Accept records an owner and review date; Dismiss records a reason; Snooze records a date. Reload resets the session. No request writes to a hub, GitHub, config or an agent.

Values come from the committed [research inventory](../../research/evidence/2026-11-01-code-health-inventory.json). Missing time-series, windowed change data, stable test IDs and duration units have named collection states. Seven- and 90-day selections do not relabel the 30-day aggregate.

## Browser checks

Chrome at 1×, both themes. All four tabs fit at 1600×1000; narrower or shorter windows scroll without clipping. Forty captures passed: no browser errors, horizontal document overflow, non-mono text below 12 px or controls (including links) below 24×24 px. The browser also exercised keyboard tabs, dialog Escape, Accept/Dismiss/Snooze, the test-file toggle, unsupported window selection and all six edge-case states. It also checked empty collection across range changes, disconnected actions after reset, and switching dialogs after whitespace validation errors. Numeric results are in [verification.json](verification.json).

| Tab | 1440×900 first render | 1280×900 | 1600×1000 | 1920×1080 | 1600×700 |
| --- | --- | --- | --- | --- | --- |
| overview | [light](overview-1440x900-light.png) / [dark](overview-1440x900-dark.png) | [light](overview-1280x900-light.png) / [dark](overview-1280x900-dark.png) | [light](overview-1600x1000-light.png) / [dark](overview-1600x1000-dark.png) | [light](overview-1920x1080-light.png) / [dark](overview-1920x1080-dark.png) | [light](overview-1600x700-light.png) / [dark](overview-1600x700-dark.png) |
| review | [light](review-1440x900-light.png) / [dark](review-1440x900-dark.png) | [light](review-1280x900-light.png) / [dark](review-1280x900-dark.png) | [light](review-1600x1000-light.png) / [dark](review-1600x1000-dark.png) | [light](review-1920x1080-light.png) / [dark](review-1920x1080-dark.png) | [light](review-1600x700-light.png) / [dark](review-1600x700-dark.png) |
| risk | [light](risk-1440x900-light.png) / [dark](risk-1440x900-dark.png) | [light](risk-1280x900-light.png) / [dark](risk-1280x900-dark.png) | [light](risk-1600x1000-light.png) / [dark](risk-1600x1000-dark.png) | [light](risk-1920x1080-light.png) / [dark](risk-1920x1080-dark.png) | [light](risk-1600x700-light.png) / [dark](risk-1600x700-dark.png) |
| test | [light](test-1440x900-light.png) / [dark](test-1440x900-dark.png) | [light](test-1280x900-light.png) / [dark](test-1280x900-dark.png) | [light](test-1600x1000-light.png) / [dark](test-1600x1000-dark.png) | [light](test-1920x1080-light.png) / [dark](test-1920x1080-dark.png) | [light](test-1600x700-light.png) / [dark](test-1600x700-dark.png) |

## Scope

This is a static design prototype. Production collection, ranking, recommendation storage, authorised ticket creation and agent tools remain later implementation work. Evidence dialogs show the available aggregate provenance; they do not invent individual PR or run details. Review command observations are not unique test attempts. Size snapshots are not file-growth trends.

Design check: pass on these rendered fixture screens. This is not a live-data acceptance check. Workspace lint, typecheck and build passed; full CI runs on the PR.
