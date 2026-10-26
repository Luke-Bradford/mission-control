# Loops and graphs: what Anthropic says, and what it means for Mission Control

Research note, 26 Oct 2026, for the Setup › Loops redesign. Sources are Anthropic's own sites unless marked.

## What Anthropic says

**The core loop.** Every agent turn is the same cycle: *gather context → take action → verify work → repeat*, then respond ([Agent SDK: how the agent loop works](https://code.claude.com/docs/en/agent-sdk/agent-loop); [Building agents with the Claude Agent SDK](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk)). Agents that can check their own output are "fundamentally more reliable", so give them concrete checks.

**Loops are defined by trigger and stop condition** ([Loop engineering: getting started with loops](https://claude.com/blog/getting-started-with-loops), 30 Jun 2026): "agents repeating cycles of work until a stop condition is met". Four kinds:

| Kind | Starts | Stops | Use when |
|---|---|---|---|
| Turn-based | a prompt | Claude judges it done or needs more context | exploring or deciding |
| Goal-based (`/goal`) | a prompt | goal met (an evaluator checks each time Claude tries to stop) or a turn cap | you know what done looks like |
| Time-based (`/loop`, `/schedule`) | an interval | cancelled or work complete | monitoring outside work, e.g. a PR |
| Proactive | an event or schedule, no human | each task's goal met; routine runs until off | recurring, well-defined work (triage, upgrades) |

Guidance from the same post: "Not all tasks require complex loops"; deterministic exit criteria (test counts, thresholds) work best; caps are explicit ("stop after five tries"); a second agent with **fresh context** reviews code; **model and effort are "among the biggest levers on what a loop costs"**; use scripts for deterministic steps (cheaper than reasoning); match intervals to how often the data changes.

**Verification by structure, not instruction** ([Dynamic workflows cookbook](https://platform.claude.com/cookbook/claude-agent-sdk-08-dynamic-workflows)): "'Double-check your findings' is also just an instruction, and under context pressure it gets skipped." Checks are enforced by control flow: extract → verify (fan-out, one agent per item) → skeptic (an adversarial agent tries to refute each "confirmed") → report. Routing between steps in plain code "costs zero tokens". Workflows are expressed as **phases**; the progress UI groups agents by phase; fan-out (`parallel`) and join (barrier) are explicit; failed stages retry with cached results for the rest.

**Verification loops as skills** ([Building verification loops with skills](https://claude.com/resources/articles/building-verification-loops-in-claude-code-with-skills)): check against deterministic signals (types, lint, tests, runtime errors) plus encoded manual checks; fix what fails before moving on; escalate to a human otherwise. Placement: standalone, embedded in a producing skill, chained, or on every PR.

**Patterns** ([Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)): prompt chaining (fixed steps with programmatic gates), routing (classify, then a specialised path; also route easy work to smaller models), parallelization, orchestrator–workers, evaluator–optimizer (one generates, another critiques, repeat; skip it when first attempts already meet the bar or criteria are subjective). Start simple; add complexity only when it measurably helps. The multi-agent research system is orchestrator–workers with parallel subagents in their own contexts ([How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)).

**Long-running work** ([Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents); [Harness design for long-running apps](https://www.anthropic.com/engineering/harness-design-long-running-apps)): one feature at a time; a progress file and git commits as the hand-off between sessions; planner → generator → evaluator; and harness assumptions go stale as models improve, so revisit them.

**Graphs.** None of these sources draws loops as graphs or gives visual guidance; the docs show one diagram, the three-stage agent loop. Graph views of agent runs come from other tools (LangGraph Studio: nodes traversed with intermediate state; Langfuse agent graph: aggregated vs per-call, cost per step; not Anthropic sources).

## Graph engineering (community, Jul–Aug 2026; not Anthropic)

Sources: [Claude Code Graph Engineering Masterclass](https://newsletter.claudecodemasterclass.com/p/claude-code-graph-engineering-masterclass) (Joe Njenga, 19 Aug), [Graph Engineering with Claude: 14-step roadmap](https://movez.substack.com/p/graph-engineering-with-claude-14) (0xMovez, 25 Jul), [Orchestrate agent teams safely](https://aident.ai/blog/claude-code-graph-engineering-agent-teams) (Todd Mercer, 30 Jul). They build on Anthropic's [agent teams](https://code.claude.com/docs/en/agent-teams) (shared task list with dependencies; experimental) and [dynamic workflows](https://code.claude.com/docs/en/workflows). ([Graph engineering with Claude](https://dzeaulfath.medium.com/graph-engineering-with-claude-d76d7011d848) could not be fetched: 403.)

- **"A loop is a node in a graph."** Loops run inside nodes; the graph routes work between loops. Not every loop should become a graph: use one when the same agent reviews its own work, independent steps run one after another, or control flow can't be audited without reading the transcript.
- **Nodes** do one bounded job (named in five words or fewer) with clean input and a validated, schema-checked output. **Edges** exist only where data moves; plain code does the plumbing ("save agents for judgment, not for plumbing"). **Conditional edges** route at runtime: an agent classifies, code picks the path.
- **Shapes:** fan-out / fan-in (a barrier only where the full set is needed), the diamond (split → work → merge), **verify on the edge** (adversarial skeptic, diverse lenses, judge panel), **converging cycles** (loop until rounds find nothing new), tiered models (cheap for bounded nodes, strong for judgment).
- **Shared state + trace:** one structured state object, each node owns its section and appends to a node trace.
- **Running it:** watch the **graph frontier** (nodes whose prerequisites are done and can start now); start with one lead and two or three workers; give parallel writers disjoint files and their own worktrees; integration owns shared glue; verification owns no feature files and sends failures back to the owner. Failure modes: too many agents, two agents editing one file, a node starting early on a verbal dependency, success claimed without proof, tokens spent without converging.
- **Visual:** boxes and arrows (box = agent call, arrow = data passed), drawn before the first prompt; the `/workflows` view shows progress by phase.

## What it means for our loops

1. **A loop is a config: trigger, steps, stop condition, caps, and model/effort per step.** Our tickets are goal-based loops (the ticket's "Done when" is the goal). FLIGHT's wake is time/event-based. Planner and research work are turn-based. Observed loops are proactive.
2. **Step types matter more than step names.** Three kinds, drawn differently: *agent steps* (cost tokens: explore, plan, build, fix), *deterministic checks* (free: CI, lint, tests, scripts), *fresh-context reviews* (a different agent: RETRO, a skeptic). Cost and reliability come from the mix.
3. **Every loop-back is a stop rule with a cap.** "Rework ≤3", "CI fix ≤5", "re-plan ≤1", then escalate to FLIGHT, then to CAPCOM as a decision with a default. The graph should label each back-edge with its rule and cap.
4. **Triage is routing.** The first step classifies the ticket (bug, feature, small change, docs, research) and can route effort too (smaller model for small changes).
5. **Verification is structural.** "Done when" checks run as deterministic steps; review is a separate agent with fresh context; the agent's own "I checked" is not a gate.
6. **Metrics that follow:** tokens and time per step (where the money goes), loop-backs per run by reason (where quality fails), first-pass rate per step, cap hits and escalations, and agent vs deterministic share of each loop.
7. **Two levels.** A *loop* is how one seat works one ticket (a node). The *graph* is how FLIGHT runs the crew: tickets are nodes, dependencies are edges, the Ready tickets with every prerequisite done are the frontier, seats are workers, RETRO is the verification node, and branch overlap (#667) is the "two agents editing one file" check. The per-repo Activity Map is the natural home for that graph.
8. **Visual direction:** loops as a map of phases (like the workflow progress UI), with step type by shape, back-edges labelled with stop rule and cap, and the same drawing on the Agent page with the current step marked and spend per step.

## Open for the next research pass

Which loop shapes actually perform best on our board (first-pass rate, rework rounds, tokens per merged PR) needs our own data: the hub already records runs, reviews and tokens per run. Measure before tuning.
