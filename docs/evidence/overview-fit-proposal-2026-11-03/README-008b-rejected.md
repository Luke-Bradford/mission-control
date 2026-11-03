> **Rejected historical gallery.** This records the former008b proposal and its original claims. The operator later rejected the true4K composition. All “current” and “final” wording below refers to that earlier phase only; it is not a current recommendation. The [active gallery](README.md) supersedes it.

# Overview operational canvas proposal

One design proposal, with a compact 1080p monitoring view and deliberate investigation detail on taller CSS screens. No production files changed; no live/API/provider actions or GitHub publication.

[Open the native proposal](../../mockups/2026-11/overview-fit-proposal/index.html) · [complete inventory and size budgets](../../mockups/2026-11/overview-fit-proposal/inventory.md) · [phase/source/hash bindings](phase-bindings.json) · [original review transcript](review-transcript.md) · [finding resolution map](resolution-map.json).

Final visual source is `0c92ee23dfe9973203167e0299a6d1950c024dbc`, from base `99e8404ea2e78e442dee828092f6b997582ddbe7`. All images use explicitly fictional source-shaped data. The private actual-live audit supplied composition measurements; none of its real identities/screenshots are included. Earlier proposal phases remain labelled with their own sources and capture times.

## Current five full contexts

| Actual CSS viewport / DPR / theme / FLIGHT | Full view | Timeline label proof | Machine time/unit proof |
| --- | --- | --- | --- |
| 1920x1080-dpr1-light-folded | [full](final/1920x1080-dpr1-light-folded-full.png) | [Timeline](final/1920x1080-dpr1-light-folded-timeline.png) | [Machine](final/1920x1080-dpr1-light-folded-machine.png) |
| 1920x1080-dpr1-dark-folded | [full](final/1920x1080-dpr1-dark-folded-full.png) | [Timeline](final/1920x1080-dpr1-dark-folded-timeline.png) | [Machine](final/1920x1080-dpr1-dark-folded-machine.png) |
| 2560x1440-dpr1-light-open | [full](final/2560x1440-dpr1-light-open-full.png) | [Timeline](final/2560x1440-dpr1-light-open-timeline.png) | [Machine](final/2560x1440-dpr1-light-open-machine.png) |
| 2560x1440-dpr1-dark-open | [full](final/2560x1440-dpr1-dark-open-full.png) | [Timeline](final/2560x1440-dpr1-dark-open-timeline.png) | [Machine](final/2560x1440-dpr1-dark-open-machine.png) |
| 3840x2160-dpr1-dark-folded | [full](final/3840x2160-dpr1-dark-folded-full.png) | [Timeline](final/3840x2160-dpr1-dark-folded-timeline.png) | [Machine](final/3840x2160-dpr1-dark-folded-machine.png) |

The1920 composition is1200 / 588px. Crew 460px, activity 216px and Pipeline 112px retain the accepted row/column geometry. Analytical children flow normally: Provider 144 +Timeline 224 +history 184 +Machine 252 +36px gaps =840px. Machine ends at1021; actual main scrollHeight/clientHeight are1001 / 1001 with scrollTop 0. No scrollbar was hidden to obtain that result.

At 2560/open, the three columns are1050 / 507 / 507px. The full allowance table is visible below Pipeline; eight Timeline lanes and larger measured Machine traces use the extra height. At true3840 CSS width, all 13 lanes,12 events, full window comparison and all five measured histories are visible. These are additional useful comparisons, not enlarged empty cards.

FLIGHT at1920 is a temporary keyboard modal over the analytical side: global constraints and crew/log remain visible, while background interaction is inert. Close/Escape restores the canvas and draft/focus. At 2560/3840it sits alongside the canvas. This is an explicit interaction tradeoff, not a claim that covered charts remain simultaneously usable.

## Source-bound complete detail and physical scaling

These are actual V3 / f79 captures, before the final label and target corrections. They are not relabelled current screenshots. The full-reader/modal/filter code they prove is unchanged by those narrow corrections.

