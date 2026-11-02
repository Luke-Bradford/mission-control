# Desktop density mockups — 2 November 2026

Proposal for #1193, following the operator-approved [density plan](../../research/2026-11-01-hud-density-plan.md) in PR #1351. **Awaiting separate operator mockup approval.** This does not authorise build tickets.

Open the self-contained prototypes. All work data is fictional; forms and actions stay in this browser. Fonts are embedded with [licences](../../mockups/2026-10/density-font-licenses.txt).

- [Overview](../../mockups/2026-10/overview-density.html) — attention, lane summary, eleven-seat roster, activity durations and machine resources.
- [Agent](../../mockups/2026-10/agent-density.html) — ask/result, next decision and exact-head evidence before detailed history.
- [Setup — Repos & seats](../../mockups/2026-10/setup-sessions-density.html) — representative Add agent form, grouped fields and validation.

The layout is compact below 2200 CSS px. The quiet FLIGHT dock starts as a 48 px rail there, and as a 380 px summary above it. Its draft and explicit open/closed choice survive toggling. Body text stays 13 px; supporting text stays 12 px; only mono labels use 11 px. The approved 32 px compact row is a documented exception to the design system’s default 40 px row.

## Rendered evidence

Each screenshot is the exact viewport, without full-page stretching. Pages scroll vertically where needed; the roster has a bounded scroll region.

| Page | Viewport | Light | Dark |
| --- | --- | --- | --- |
| overview-density | 1440x900 | [Light](overview-density-1440x900-light.png) | [Dark](overview-density-1440x900-dark.png) |
| overview-density | 1920x1080 | [Light](overview-density-1920x1080-light.png) | [Dark](overview-density-1920x1080-dark.png) |
| overview-density | 2560x1440 | [Light](overview-density-2560x1440-light.png) | [Dark](overview-density-2560x1440-dark.png) |
| overview-density | 1280x900 | [Light](overview-density-1280x900-light.png) | [Dark](overview-density-1280x900-dark.png) |
| overview-density | 1600x1000 | [Light](overview-density-1600x1000-light.png) | [Dark](overview-density-1600x1000-dark.png) |
| overview-density | 1600x700 | [Light](overview-density-1600x700-light.png) | [Dark](overview-density-1600x700-dark.png) |
| agent-density | 1440x900 | [Light](agent-density-1440x900-light.png) | [Dark](agent-density-1440x900-dark.png) |
| agent-density | 1920x1080 | [Light](agent-density-1920x1080-light.png) | [Dark](agent-density-1920x1080-dark.png) |
| agent-density | 2560x1440 | [Light](agent-density-2560x1440-light.png) | [Dark](agent-density-2560x1440-dark.png) |
| agent-density | 1280x900 | [Light](agent-density-1280x900-light.png) | [Dark](agent-density-1280x900-dark.png) |
| agent-density | 1600x1000 | [Light](agent-density-1600x1000-light.png) | [Dark](agent-density-1600x1000-dark.png) |
| agent-density | 1600x700 | [Light](agent-density-1600x700-light.png) | [Dark](agent-density-1600x700-dark.png) |
| setup-sessions-density | 1440x900 | [Light](setup-sessions-density-1440x900-light.png) | [Dark](setup-sessions-density-1440x900-dark.png) |
| setup-sessions-density | 1920x1080 | [Light](setup-sessions-density-1920x1080-light.png) | [Dark](setup-sessions-density-1920x1080-dark.png) |
| setup-sessions-density | 2560x1440 | [Light](setup-sessions-density-2560x1440-light.png) | [Dark](setup-sessions-density-2560x1440-dark.png) |
| setup-sessions-density | 1280x900 | [Light](setup-sessions-density-1280x900-light.png) | [Dark](setup-sessions-density-1280x900-dark.png) |
| setup-sessions-density | 1600x1000 | [Light](setup-sessions-density-1600x1000-light.png) | [Dark](setup-sessions-density-1600x1000-dark.png) |
| setup-sessions-density | 1600x700 | [Light](setup-sessions-density-1600x700-light.png) | [Dark](setup-sessions-density-1600x700-dark.png) |

## Alternate states

| State · 1920×1080 | Light | Dark |
| --- | --- | --- |
| overview-expanded-flight | [Light](overview-expanded-flight-light.png) | [Dark](overview-expanded-flight-dark.png) |
| overview-disconnected | [Light](overview-disconnected-light.png) | [Dark](overview-disconnected-dark.png) |
| agent-long | [Light](agent-long-light.png) | [Dark](agent-long-dark.png) |
| agent-empty | [Light](agent-empty-light.png) | [Dark](agent-empty-dark.png) |
| setup-validation | [Light](setup-validation-light.png) | [Dark](setup-validation-dark.png) |
| setup-many | [Light](setup-many-light.png) | [Dark](setup-many-dark.png) |

## Checks

[Measured browser results](verification.json): 36 viewport/theme/page combinations, zero script errors, no horizontal document overflow, no visible control smaller than 24×24 px, no undersized proportional text including scaled SVG labels, and all eleven default crew rows contained in their scroll region. The 1440×900 first render and larger page examples were inspected.

Interaction checks exercise one, many (50 rows), empty, long, loading, error, stale and disconnected fixtures. Stale/disconnected writes are disabled. FLIGHT toggle retains its draft and returns focus to the rail. The representative form rejects a duplicate callsign, accepts a valid fictional entry, and changes area/scratch controls for the review role. These checks validate this prototype, not the live application.

This covers the three representative density mockups required by the approved plan. The remaining per-page design work in #677 stays open. No product code, backend behaviour, crew state, observed loop, GitHub workflow or Mission Control rule changes here.
