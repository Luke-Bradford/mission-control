# Desktop-density research — 1 November 2026

Stage 1 of #1193 and current-screen evidence for #677. The inspected HUD is commit `b46f1a718d47fd79e51ce6135b3460c0851280f7`; subsequent logger, shutdown and board-follow fixes do not change these layouts. This report precedes a density plan. No plan, mockup or build ticket is approved here.

## Method and evidence

The capture runs use a private database/config copy, a spare loopback port, crew disabled and `MC_NO_LOOP_WRITES=1`. Browser writes and external requests are blocked. No live hub, crew or observed-loop process was used for a test action. Captures use Chrome at device scale 1 in 1920×1080 and 2560×1440, light and dark, with fonts loaded. Map captures wait for actual tiles and Audit for populated results. The earlier loading-state captures are excluded.

The [evidence gallery](../evidence/desktop-density/index.md) links the page/form matrix and numeric DOM measurements. Published images replace saved free-form prose, titles and machine-home paths before rendering; the originals remain private. They show current components with sanitised content, not a redesign. Measurements distinguish those illustrations from the original data sample. The QA send-back view uses a labelled read-only response fixture to expose a form when no real acceptance decision is appropriate. The final onboarding mode/account view likewise simulates successful checks in the browser; it transmits no check or onboarding request.

A screenshot and a DOM width check establish visible geometry, not complete accessibility, chart accuracy or all future data states. The no-horizontal-overflow result applies to the sampled top-level document; it does not certify every inner scroller or long-name case.

## What changes at 1080p

| Current observation | 1920×1080 sample | 2560×1440 sample | Implication |
| --- | --- | --- | --- |
| FLIGHT dock | Fixed 380 px column; the quiet state chiefly offers a waiting count, Expand and Hide | Same 380 px column | About one fifth of the narrower desktop is reserved before it provides useful detail. This is a layout question. |
| Overview crew panel | 1086×342 px in the original sample | 1553×712 px | The smaller display exposes fewer seats before scrolling. Reducing all fonts would miss the allocation of vertical space. |
| Overview pipeline | 1504×183 px | 2144×183 px | A broad high-level summary competes with crew and log height even when few lanes have work. |
| Audit quality panels | Each leading panel is about 748×7076 px in the original sample | Wider columns still contain long evidence lists | This fails the operator's one-screen recommendation goal; #1185 addresses the information model, beyond density tokens. |
| Add-agent form | A narrow three-field group sits in a much wider Setup work area | More spare width, same basic form organization | Field widths should follow the expected input; related groups and validation should remain near the action. |
| Page overflow | No top-level horizontal overflow across the settled page/common-form matrix | Same | Inner clipping, field labels, table scroll and keyboard reach still need individual assessment. |

These are observations of the copied data, not universal fixed panel sizes: viewport, selected data and open state can change them. The numbers above come from the original-content sample. Sanitised illustrations may wrap differently.

## Type and spacing against the design system

`hud.css` defines title 20/28, panel 14/20, body 13/20, secondary 12/16 and mono micro 11/16, matching the published type tokens. Computed text also uses 12/20 and 11/20 in dense rows. In the Overview sample, visible panel `h2` labels compute to 13/20 rather than the 14/20 panel token, and header padding varies from 4×8 to 8×12 px. The DOM inventory includes off-screen and screen-reader-only nodes with positive geometry; its type counts are not an assertion that every counted node is visually readable. The 11 px exception applies only to mono micro labels; it is not permission to shrink general copy.

The measured Comms `<small>` elements render at **10.8333 px in IBM Plex Sans**. That is below the 12 px minimum and does not qualify for the 11 px mono exception. The public numeric inventory retains tag, class, font and size so this can be reproduced without publishing message text.

The shell currently uses 12 px padding/gaps (`--sp-3`) at both requested widths. The design system calls for 24 px gutters at these widths and 16 below 1600. This is a documented mismatch to resolve explicitly in the plan; silently introducing another token scale would make the rule less useful. Panel containers often have zero padding because their `.ph`/`.pb` children supply it; a container's zero must not be reported as a zero-padding content violation.

Buttons and fields are measured individually in the inventory. A small checkbox's graphic alone is not its full clickable label target. The later plan must preserve at least 24×24 px interaction targets and the current type minimums, while checking actual label bounds and focus states.

## Comparable dense tools

| Tool | Published typography/density basis | Relevant pattern |
| --- | --- | --- |
| Grafana | [Theme source](https://raw.githubusercontent.com/grafana/grafana/main/packages/grafana-data/src/themes/createTypography.ts) currently defaults to 14 px body with 22 px line height and 12/18 small text. [Tables](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/table/) offer Small/Medium/Large cell height. This is source/default evidence, not a pixel audit of every deployed panel. | Adjust table geometry, wrapping and pagination deliberately. |
| Linear | [Preferences](https://linear.app/docs/account-preferences) exposes font-size choice; [display options](https://linear.app/docs/display-options) vary by view. These sources do not specify a universal deployed row height or base pixel size. | Keep user font preference separate from view density. |
| GitHub Actions | [Workflow monitoring](https://docs.github.com/en/actions/how-tos/monitor-workflows) separates progress graph, job/step detail and logs. [Primer typography](https://primer.style/product/getting-started/foundations/typography/) supplies the product design basis, not a guarantee about every Actions screen's computed pixels. | Show the useful summary and disclose diagnostic detail. |
| Datadog | [Increase density](https://docs.datadoghq.com/dashboards/configure/) places groups side by side on large screens; [table options](https://docs.datadoghq.com/dashboards/widgets/table/) manage context links, search chrome and unavailable values. No exact deployed base font is asserted from these docs. | Use width for useful related information, rather than making each widget or form wider. |

No comparable tool justifies violating Mission Control's existing text minimum. The evidence points toward a coherent density/layout decision, with specific type exceptions repaired, rather than reducing every font.

## Coverage and next stage

The gallery covers the main routes, ticket/trace views, all Setup sections, all four FLIGHT questions, Audit alternatives and Comms selections. Its form inventory maps each current `<form>` implementation to an opened state: add/edit agent and session; repo seats and onboarding; account add/edit/switch; template editing; Teams selection; pause all/selected; Away; dock, Agent and attention conversations; queue focus; memory add/edit; hold conditions; QA question/send-back. Brief, update log, help and command palette dialogs are included as adjacent input surfaces.

This is layout research. Save/submit actions were not performed, so it does not certify permissions, persistence or a successful operational transaction. Conditional states that use fixtures are named in the manifest.

The operator sees this report before Stage 2. That plan must choose either a compact token/layout set below 2200 px or a Comfortable/Compact preference with Compact as the 1080p default; define the default FLIGHT dock content; and specify labels, widths, grouping, buttons and validation for every inventoried form. After plan approval, mock up Overview, Agent and one form at both sizes/themes. The operator approves that mockup before any build tickets.
