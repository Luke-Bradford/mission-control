# Corrected Overview design contract — 3 November 2026

Status: proposed correction, not a rendered or approved result. Historical source `008b362d` and its evidence stay unchanged in Git. Its true-4K composition was rejected by the operator; the saved failed QA report is `1fe40c8e16ae4629b1d5bf5abe9ed501855fca0efc1e859919f20e3244a7a749`. Production checkpoint `63e8251e` is held separately.

## Operator outcome

Adapt the Overview coherently across 1080p and true 4K while preserving accepted crew spacing and all useful content. The initial view must show who is working or held, what happened, the next decision and capacity/allowance/host constraints. Merely retaining every metric somewhere does not meet this outcome.

Preserve the normal eleven configured seats, all states, two read-only loops, seven accepted crew columns (128 / 80 / flexible Work / 96 / 64 / 178 / 52px), 32px rows, original activity filters and actions, Pipeline/Board routes, context versus provider semantics, unknowns/stale/backoff, measured intervals versus instants, exact readings and complete readers. Values remain labelled fictional source-shaped data. No API or authority changes.

## Content and independent columns

| Domain | Normal data and task | Size budget | Full access / responsive choice |
| --- | --- | --- | --- |
| Primary operations | 11 crew + 2 loops; 12 recent activity examples; five Pipeline lanes | Crew width 1050 min / 1200 preferred at1080 / 1280 max; normal Crew about430–460px; Activity216 at1080 or about368 with actual12events at4K; Pipeline112. These flow independently. | Long work/reasons and all120events have named readers. Extra seats scroll visibly. No Machine/allowance height delays Activity. |
| Provider and host | Three accounts × two windows, explicit tightest window; CPU/RAM/disk; allocation/process/transcript/lock facts; context known8/11 | At1080: provider144 + Machine252; at4K: complete allowance about340, Machine about450–550 from facts, context164. Width500 min, about1120–1280 in wide mode. | Complete allowance replaces compact summary rather than duplicating it. Three host plots become a single aligned horizontal row at sufficient width; each plot about112px high, maximum160px. Full raw samples/identifiers/permissions remain in readers. |
| Observation and decisions | 13 Timeline lanes (four with measured activity), three operator items, five distinct histories of30minutes | At1080: Timeline224 + selected history184; at4K: Timeline about390 plus five history rows about220 each. Plot width about500–640 with exact recent readings alongside, not stretched across remaining width. | One canonical surface per history. Compact views select one of five; wide/tall views expose five. Latest/peak/unit/window/gaps and raw30 samples retained. No detached lower comparison grid. |

1920×1080 folded: about1800px content, primary1200 +12gap +588 analytical column. The analytical column flows provider → Timeline/next → selected history → compact Machine, about840px total. Main shell49+30,24px gutters,96px KPIs+12gap leave about845px. These are normal-content hypotheses, not fixed clipping limits.

3840×2160 folded: use the actual3720px content width: primary1280 +12 +provider/host1280 +12 +observations1136. Expanded400px FLIGHT leaves about3368px: primary1280 +12 +provider/host1120 +12 +observations944. Each domain begins at the same top and flows independently. No canvas max2880, shared maximum-row delay or detached comparison grid. The primary may end earlier; whitespace there is intentional after the normal operational content, not a reason to duplicate histories.

At2560: three columns are useful if each analytical domain has at least500px. Full account table can appear at1440height; compact history selector remains unless there is meaningful vertical space for all five. At1920 expanded, the400px conversation temporarily overlays analytics, keeps the accepted monitoring geometry, retains draft and uses inert background/Tab/Escape/focus restoration. At smaller widths, domains reflow below primary rather than shrinking text. Short-height roster scrolling is explicit. All human labels minimum12px,11px only mono.

## Review sequence and evidence

Inspect full1920×1080 and3840×2160 both themes first. Record hierarchy, column allocation, chart meaning, unused spaces and disclosure tradeoffs before geometry/crops. Only then inspect2560/open and1920DPR2, which retains1920CSS layout. Existing interaction/filter/readers remain requirements. Actual render source hashes, viewport/theme/DPR, fictional clock, timestamps and image hashes must bind each new phase. Earlier images remain labelled rejected history. No whole-page pass follows from narrow axis or glyph checks.
