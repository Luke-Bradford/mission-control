import {
  type BoardItem,
  type ConfigProfile,
  type ConfigView,
  type Crew,
  type LoopPhase,
  RETRY_NOTE,
  type RunLoopView,
  type RunView,
  SMALL_SIZES,
} from "@mc/core";
import { useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import { ACTIONS, hub, RESOURCES, useResource, useResources } from "../data.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Panel } from "../hud/Panel.tsx";
import { useSessionScope } from "../shell/session.ts";
import { toast } from "../shell/Toast.tsx";
import { TemplateEditor } from "./TemplateEditor.tsx";

function NewTemplate({ onNew }: { onNew?: () => void }) {
  return (
    <button
      type="button"
      className="sm"
      onClick={() => {
        onNew?.();
        toast(
          "New template: name the work type, draw the steps, give each step its checks and a limit, then bind it to a ticket label.",
        );
      }}
    >
      New
    </button>
  );
}

/** What picks a profile: its labels, then what it catches when a ticket carries no template label. */
export function profileTrigger(p: ConfigProfile): string {
  const base =
    p.labels.length > 0
      ? `label ${p.labels.join(" or ")}`
      : "no label: FLIGHT or the planner picks it";
  if (p.name === "small-change") {
    return `${base}, or Size ${SMALL_SIZES.join(" or ")} with no template label`;
  }
  if (p.name === "feature") return `${base}, or any other ticket with no template label`;
  return base;
}

/** Who does a step, by its loop phase. */
export function stepRole(p: ConfigProfile, step: ConfigProfile["steps"][number]): string {
  if (step.role) return step.role;
  switch (step.phase) {
    case "working":
      return "The writer seat";
    case "ci":
      return "Mission Control runs the CI checks";
    case "review":
      return `${p.reviewer.role}, fresh eyes · ${p.reviewer.depth} review`;
    case null:
      return "No loop phase: shown for the record";
  }
}

function stepExtra(p: ConfigProfile, step: ConfigProfile["steps"][number]): string | null {
  if (step.max !== undefined) return `Up to ${step.max} tries.`;
  if (step.phase === "ci") return `Up to ${p.tries} tries.`;
  if (step.phase === "review") return `Up to ${p.rounds || "∞"} rounds.`;
  return null;
}

/** The Templates panel and the picked profile's track (catalogue 2.7.2). */
function Templates({ profiles }: { profiles: NonNullable<ConfigView["profiles"]> }) {
  const [updated, setUpdated] = useState(profiles);
  const [editing, setEditing] = useState(false);
  const newButton = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setUpdated(profiles);
  }, [profiles]);
  const current = updated;
  const [picked, setPicked] = useState<string | null>(null);
  const { inView } = useSessionScope();
  const { data: crew, error: crewError, loading: crewLoading } = useResource<Crew>(RESOURCES.crew);
  const seats = crew?.rows.filter((r) => r.kind === "crew" && inView(r));
  const { list, error } = current;
  const close = () => {
    setEditing(false);
    newButton.current?.querySelector("button")?.focus();
  };
  const p = list.find((x) => x.name === picked) ?? list[0];
  const cards = p
    ? [
        ...p.steps.map((step) => ({
          ...p.nodes?.find((node) => node.name === step.name),
          ...step,
        })),
        ...(p.nodes?.filter((node) => !p.steps.some((step) => step.name === node.name)) ?? []),
      ]
    : [];
  return (
    <>
      <Panel
        title="Templates"
        sub="loops/*.yaml"
        actions={
          <div ref={newButton}>
            <NewTemplate onNew={() => setEditing(true)} />
          </div>
        }
      >
        {editing && (
          <TemplateEditor
            profiles={current}
            onCancel={close}
            onRefresh={async () => {
              const config = await apiGet<ConfigView>(RESOURCES.config.path);
              if (!config.profiles || config.profiles.error)
                throw new Error(config.profiles?.error ?? "Templates unavailable");
              setUpdated(config.profiles);
              return config.profiles;
            }}
            onSave={async (profile, base) => {
              const saved = await apiPost<NonNullable<ConfigView["profiles"]>>(
                ACTIONS.createProfile,
                {
                  base,
                  profile,
                },
              );
              setUpdated(saved);
              setPicked(profile.name);
              hub.refetch(RESOURCES.config.path);
              close();
            }}
          />
        )}
        {crewError && (
          <p className="pb s" role="status">
            Running counts unavailable: {crewError.message}
          </p>
        )}
        {crewLoading && !crew && <p className="pb s">Loading running counts…</p>}
        {error !== null ? (
          <p className="pb s">{`Could not read the template profiles: ${error}`}</p>
        ) : list.length === 0 ? (
          <p className="pb s muted">No template profiles.</p>
        ) : (
          <ul className="pb tlist loop-templates">
            {list.map((x) => (
              <li key={x.name}>
                <button
                  type="button"
                  aria-pressed={x.name === p?.name}
                  onClick={() => setPicked(x.name)}
                >
                  {`${x.name} · ${x.trigger ?? profileTrigger(x)} · ${seats?.filter((r) => r.loop?.profile === x.name && r.hudState === "running").length ?? "—"} running · ${x.steps.length} steps`}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {p !== undefined && (
        <Panel title={p.name} sub={`runs for: ${p.trigger ?? profileTrigger(p)}`}>
          <ol className="ptrack" aria-label="Steps">
            {p.steps.map((s, i) => (
              <li key={s.name} className={s.gate ? "gate" : undefined}>
                <b>{i + 1}</b> {s.name}
                {s.retry && <span className="tchip">↻ {s.retry}</span>}
              </li>
            ))}
          </ol>
          <div className="pb">
            <p className="s">
              {`Up to ${p.rounds || "∞"} rounds${p.planRequired ? " · Plan required before a developer starts" : ""}`}
            </p>
            <p className="s">
              Token budget{" "}
              {p.budget == null ? "—" : p.budget >= 1000 ? `${p.budget / 1000}k` : p.budget}
            </p>
            <p className="xs muted">{RETRY_NOTE}</p>
          </div>
          <div className="pcards">
            {cards.map((s, i) => (
              <div key={s.name} className={`pcard${s.gate ? " gate" : ""}`}>
                <b>{`${i + 1} · ${s.name}`}</b>
                {s.gate && <span className="tchip">gate</span>}
                {i >= p.steps.length && <span className="xs muted">Not on path</span>}
                <div className="row wrap">
                  <span className="xs muted">on this step</span>
                  {seats
                    ?.filter(
                      (r) =>
                        r.loop?.profile === p.name &&
                        r.loop.step === s.name &&
                        r.hudState !== "idle" &&
                        r.hudState !== "stopped",
                    )
                    .map((r) => (
                      <AgentTag key={r.id} id={r.id} index={r.index} sm bare />
                    ))}
                </div>
                <span className="s">{stepRole(p, s)}</span>
                {s.checks?.map((check) => (
                  <div className="s" key={`${check.kind}-${check.text}`}>
                    <span className="tchip">{check.kind}</span> {check.text}
                  </div>
                ))}
                {s.retry && <span className="s">↻ {s.retry}</span>}
                {stepExtra(p, s) !== null && <span className="s">{stepExtra(p, s)}</span>}
              </div>
            ))}
          </div>
        </Panel>
      )}
      <p className="pb note">{TEMPLATES_NOTE}</p>
    </>
  );
}

const NO_PROFILES = "This server reads no template profiles.";
const NO_OBSERVED_LOOPS = "No observed loops.";

const TEMPLATES_NOTE =
  "Mission Control decides every move from its own checks; an agent saying it is done can only hold work back, never push it forward. cmd = Mission Control runs it · rule = read from the diff or the board · review = a fresh reviewer · gate = you or FLIGHT · agent = the agent's own evidence.";

type ChainStep = {
  name: string;
  runner: string;
  gate: string;
  failure: string;
  cap: string;
  atCap: string;
  conditional?: string;
  command: string;
  prompt: string | null;
};

// Temporary display source until the loop-config API supplies this same shape.
const TODAY_CHAIN: readonly ChainStep[] = [
  {
    name: "Plan",
    runner: "Planner seat (FAO)",
    gate: "has a ## Plan",
    failure: "Plan again; a missing decision asks CAPCOM with a default",
    cap: "—",
    atCap: "—",
    conditional: "Size M+ unless planRequired is false",
    command: "gpt-5.6-sol · high",
    prompt: "Turn {ticket} into a plan a developer can build from the ticket alone.",
  },
  {
    name: "Build",
    runner: "Developer seat",
    gate: "evidence reported",
    failure: "Stays in Build until evidence is reported",
    cap: "turn and time limits",
    atCap: "FLIGHT",
    command: "gpt-5.6-terra · medium",
    prompt: "Implement {plan} for {ticket}; test first, then report evidence.",
  },
  {
    name: "CI checks",
    runner: "GitHub Actions",
    gate: "all checks green",
    failure: "Back to Build: CI failed, fix it",
    cap: "3 tries",
    atCap: "Parked for FLIGHT",
    command: "lint · typecheck · test · build",
    prompt: null,
  },
  {
    name: "Review",
    runner: "RETRO · fresh seat",
    gate: "approved",
    failure: "Back to Build with findings",
    cap: "3 rounds",
    atCap: "Parked for FLIGHT",
    command: "retro-cx · gpt-5.6-sol · high",
    prompt: "Review {diff} against {done_when}; approve or give exact findings.",
  },
  {
    name: "Merge",
    runner: "Hub engine",
    gate: "mergeable",
    failure: "Parks for FLIGHT; sync then returns to CI checks or Build",
    cap: "—",
    atCap: "FLIGHT",
    command: "hard-rule clearance",
    prompt: null,
  },
  {
    name: "Done",
    runner: "Board → Done",
    gate: "merged",
    failure: "—",
    cap: "—",
    atCap: "—",
    command: "ticket closed",
    prompt: null,
  },
];

const CHAIN_INDEX: Record<LoopPhase, number> = {
  working: 1,
  ci: 2,
  review: 3,
  parked: 4,
  done: 5,
};

const returnUses = (view: RunLoopView | undefined, step: "ci" | "review") => {
  const attempts = view?.tries.filter((attempt) => attempt.step === step) ?? [];
  if (step === "ci") return attempts.at(-1)?.failures ?? 0;
  return attempts.filter((attempt) => attempt.fix).length;
};

function LoopChain({ config }: { config: ConfigView }) {
  const [selected, setSelected] = useState(2);
  const [runId, setRunId] = useState("");
  const [withRun, setWithRun] = useState(false);
  const seatDefs = config.crew?.sessions.flatMap((session) => session.seats) ?? [];
  const { data: crew } = useResource<Crew>(RESOURCES.crew);
  const runs = useResources<RunView[]>(seatDefs.map((seat) => RESOURCES.runs(seat.id)));
  const boards = useResources<BoardItem[]>(config.repos.map((repo) => RESOURCES.boards(repo.id)));
  const openTickets = new Map(
    boards
      .flatMap((board) => board.data ?? [])
      .filter((ticket) => !ticket.closed && ticket.state !== "done")
      .map((ticket) => [`${ticket.repoId}#${ticket.issueNumber}`, ticket]),
  );
  const ticketRuns = runs
    .flatMap((resource) => resource.data ?? [])
    .flatMap((run) => {
      if (run.ticket === null || run.loop === null || run.loop === undefined) return [];
      const ticket = openTickets.get(run.ticket);
      return ticket ? [{ run, title: ticket.title }] : [];
    })
    .sort((a, b) => b.run.startedAt - a.run.startedAt)
    .filter(
      ({ run }, index, all) =>
        all.findIndex(({ run: other }) => other.ticket === run.ticket) === index,
    );
  const picked = ticketRuns.find(({ run }) => run.id === runId) ?? null;
  const showRun = withRun && picked !== null;
  const runLoop = useResource<RunLoopView>(picked ? RESOURCES.runLoop(picked.run.id) : null);
  const runProfile = picked?.run.profile?.profile;
  const profile =
    runProfile ?? config.profiles?.list.find((candidate) => candidate.name === "feature") ?? null;
  const triesLimit = profile?.tries ?? 3;
  const reviewLimit = profile?.rounds ?? 3;
  const currentTry = runLoop.data?.tries.at(-1);
  const phase = runLoop.data?.loop?.phase ?? currentTry?.step ?? null;
  const nowIndex = phase === null || phase === "parked" ? null : CHAIN_INDEX[phase];
  const ciUses = returnUses(runLoop.data, "ci");
  const reviewUses = returnUses(runLoop.data, "review");
  const session = picked
    ? config.crew?.sessions.find((candidate) => candidate.repoId === picked.run.repoId)
    : undefined;
  const seatForRole = (role: string) =>
    session?.seats.find((seat) => seat.role.toLowerCase() === role.toLowerCase()) ?? null;
  const modelForRole = (role: string) =>
    seatForRole(role)?.model ??
    config.crew?.roles?.find((candidate) => candidate.name.toLowerCase() === role.toLowerCase())
      ?.model ??
    null;
  const effortForSeat = (id: string | undefined) =>
    crew?.rows.find((candidate) => candidate.id === id)?.cli.effort;
  const modelText = (model: string | null, effort: string | null | undefined) =>
    model ? `${model}${effort ? ` · ${effort}` : ""}` : "No configured model applies.";
  const modelFor = (stepName: ChainStep["name"]) => {
    if (stepName === "Build") {
      const seat = seatDefs.find((candidate) => candidate.id === picked?.run.agentId);
      const effort = effortForSeat(seat?.id);
      return modelText(seat?.model ?? modelForRole("INCO"), effort);
    }
    if (stepName === "Plan") {
      const planner = seatForRole("FAO") ?? seatForRole("planner");
      return modelText(
        planner?.model ?? modelForRole("FAO") ?? modelForRole("planner"),
        effortForSeat(planner?.id),
      );
    }
    if (stepName === "Review") {
      const role = profile?.reviewer.role ?? "RETRO";
      const seat = seatForRole(role);
      return modelText(modelForRole(role), effortForSeat(seat?.id));
    }
    if (stepName === "CI checks") return "No configured model applies.";
    return "No configured model applies.";
  };
  const step = TODAY_CHAIN[selected] ?? TODAY_CHAIN[0];
  return (
    <>
      <Panel
        title="Feature loop chain"
        sub="fixed today; loop config API will replace this source"
        actions={
          <fieldset className="loop-show" aria-label="Loop display">
            <label className="sr-only" htmlFor="loop-run-picker">
              Ticket with run
            </label>
            <select
              id="loop-run-picker"
              aria-label="Ticket with run"
              value={runId}
              onChange={(event) => {
                setRunId(event.target.value);
                setWithRun(event.target.value !== "");
              }}
            >
              <option value="">Pick an open ticket</option>
              {ticketRuns.map(({ run, title }) => (
                <option key={run.id} value={run.id}>{`${run.ticket} · ${title}`}</option>
              ))}
            </select>
            <button type="button" aria-pressed={!showRun} onClick={() => setWithRun(false)}>
              Loop only
            </button>
            <button
              type="button"
              aria-pressed={showRun}
              disabled={!picked}
              onClick={() => setWithRun(true)}
            >
              With run
            </button>
          </fieldset>
        }
      >
        <div className="loop-chain-scroll">
          <section className="loop-chain" aria-label="Approved loop chain">
            <svg className="loop-routes" viewBox="0 0 1280 320" aria-label="Return routes">
              <defs>
                <marker
                  id="loop-arrow"
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto"
                >
                  <path d="M0,0L8,4L0,8Z" />
                </marker>
              </defs>
              <path
                className={`loop-route ci-return${showRun ? " active" : ""}`}
                aria-label="CI checks returns to Build"
                d="M 510 108 V 150 H 330 V 108"
                markerEnd="url(#loop-arrow)"
              />
              <path
                className={`loop-route review-return${showRun ? " active" : ""}`}
                aria-label="Review returns to Build"
                d="M 714 108 V 198 H 300 V 108"
                markerEnd="url(#loop-arrow)"
              />
              <path
                className="loop-route conflict-route"
                aria-label="Merge conflict parks for FLIGHT"
                d="M 918 108 V 248 H 1110"
                markerEnd="url(#loop-arrow)"
              />
              <path
                className="loop-route flight-return"
                aria-label="FLIGHT sync returns to CI checks"
                d="M 1110 248 H 1040 V 228 H 510 V 108"
                markerEnd="url(#loop-arrow)"
              />
              <path
                className="loop-route flight-return"
                aria-label="FLIGHT sync returns to Build"
                d="M 1110 248 H 1040 V 276 H 300 V 108"
                markerEnd="url(#loop-arrow)"
              />
            </svg>
            {TODAY_CHAIN.map((item, index) => (
              <button
                key={item.name}
                type="button"
                className={`loop-chain-step${index === selected ? " selected" : ""}${showRun && index === nowIndex ? " now" : ""}`}
                onClick={() => setSelected(index)}
                aria-pressed={index === selected}
                aria-label={`${item.name}: gate: ${item.gate}`}
              >
                <b>{item.name}</b>
                <span>{item.runner}</span>
                <small>gate: {item.gate}</small>
              </button>
            ))}
            <span className="loop-route-label ci-label">
              CI fail ≤{triesLimit}
              {showRun ? ` · used ${ciUses}/${triesLimit}` : ""}
            </span>
            <span className="loop-route-label review-label">
              changes ≤{reviewLimit}
              {showRun ? ` · used ${reviewUses}/${reviewLimit}` : ""}
            </span>
            <div className="loop-flight">
              <b>FLIGHT at cap</b>
              <span>re-plan · reassign · split</span>
              <span>or ask CAPCOM (default)</span>
              <small>sync → CI checks or Build</small>
            </div>
          </section>
        </div>
      </Panel>
      <div className="loop-details">
        <Panel title="Step inspector" sub={`${step.name} step`}>
          <dl className="loop-inspector">
            <dt>Who runs it</dt>
            <dd>{step.runner}</dd>
            <dt>Gate to move on</dt>
            <dd>{step.gate}</dd>
            <dt>If it fails</dt>
            <dd>{step.failure}</dd>
            <dt>Cap</dt>
            <dd>{step.cap}</dd>
            <dt>At the cap</dt>
            <dd>{step.atCap}</dd>
            {step.conditional && (
              <>
                <dt>Conditional</dt>
                <dd>{step.conditional}</dd>
              </>
            )}
            <dt>Model / command</dt>
            <dd>
              <code>{modelFor(step.name)}</code>
            </dd>
            <dt>Step prompt</dt>
            <dd>{step.prompt ?? "No prompt: no agent runs this step."}</dd>
          </dl>
        </Panel>
        {!picked && (
          <p className="pb s muted">
            {runs.some((resource) => resource.loading) ||
            boards.some((resource) => resource.loading)
              ? "Loading open tickets with runs…"
              : ticketRuns.length > 0
                ? "Pick an open ticket with a run to show its overlay."
                : "No open tickets with runs to show."}
          </p>
        )}
        {showRun && picked && (
          <Panel title="Run overlay" sub="chosen ticket">
            <div className="loop-run">
              <b>{`Ticket #${picked.run.ticket?.split("#")[1]} · ${picked.title}`}</b>
              <span>{`Now: ${phase === "parked" ? "Parked" : phase ? TODAY_CHAIN[CHAIN_INDEX[phase]]?.name : "No recorded step"}${currentTry ? ` · try ${currentTry.n} of ${currentTry.step === "ci" ? triesLimit : currentTry.step === "review" ? reviewLimit : triesLimit}` : ""}`}</span>
              <span>{`CI failure → Build · ${ciUses} of ${triesLimit}`}</span>
              <span>{`Review findings → Build · ${reviewUses} of ${reviewLimit}`}</span>
            </div>
          </Panel>
        )}
      </div>
    </>
  );
}

/** Setup › Loops (catalogue 2.7.2), the observed loops, and the template profiles. */
export function Loops({ config }: { config: ConfigView }) {
  const { inRepo } = useSessionScope(config);
  const loops = config.loops.filter((l) => inRepo(l.repoId));
  return (
    <>
      <Panel title="Observed loops" sub="read from config.yaml">
        {loops.length === 0 ? (
          <p className="pb muted s">{NO_OBSERVED_LOOPS}</p>
        ) : (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Loop</th>
                  <th>Kind</th>
                  <th>Repo</th>
                  <th>Account</th>
                  <th>launchd label</th>
                  <th>Worktree</th>
                </tr>
              </thead>
              <tbody>
                {loops.map((l) => (
                  <tr key={l.id}>
                    <td>{l.id}</td>
                    <td>{l.kind}</td>
                    <td>{l.repoId}</td>
                    <td>{l.accountId}</td>
                    <td className="mono">{l.launchdLabel}</td>
                    <td className="mono">{l.worktree}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <LoopChain config={config} />
      {config.profiles === undefined ? (
        <Panel title="Templates" sub="loops/*.yaml" actions={<NewTemplate />}>
          <div className="pb">
            <p className="s">{NO_PROFILES}</p>
            <p className="xs muted">{RETRY_NOTE}</p>
            <p className="note">{TEMPLATES_NOTE}</p>
          </div>
        </Panel>
      ) : (
        <Templates profiles={config.profiles} />
      )}
    </>
  );
}
