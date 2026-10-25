# Multi-agent dashboards: patterns for Mission Control

Research for #677, 25 October 2026. Desk research of public primary documentation, checked during this task; no accounts, product trials or local hub data accessed. These are design comparisons, not claims about installed integrations. The recommendations below are our interpretation of the sources.

## Comparable systems

| System and source | What it shows and how it organises it | Pattern to take | Limit for this hub |
| --- | --- | --- | --- |
| [LangSmith observability concepts](https://docs.langchain.com/langsmith/observability-concepts) | Runs are units of work, nested into traces; threads group turns. A trajectory presents messages in order without the execution nesting. | Separate a readable conversation from tool execution detail; keep links between both. | A conversation alone cannot explain time spent waiting for a lock. Keep the timed run view. |
| [Langfuse sessions](https://langfuse.com/docs/observability/features/sessions) | Groups traces into a replayable interaction with human annotations. | Preserve context across turns and give every conversation a stable scope. | A tracing session is not necessarily a Mission Control session, which the current code defines as a repo and its agents. Do not import terminology blindly. |
| [Grafana dashboard best practices](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/best-practices/) | Recommends question-led dashboards, hierarchical drill-down, comparable units, documented panels and resource utilisation/saturation/error signals. | Overview answers “what needs me?”; Telemetry explains why. Use common axes and label every scope. | Avoid a wall of metrics, mixed-unit overlays and unlabelled stacked charts. |
| [Argo Workflows DAG](https://argo-workflows.readthedocs.io/en/latest/walk-through/dag/) | Dependencies express execution order and parallel branches; complex workflows can be decomposed. | Draw steps and decisions spatially, with named edges and an adjacent inspector. | Mission Control loops contain retry cycles; they are not DAGs. Show bounded return edges explicitly rather than claiming Argo's execution semantics. |

## Page-by-page recommendations

| Page | Operator's question | Pattern worth taking | Proposed treatment |
| --- | --- | --- | --- |
| Overview | Who is working, stuck or waiting for me? | Grafana hierarchy and comparable axes | Compact crew table, aligned machine small multiples, interval timeline, minimal Pipeline lanes leading to Board. |
| FLIGHT | What decision should I make next, and why? | LangSmith ordered narrative with detail links | Asked of you first; catch-up, recommendation and source together. Brief, watch list, drafts and decision history below. |
| Board | What work is available and where does it stand? | Grafana overview-to-detail hierarchy | Lanes retain work identity and ownership; selected ticket inspector carries evidence and checks. This application is an inference, not a claim that Grafana supplies a kanban board. |
| Agent | Why is this run behaving this way? | LangSmith trace versus trajectory | Short state word plus reason, readable transcript beside run attempts and checks. |
| Comms | What are agents saying, and who owes a reply? | LangSmith trajectories; Langfuse interaction grouping | Use the already selected local layout A: Needs you, rooms and direct chats, conversation, context. Agent chatter has sender, recipient, time and delivery state. |
| Telemetry | Can I trust this value, and what changed? | Grafana unit consistency and panel documentation | Expose range, scope, units, denominator, source and missing values. Keep estimates visibly approximate. |
| Activity map | Where are agents touching this repo now? | Argo dependency context; trace-to-evidence drill-down | Follow the existing map design, with a labelled graph and a file inspector; graph marks link to actual activity. Static review view only here. |
| Sessions | Can I change the crew safely? | Progressive detail from observability inspectors | Agent roster with one edit form and a visible pending-change summary. Existing add/edit/remove semantics stay. |
| Repos | What work can this repo supply? | Grafana explicit scope | Add/preview flow captures labels, priority order, assignee and milestone; preview matching and excluded work before saving. |
| Loops | What happens next, especially on failure? | Argo dependency graph | Small versus larger fix branch, labelled pass/fail edges, bounded re-loop and park outcome. |
| Accounts | Which capacity is usable? | Grafana comparable units | One bounded quota track per window; numeric percentage, reset and reading freshness beside it. |
| Roles | Who may do what? | Inspector beside overview | Select a role, edit proposed defaults and preview affected agents; distinguish configurable defaults from enforced permissions. |
| Guards | Which limits apply, and which can I configure? | Grafana documented signals | Locked hard stops plus a proposed repo policy editor and test-lock settings. Configurability needs a separately scoped build decision. |
| Sources | Which readers are healthy? | Grafana resource/error signals | Last success, refresh, scope and explicit unavailable states per source. |
| Access and notifications | Will I hear about something that needs me? | Grafana actionable alert hierarchy | Existing notification controls, quiet hours and a sample notification; device access remains informational, with no sign-in UI. |

The Setup recommendations apply the overview/inspector pattern; the sources do not demonstrate Mission Control configuration APIs. These are interface proposals, not proof that writes are supported.

## Design decisions for review

Reuse the HUD tokens, compact type hierarchy, tabular numbers and word-plus-colour state indicators (catalogue §1.5). Keep agent identity colours beside call signs. Prefer rectangular duration spans to decorative sparklines for the Timeline; retain sparklines only for sampled numeric data. A stopped refresh leaves a dated last reading, never an apparently live zero.

Keep the existing [team-chat layout decision](../superpowers/specs/2026-10-24-agent-comms-design.md) and [Activity map specification](../superpowers/specs/2026-10-23-crew-activity-map-design.md) as the local authorities. External products inform presentation, not permission changes, dependencies or a new architecture.

See the [page audit and review queue](../superpowers/specs/2026-10-25-site-review.md). Operator approval, current screenshots and build tickets remain separate steps.