| Proof | Actual image |
| --- | --- |
| 1920x1080-dpr2-light-folded-full.png | [V3 actual capture](v3/1920x1080-dpr2-light-folded-full.png) |
| 1920x1080-dpr2-dark-open-full.png | [V3 actual capture](v3/1920x1080-dpr2-dark-open-full.png) |
| 3840x2160-dpr1-light-open-full.png | [V3 actual capture](v3/3840x2160-dpr1-light-open-full.png) |
| 1600x700-dpr1-light-folded-full.png | [V3 actual capture](v3/1600x700-dpr1-light-folded-full.png) |
| detail-subcent-cost.png | [V3 actual capture](v3/detail-subcent-cost.png) |
| detail-machine-histories.png | [V3 actual capture](v3/detail-machine-histories.png) |
| detail-machine-processes-visible.png | [V3 actual capture](v3/detail-machine-processes-visible.png) |
| detail-machine-transcripts-visible.png | [V3 actual capture](v3/detail-machine-transcripts-visible.png) |
| detail-machine-lock-queue-actions-visible.png | [V3 actual capture](v3/detail-machine-lock-queue-actions-visible.png) |
| detail-provider-provenance-end.png | [V3 actual capture](v3/detail-provider-provenance-end.png) |

[V3 interaction receipt](v3/interaction-checks.json) records 18 real Tab targets confined in the modal, nested-reader return, retained draft and restored focus, all seven filters with actual visible rows, and complete-detail paint bounds. Process/transcript/lock sections were truly scrolled into view: scrollTop 2125 / 2125 / 2259 of 2287, with every 4 / 12 / 6 row/action painted. The old V2 End-named frame is explicitly rejected below.

The1920×1080DPR 2 images are3840×2160 physical pixels but retain the1920 CSS composition. Smaller/shorter views retain native scrolling and explicit limits;1600×700 uses a96px strip and shows more recent activity, but not every normal seat/module in the initial screen. This is not presented as a full-page fit.

## Qualitative author observations

- Crew retains fixed fields,32px rows and useful flexible Work width. Ticket IDs, held/queued state and context used/window/remaining stay apparent; full titles/reasons have a named route. Cost is this run; rate is a 30m average; neither is provider allowance.
- Live activity stays directly below Crew. Full filter set and event links remain; extra height shows twelve meaningful events. Pipeline follows with aligned headers/examples and unambiguous total/unshown counts.
- Provider summary labels its tightest-window selection. Stale/unknown remaining and resets remain words, and the global low-allowance constraint stays visible. Complete source/freshness/backoff and all windows are available, inline on taller screens.
- Timeline0/50/100% labels align exactly with the measured span track. Finalchk12m/rev10mglyphs are painted inside their bars. This proposal uses short readable kinds with a legend; a production implementation must place labels outside still-shorter spans instead of clipping.
- Machine compact traces retain endpoints/window/current/peak/range. Richer plots and raw data use real vertical capacity; complete process/transcript/lock detail is preserved. Disk means free GiB; RAM plot means percent, alongside its GiB denominator.
- Allfivehistory comparisons retain units, nonzero sub-cent cost ticks, fractional count axis ticks, and missing-minute gaps. Raw samples remain accessible. No new collection or duplicate poll is implied by this design.

## Historical failures, not accepted final evidence

| Phase / reason | Actual representative |
| --- | --- |
| v1 · retained critique/failed proof | [original](v1/1920x1080-dpr1-light-folded-full.png) |
| v1 · retained critique/failed proof | [original](v1/3840x2160-dpr1-dark-folded-full.png) |
| v1 · retained critique/failed proof | [original](v1/1920x1080-dpr1-dark-open-full.png) |
| v2 · retained critique/failed proof | [original](v2/1920x1080-dpr1-light-folded-full.png) |
| v2 · retained critique/failed proof | [original](v2/2560x1440-dpr1-light-open-signals.png) |
| v2 · retained critique/failed proof | [original](v2/detail-machine-lock-transcripts-end.png) |

Complete normalized phase manifests retain all originalframehashes and actual UTCs, including uncurated private frames; they do not claim every raw PNG is in Git. Final scope and alloriginalreportedissues are in the [resolution map](resolution-map.json).

## Reproduce

With the repository dependencies and a local Playwright Chromium installed, run from a checkout:

```sh
node --experimental-strip-types docs/evidence/overview-fit-proposal-2026-11-03/capture.ts "$PWD" /tmp/overview-fit-current
node --experimental-strip-types docs/evidence/overview-fit-proposal-2026-11-03/capture-full-interactions.ts "$PWD" /tmp/overview-fit-full
```

The portable adapters take explicit `ROOT` / `OUTPUT` paths and use only local file URLs. Their original executed helper snapshots and transformations are identified in [phase bindings](phase-bindings.json); adapters are not falsely claimed as the byte-identical executed scripts. Existing full App integration, actual permissions/auth/error transitions, lazy reads and clock isolation remain future implementation checks. This artifact is a proposal assessment, not a production or live-data pass.
