# Sources

What the skill rests on, and which part each source supports. The rules are written in our own words;
nothing here is copied from these works. Use this list when a client asks why, and re-read the live pages
before a large piece of work, since vendor guidance changes. Compiled 9 November 2026.

## Research and books

| Source | Supports |
| --- | --- |
| William Cleveland and Robert McGill, "Graphical Perception" (Journal of the American Statistical Association, 1984) | The accuracy ranking of position, length, angle, area and colour in [chart-selection](chart-selection.md) |
| Edward Tufte, *The Visual Display of Quantitative Information* and *Beautiful Evidence* | Remove non-data ink; proportional scales; small multiples; sparklines |
| Stephen Few, *Information Dashboard Design* and *Show Me the Numbers*; papers at [perceptualedge.com](https://www.perceptualedge.com/library.php) | A dashboard as a single-screen display for monitoring at a glance; his list of common dashboard mistakes (starting with exceeding one screen and giving figures no context); bullet graphs; table design; the case against dual axes and gauges |
| Ben Shneiderman, "The Eyes Have It" (1996) | Overview first, zoom and filter, then details on demand |
| Cole Nussbaumer Knaflic, *Storytelling with Data* | Declutter; direct attention deliberately; titles that state the finding ([reports](reports.md)) |
| Steve Wexler, Jeffrey Shaffer and Andy Cotgreave, *The Big Book of Dashboards* | Designing from the scenario, not from a template |
| Benjamin Bach and others, ["Dashboard Design Patterns"](https://arxiv.org/abs/2205.00757) (IEEE VIS 2022) | A study of 144 published dashboards: recurring content and composition patterns and the trade-offs between screen space, paging and interaction |
| Masataka Okabe and Kei Ito, [Color Universal Design](https://jfly.uni-koeln.de/color/) | The colour-blind-safe category palette |
| Cynthia Brewer, [ColorBrewer](https://colorbrewer2.org) | Sequential, diverging and qualitative schemes |

## Standards

| Source | Supports |
| --- | --- |
| [Web Content Accessibility Guidelines 2.2](https://www.w3.org/TR/WCAG22/) | Contrast (1.4.3, 1.4.11), use of colour (1.4.1), text alternatives (1.1.1), keyboard (2.1.1), focus visible (2.4.7), target size (2.5.8), content on hover (1.4.13), reflow (1.4.10) |
| [International Business Communication Standards](https://www.ibcs.com/) | Consistent notation for actual, previous period, plan and forecast; red and green kept for variances |

## Design systems and vendor guidance

| Source | Supports |
| --- | --- |
| [IBM Carbon: dashboards](https://carbondesignsystem.com/data-visualization/dashboards) | Presentation dashboards (current state of key figures) versus exploration dashboards (search, sort, filter, drill down) |
| [Microsoft: tips for designing a dashboard](https://learn.microsoft.com/en-us/power-bi/create-reports/service-dashboards-design-tips) | Know the audience; fit one screen; most important content where reading starts |
| [Grafana: dashboard best practices](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/best-practices/) | Rate, errors, duration and utilisation, saturation, errors as starting sets; alert on symptoms; drill-down hierarchies |
| [Google, *Site Reliability Engineering*, "Monitoring Distributed Systems"](https://sre.google/sre-book/monitoring-distributed-systems/) | Latency, traffic, errors and saturation |
| [Financial Times Visual Vocabulary](https://github.com/Financial-Times/chart-doctor/tree/main/visual-vocabulary) and the [EU data visualisation guide](https://data.europa.eu/apps/data-visualisation-guide/) | Choosing a chart from the relationship to be shown |
| [UK Government Analysis Function: data visualisation guidance](https://analysisfunction.civilservice.gov.uk/policy-store/data-visualisation-colours-in-charts/) | Add colour only where it shows a useful difference; accessible category palettes; every chart needs a text alternative |
| [Datawrapper blog](https://blog.datawrapper.de/) | Choosing colour scales; why to avoid dual axes |
| [Nielsen Norman Group](https://www.nngroup.com/) articles on dashboards, skeleton screens and empty states | Preattentive reading of charts; loading and empty states |

## Other published agent skills surveyed

Read on 9 November 2026 to see what ground a skill of this kind usually covers and where existing ones are
thin. This skill shares their subject and the common literature above, and none of their text, examples
or house styles.

- `abdiraimov-otabek/dashboard-design-skill` (MIT): strong on component patterns and a screenshot review
  pass for web analytics screens.
- `mckinsey/vizro`, skills `dashboard-design` and `selecting-vizro-charts` (Apache-2.0): a requirements,
  layout, visualisation workflow, tied to the Vizro library.
- `wshobson/agents`, skills `kpi-dashboard-design` and `grafana-dashboards` (MIT): metric selection by
  department and Grafana panel configuration.
- `mhattingpete/claude-skills-marketplace`, skill `dashboard-creator` (Apache-2.0): HTML and SVG
  building blocks.

What they tend to leave out, and this skill adds: figure definitions and reconciliation to source, sizing
panels from content at the reader's real viewport, static reports, states per panel, and a review order
that puts truth before appearance.

## Where the rules are ours

Sizes and thresholds the literature does not give (text sizes, row heights, chart proportions, the
small-base cut-off, how many categories is too many) are working defaults from practice. Depart from them
when you can say why.

The sources do not always agree, and where they differ this skill takes the stricter line. Microsoft's
guidance accepts gauges for a value against a goal, pies up to about eight categories and a second axis
for measures of very different size; Few and Datawrapper argue against all three. A client whose tool or
house style uses them is not wrong; make sure the reader can still compare what they need to.
