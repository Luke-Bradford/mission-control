# Comms graph observation on published 81c6608

The new layout fits all ten controlled session seats plus the operator and crew hub without overlapping names, including a separate realistic-name render. This head is still not ready to close #1663: a newly inserted signal does not travel, the full chart omits the required Waiting and Just said lists, and the isolated browser still has material idle CPU cost outside the page renderer.

Source: PR #1675 at `81c6608b9fcba540b6d8b4888f3c88e4e1fd8d6d`. The controller rendered the actual App with a frozen controlled fixture and no production source edits. This is published-head evidence, not a new formal RETRO review or live acceptance.

## View

[Actual graph with realistic names](graph-realistic-names-1920x940-dark.png) · [Original controlled labels](graph-1920x940-dark.png) · [Recording beside the committed prototype](prototype-and-app.webm) · [Comparison before traffic](side-by-side-before.png) · [Comparison after traffic](side-by-side-after.png).

The record is 14.76 seconds, 3840×988, 25 fps: two 1920×940 viewports beneath labels. The bundled Playwright ffmpeg recognized this input metadata; its requested null output format was unavailable, so that command exited 234 and is not a successful full decode test. The recording and representative settled graph images are retained. The controller inspected the 1920×940 realistic-name image: labels are readable, nodes form an organic ring, and the amber wait is visible. There is no adjacent word list on this full-chart route.

The prototype side uses the current committed Comms export, unchanged from 686252d, with its historical message fixture. Its retained public placeholder text is not fresh operational Comms. The application side uses the declared synthetic ten-seat cohort; this is a design comparison, not a claim that both sides contain identical messages.

## CPU observation

Video encoding and the prototype are closed before the separate CPU observation. After a fixed three-second warmup, the controller samples actual process CPU-time deltas divided by elapsed monotonic wall time. Renderer and the whole isolated Chromium process tree are reported separately; the latter includes the GPU process. This is neither whole-host CPU nor an unsupported claim that all browser overhead belongs to the page renderer.

| Phase | Actual elapsed | Messages | Renderer mean | Isolated browser-tree mean |
|---|---:|---:|---:|---:|
| Idle graph | 30.038 s | 0 | 1.365% | 8.689% |
| Burst | 60.045 s | 20 | 1.615% | 8.144% |
| Graph unmounted on Overview | 30.032 s | 0 | 0.466% | 1.432% |

All 20 burst messages were introduced between 0.019 and 57,052 ms; the final sample ended just after 60 seconds. Absolute deadlines prevent sampling overhead from stretching the burst beyond a minute. Maximum observed frame round-trip was 27.0 ms, which is narrower evidence than testing every other application interaction.

In the idle interval, the GPU process accounts for 7.291% and the page renderer for 1.365%. The largest approximately one-second browser-tree sample was 51.286% idle and 50.966% during the burst; renderer peaks were 2.959% and 2.998%. The renderer is below the requested idle threshold in this sample. The aggregate remains well above it, and drops when the graph is unmounted. This packet therefore does not claim the whole idle-cost requirement passed by considering the renderer alone. Burst mean is below 25%; the aggregate peak is above it.

The current CSS uses an infinite group animation, despite a long static part of each cycle. The process breakdown points to compositor/GPU work as the next diagnostic target; it does not by itself prove which CSS line causes every GPU cycle. No motion, data, threshold or required element was removed by the controller to improve these numbers.

The same primary generic-label cohort as the preceding measurement is retained. Realistic call signs were applied only for a supplementary geometry render after the timed phases. That render also has no overlapping or clipped names. No graph-resource fetch was observed during the unmounted interval. The rest of the App shell remains mounted and has a nonzero baseline.

## Moving-light regression

A message was introduced with the page already open for about 2.5 seconds. Six samples over roughly 615 ms found its new circle fixed at x=29.5, y=124.5, opacity 1 and CTM translation 0/0. The motion element had no current animation interval. Merely finding a `.comms-particle` element would have missed this failure.

The source inserts `animateMotion` and opacity animation with `begin="0ms"` into an SVG whose clock is already running. A browser-only diagnostic then calls `beginElement()` on those existing elements. The circle moves from about (900,768) to (802,754) over the next samples, with no file or branch edit. This control confirms that the browser can animate the same path when its start is scheduled at insertion time.

[Unmodified-source stalled signal](motion-baseline-stalled-1920x940-dark.png) · [Browser-only start control](motion-control-beginElement-1920x940-dark.png) · [Raw motion observations](motion-probe-receipt.json).

The control image is deliberately altered browser state and is **not** evidence that the current published application starts its signals correctly. Both contexts close after the probe. The first diagnostic attempted `getStartTime()` without handling its no-current-interval exception; that instrumentation failure was corrected, not labelled a product JavaScript error.

## Provenance and limits

[receipt.json](receipt.json) retains raw CPU samples, source head, request observations, geometry, fonts, viewport, DPR 1, zoom 1, dark theme and timestamps. [Process components](idle-process-components.json), [one-second peaks](peak-samples.json), [host sample](host-sample.json), [fixture](fixture.json) and the exact [harness sources](harness-source/) are retained. The build uses the published head; the added browser bridge only supplies controlled resources and routes to the real App.

The host was busy: its captured sample reports 63.8% CPU across ten cores, load 7.37, and a native test run active. These process-scoped observations are not a controlled whole-host before/after experiment. Main measurement and motion probe completed without page errors. The harness also records unsupported global shell API reads returning 404; these are fixture limits, not claims of production API failures. The graph's own resources are supplied explicitly. The workload uses a synthetic agents-resource refresh, so it does not prove production SSE delivery within two seconds, stored reply settlement, or all-page responsiveness.

The previous 60b packet remains historical evidence. This packet records a changed head and a corrected absolute burst schedule. It preserves the remaining failures and introduces no merge waiver or review-counter change. The original ticket's moving signals, word lists and CPU outcome still need to be satisfied before closure.
