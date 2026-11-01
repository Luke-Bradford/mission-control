# Multi-agent and operations dashboard research

Research for #677, updated 1 November 2026 against the current HUD. This document's October name follows the ticket's requested destination. The [site audit](../superpowers/specs/2026-10-25-site-review.md) applies the findings. The [desktop-density research](2026-11-01-hud-density.md) records measurements and form coverage. This is research, not approval of a redesign or installation of a service.

| Primary source, checked 1 November | Useful pattern | Application to this HUD |
| --- | --- | --- |
| [Grafana dashboard guidance](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/best-practices/) | A dashboard answers a question; comparable views use consistent axes and hierarchical drill-down. | Overview answers where attention is needed now. Telemetry explains resource/cost changes. Audit recommends improvements. These purposes should not become three copies of one long event list. |
| [LangSmith Studio](https://docs.langchain.com/langsmith/studio) | Graph and chat modes serve different investigation tasks; architecture, thread state and execution details have dedicated views. | Keep an operator summary on Agent, with Trace for detailed diagnosis. Setup's loop graph describes the configured workflow; execution history belongs to a run. |
| [Langfuse agent graphs](https://langfuse.com/docs/observability/features/agent-graphs) | Graphs can be inferred from observation nesting and timing. | A graph's edge must say whether it represents communication, a call, file dependency or inferred co-occurrence. Timing alone must not be presented as proven causality. Retain selection and evidence on click. |
| [GitHub workflow monitoring](https://docs.github.com/en/actions/how-tos/monitor-workflows) | Run progress, jobs and steps lead to searchable/downloadable logs. | Show an exact PR head's check and the next action first, then job/review evidence. An older head's report must not look current. |
| [Linear preferences](https://linear.app/docs/account-preferences), [display options](https://linear.app/docs/display-options) | Font preference and view-specific display options are distinct controls. | A density choice should change relevant layout/row spacing predictably; font preference is not a substitute for fixing a mostly empty dock or oversized cards. These docs do not establish an exact base pixel size for Linear's deployed UI. |
| [Grafana table options](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/table/) | Cell-height choices, bounded wrapping, column widths and pagination control table density. | Crew, Accounts and Board need purposeful columns and visible scrolling. A smaller row does not justify an unreadable label or clipped validation text. |
| [Datadog dashboard configuration](https://docs.datadoghq.com/dashboards/configure/), [table widget](https://docs.datadoghq.com/dashboards/widgets/table/) | Density can arrange related widget groups side by side; tables provide context links and explicit unavailable cells. | Use spare desktop width for related decisions, not stretched single-field forms. Keep a route from every aggregate to evidence, and distinguish unknown from zero. |
| [Primer form guidance](https://primer.style/product/ui-patterns/forms/) | Persistent labels, concise captions and explicit required/validation states reduce input effort. | Give setup, pause, account-switch, memory and acceptance forms one shared label/group/button/error contract. Do not rely on disappearing placeholder text. |

These are applications proposed from the sources, not evidence that a vendor layout automatically fits Mission Control. No vendor account was connected and no repo data was sent to one.

## Page-specific patterns worth taking

Overview needs a short intervention list and stable, comparable machine charts. Board needs a lane summary with detailed ticket history one click away. Agent needs identity, current outcome, next move and deliverables before raw logs. Map needs a clear legend for each lens and a selected-file explanation, with links from Overview so it remains discoverable.

Comms needs a readable conversation and a graph whose selection means the same thing across crew, agent, ticket and contact views. FLIGHT needs separate questions for decisions, past actions, current crew and knowledge; its persistent dock should provide useful content for the width it takes. QA needs evidence and an acceptance action on the selected head. Telemetry needs definitions, units, denominators and consistent windows. Audit needs recommendations with coverage and drill-through, as the separate #1185 research and plan now describe.

Setup should retain its dependency order: account, repo/seats, role/guard, loop, source and safety. Progressive disclosure works for infrequent details only if the main action and saved state remain clear. A workflow graph can explain routing while a form edits the relevant settings; a text inventory alone does not make rules configurable.

## Design-stage boundary

The audit records what has improved since the 25 October review and what remains. Existing mockups are references, not blanket approval for new changes. #1193 requires the operator to see this research before its density plan, approve that plan before the mockup, and approve the mockup before build tickets. #1185 has the same separate gates for Audit. No new mockup, product redesign or build ticket is delivered by this research.
