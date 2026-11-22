import {
  BUILTIN_ROLES,
  type ConfigView,
  GUARD_NOTE,
  GUARD_RULES,
  GUARD_WINDOW_DAYS,
  type GuardHitsView,
  type GuardRule,
  LOCK_WAIT_MS,
  type RepoRulesView,
  ROLES,
  type RoleRow,
} from "@mc/core";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { LockLines, useTestLock } from "../components/LockLines.tsx";
import { useSeatName } from "../crew.ts";
import { RESOURCES, streamStatus, useResource } from "../data.ts";
import { Panel } from "../hud/Panel.tsx";
import { editSeatPath, setupPath } from "../router.ts";
import { useSessionScope } from "../shell/session.ts";
import { useStore } from "../shell/store.ts";
import {
  AUTHORITY_NOTE,
  EDIT_SOON,
  READ_ONLY_RULES,
  REPO_FILE_WINS,
  RULE_GROUPS,
  type RuleKey,
  type RuleSource,
  ruleChips,
  SOURCE_TEXT,
} from "./repoRules.ts";
import { ROLE_HEADINGS } from "./roleHeadings.ts";
import "./roles.css";

const GUARD_IDS = Object.keys(GUARD_RULES) as GuardRule[];
/** Chips a list shows before `+n`. */
const CHIPS_SHOWN = 4;

export const SEATS_RULE_LINE =
  "Repo rules are the backstop. A seat's file area narrows what that seat may write; it never overrides a repo rule.";
export const DISCONNECTED_NOTE = "Not connected to the hub. These figures are from the last read.";
const PLANNED_HINT = "Roles in the plan that have no prompt file yet.";

const modeText = (mode: RoleRow["mode"]): string =>
  mode === "writer" ? "Writes code" : mode === "read-only" ? "Read only" : "—";

/** The roles with a prompt file, FLIGHT first, then by call sign. */
const BUILT: RoleRow[] = ROLES.filter((r) => BUILTIN_ROLES[r.callSign] !== undefined).sort(
  (a, b) =>
    a.callSign === "FLIGHT"
      ? -1
      : b.callSign === "FLIGHT"
        ? 1
        : a.callSign.localeCompare(b.callSign),
);
const PLANNED: RoleRow[] = ROLES.filter(
  (r) => BUILTIN_ROLES[r.callSign] === undefined && r.callSign !== "CAPCOM",
);

function SourceBadge({ rule, source }: { rule: RuleKey; source: RuleSource }) {
  const text = SOURCE_TEXT[source];
  const label = source === "repo-file" && rule === "pick_from" ? REPO_FILE_WINS : text.label;
  return (
    <span className={`rg-src ${source}`} title={text.hint}>
      {label}
    </span>
  );
}

/** What a dashed chip means, in words. */
const REPO_ADDED = "added by the repo file";

/**
 * One value. A chip its column cuts short is a button: pressing it shows the whole value, so a
 * long path or command can be read in full from the keyboard.
 */
function Chip({ value, repo }: { value: string; repo: boolean }) {
  const text = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  const [open, setOpen] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new value, and the swap between plain text and button, each put a new element on screen to measure.
  useLayoutEffect(() => {
    const el = text.current;
    // an open chip wraps, so it measures as fitting: it keeps its button until it is closed
    if (!el || open) return;
    let live = true;
    const measure = () => {
      if (live) setCut(el.scrollWidth > el.clientWidth + 1);
    };
    measure();
    void document.fonts?.ready.then(measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => {
      live = false;
      observer?.disconnect();
    };
  }, [value, cut, open]);
  const className = `rg-chip${repo ? " repo" : ""}${open ? " open" : ""}`;
  const title = repo ? `${value} · ${REPO_ADDED}` : value;
  const body = (
    <>
      <span ref={text}>{value}</span>
      {repo && <span className="sr-only">, {REPO_ADDED}</span>}
    </>
  );
  return cut || open ? (
    <button
      type="button"
      className={className}
      title={title}
      aria-expanded={open}
      onClick={() => setOpen(!open)}
    >
      {body}
    </button>
  ) : (
    <span className={className} title={title}>
      {body}
    </span>
  );
}

function Chips({ id, values, adds }: { id: string; values: string[]; adds: string[] }) {
  const [open, setOpen] = useState(false);
  const all = [...values.map((v) => ({ v, repo: false })), ...adds.map((v) => ({ v, repo: true }))];
  if (all.length === 0) return <span className="rg-none">None set</span>;
  const shown = open ? all : all.slice(0, CHIPS_SHOWN);
  return (
    <>
      {shown.map(({ v, repo }) => (
        <Chip key={`${repo ? "r" : "u"}:${v}`} value={v} repo={repo} />
      ))}
      {all.length > CHIPS_SHOWN && (
        <button
          type="button"
          className="rg-more"
          aria-expanded={open}
          aria-label={`${open ? "Show fewer" : "Show all"} ${id}`}
          onClick={() => setOpen(!open)}
        >
          {open ? "Show fewer" : `+${all.length - CHIPS_SHOWN}`}
        </button>
      )}
    </>
  );
}

function RuleRow({ rule, label, view }: { rule: RuleKey; label: string; view: RepoRulesView }) {
  const v = view.rules[rule];
  const readOnly = READ_ONLY_RULES.has(rule);
  const editable = !readOnly && (v.source === "set-here" || v.source === "default");
  return (
    <div className="rg-row" data-key={rule} data-source={v.source}>
      <div className="rg-name">
        <span className="mono">{rule}</span>
        <small>{label}</small>
      </div>
      <div className="rg-chips">
        <Chips id={rule} values={ruleChips(view, rule)} adds={v.repoAdds ?? []} />
        {readOnly && <span className="rg-reason">{AUTHORITY_NOTE}</span>}
      </div>
      <div>
        <SourceBadge rule={rule} source={v.source} />
      </div>
      <div>
        {editable && (
          <button type="button" disabled title={EDIT_SOON} aria-label={`Edit ${rule}`}>
            Edit
          </button>
        )}
      </div>
    </div>
  );
}

function LockRow() {
  const lock = useTestLock();
  return (
    <div className="rg-row rg-lock" data-key="test-lock" data-source="built-in">
      <div className="rg-name">
        <span className="mono">test lock</span>
        <small>One full suite at a time</small>
      </div>
      <div className="rg-lockbody">
        <p className="note">
          One full suite at a time across the machine; others wait in line, oldest first. A
          full-suite command an agent types is held in the same line and runs when it reaches the
          front; after about {LOCK_WAIT_MS / 60_000} minutes it is told to retry later or run a
          single file. Max at once: <b>1</b>. Single-file runs go straight through.
        </p>
        <LockLines lock={lock} />
      </div>
      <div>
        <span className="rg-src built-in" title={SOURCE_TEXT["built-in"].hint}>
          {SOURCE_TEXT["built-in"].label}
        </span>
      </div>
      <div />
    </div>
  );
}

function RepoRules({ config }: { config: ConfigView }) {
  const { repo: scoped } = useSessionScope(config);
  const picker = useId();
  const [chosen, setChosen] = useState<string | null>(null);
  const repoId =
    chosen ??
    (config.repos.some((r) => r.id === scoped) ? (scoped as string) : config.repos[0]?.id);
  const rules = useResource<RepoRulesView>(repoId ? RESOURCES.repoRules(repoId) : null);
  if (!repoId)
    return (
      <Panel id="rg-rules" title="Repo rules" sub="No repo">
        <div className="pb">
          <p className="muted s">Add a repo to see its rules.</p>
        </div>
      </Panel>
    );
  const sub = rules.data
    ? `${repoId} · ${rules.data.repoFileError ? "repo file not read" : "repo file read"}`
    : repoId;
  return (
    <Panel
      id="rg-rules"
      title="Repo rules"
      sub={sub}
      actions={
        config.repos.length > 1 ? (
          <label className="rg-picker" htmlFor={picker}>
            Repo
            <select id={picker} value={repoId} onChange={(e) => setChosen(e.target.value)}>
              {config.repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id}
                </option>
              ))}
            </select>
          </label>
        ) : undefined
      }
    >
      {rules.error && !rules.data ? (
        <div className="pb">
          <p className="note err" role="alert">
            Rules did not load. {rules.error.message}
          </p>
        </div>
      ) : !rules.data ? (
        <div className="pb">
          <p className="muted s">Reading the repo's rules…</p>
        </div>
      ) : (
        <>
          {rules.error && (
            <div className="pb">
              <p className="note warn" role="status">
                Showing the last rules read. Refreshing them failed: {rules.error.message}
              </p>
            </div>
          )}
          {rules.data.repoFileError && (
            <div className="pb">
              <p className="note warn" role="status">
                The repo file's rules are not shown. {rules.data.repoFileError}
              </p>
            </div>
          )}
          {RULE_GROUPS.map((g) => (
            <div className="rg-group" key={g.title}>
              <h3>{g.title}</h3>
              {g.rules.map((r) => (
                <RuleRow
                  key={r.key}
                  rule={r.key}
                  label={r.label}
                  view={rules.data as RepoRulesView}
                />
              ))}
              {g.title === "Checks" && <LockRow />}
            </div>
          ))}
        </>
      )}
    </Panel>
  );
}

function Guard({ hits }: { hits: GuardHitsView | undefined }) {
  const none = hits !== undefined && GUARD_IDS.every((r) => hits.counts[r] === 0);
  return (
    <Panel
      id="rg-guard"
      title="Built-in guard"
      sub={`Hard stops in code · refusals in the last ${GUARD_WINDOW_DAYS} days`}
    >
      {none && (
        <div className="pb">
          <p>No refusals in the last {GUARD_WINDOW_DAYS} days.</p>
        </div>
      )}
      {GUARD_IDS.map((r) => (
        <div className="rg-guard-row" key={r} data-rule={r}>
          <span className="rg-rule">{GUARD_RULES[r]}</span>
          <span className="rg-count">
            {hits ? hits.counts[r] : "—"}
            <span className="sr-only"> refusals{hits ? "" : ", unknown"}</span>
          </span>
        </div>
      ))}
      <div className="pb">
        <p className="s muted">{GUARD_NOTE}</p>
      </div>
    </Panel>
  );
}

type SeatRow = { sessionId: string; id: string; area: string; retiring: boolean };

function seatsOf(config: ConfigView, role: string): SeatRow[] {
  return (config.crew?.sessions ?? []).flatMap((s) =>
    s.seats
      .filter((x) => x.role === role)
      .map((x) => ({
        sessionId: s.id,
        id: x.id,
        area:
          x.mode === "scratch"
            ? "scratch review"
            : x.mode !== "writer"
              ? "read-only"
              : x.area.length > 0
                ? x.area.join(", ")
                : "whole checkout",
        retiring: x.retiring === true,
      })),
  );
}

/** The drawer: the headings of one role's prompt file. Focus stays inside; Escape closes. */
function PromptDrawer({ role, onClose }: { role: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const title = useId();
  useEffect(() => close.current?.focus(), []);
  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Tab") {
      const f = [...(ref.current?.querySelectorAll<HTMLElement>("button, a[href]") ?? [])];
      const first = f[0];
      const last = f[f.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }
  return (
    <div
      ref={ref}
      className="rg-drawer"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title}
      onKeyDown={onKey}
    >
      <div className="rg-drawer-head">
        <h2 id={title}>{role} prompt</h2>
        <button type="button" ref={close} onClick={onClose}>
          Close
        </button>
      </div>
      <p className="s muted">
        <span className="mono">roles/{role}.md</span> · read only
      </p>
      <ul>
        {(ROLE_HEADINGS[role] ?? []).map((h) => (
          <li key={h}>{h}</li>
        ))}
      </ul>
    </div>
  );
}

/** `config` undefined: the seats are not known yet (`error` says a read failed), never "none". */
function RolesTable({ config, error }: { config: ConfigView | undefined; error: Error | null }) {
  const nameOf = useSeatName();
  const [prompt, setPrompt] = useState<{ role: string; from: HTMLElement } | null>(null);
  function closePrompt() {
    prompt?.from.focus();
    setPrompt(null);
  }
  return (
    <Panel id="rg-roles" title="Roles" sub="roles/*.md · five have a prompt file">
      <p className="rg-line s">{SEATS_RULE_LINE}</p>
      {!config && error && (
        <div className="pb">
          <p className="note err" role="alert">
            Seats did not load. {error.message}
          </p>
        </div>
      )}
      <div className="tw">
        <table className="rg-table">
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col">Purpose</th>
              <th scope="col">Mode</th>
              <th scope="col">Seats</th>
              <th scope="col">Seat file areas</th>
              <th scope="col">Prompt</th>
            </tr>
          </thead>
          <tbody>
            {BUILT.map((r) => {
              const seats = config ? seatsOf(config, r.callSign) : null;
              return (
                <tr key={r.callSign} data-role={r.callSign}>
                  <td>
                    <b>{r.callSign}</b>
                    <br />
                    <small>{r.position}</small>
                  </td>
                  <td className="rg-purpose">{r.here}</td>
                  <td>{modeText(r.mode)}</td>
                  <td className="rg-mid">
                    {seats ? (
                      <a href={setupPath("repos")}>
                        {seats.length} seat{seats.length === 1 ? "" : "s"}
                      </a>
                    ) : (
                      <>
                        —<span className="sr-only"> seats, unknown</span>
                      </>
                    )}
                  </td>
                  <td>
                    {!seats ? (
                      error ? (
                        <span className="rg-none">
                          —<span className="sr-only"> unknown</span>
                        </span>
                      ) : (
                        <span className="rg-none">Reading seats…</span>
                      )
                    ) : seats.length === 0 ? (
                      <span className="rg-none">No seats</span>
                    ) : (
                      <ul className="rg-seats">
                        {seats.map((s) => (
                          <li key={`${s.sessionId}:${s.id}`}>
                            <span className="mono" title={`s/${s.sessionId}`}>
                              {nameOf(s.id)}: {s.area}
                              {s.retiring ? " · retiring" : ""}
                            </span>
                            <a
                              href={editSeatPath(s.sessionId, s.id)}
                              aria-label={`Edit ${nameOf(s.id)} on Repos & seats`}
                            >
                              Edit
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="rg-mid">
                    <button
                      type="button"
                      onClick={(e) => setPrompt({ role: r.callSign, from: e.currentTarget })}
                    >
                      Read prompt
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <details className="rg-planned">
        <summary title={PLANNED_HINT}>Planned roles</summary>
        <table className="rg-table">
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col">Purpose</th>
              <th scope="col">Mode</th>
            </tr>
          </thead>
          <tbody>
            {PLANNED.map((r) => (
              <tr key={r.callSign} data-planned>
                <td>
                  <b>{r.callSign}</b>
                  <br />
                  <small>{r.position}</small>
                </td>
                <td className="rg-purpose">{r.here}</td>
                <td>{modeText(r.mode)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      {prompt && <PromptDrawer role={prompt.role} onClose={closePrompt} />}
    </Panel>
  );
}

/** Setup › Roles & guards: what each repo's crew may do, the built-in stops, and the roles. */
export function Roles() {
  const hits = useResource<GuardHitsView>(RESOURCES.guardHits).data;
  const { data: config, error: configError } = useResource<ConfigView>(RESOURCES.config);
  const connection = useStore(streamStatus);
  return (
    <div className="rg-page">
      <div className="rg-head">
        <p className="s muted">What each role does, and the rules each repo's crew works under.</p>
        {!connection.connected && connection.reconnecting && (
          <p className="note s" role="status">
            {DISCONNECTED_NOTE}
          </p>
        )}
      </div>
      <div className="rg-cols">
        {config ? (
          <RepoRules config={config} />
        ) : (
          <Panel title="Repo rules">
            <div className="pb">
              {configError ? (
                <p className="note err" role="alert">
                  Rules did not load. {configError.message}
                </p>
              ) : (
                <p className="muted s">Reading the repo's rules…</p>
              )}
            </div>
          </Panel>
        )}
        <Guard hits={hits} />
      </div>
      <RolesTable config={config} error={configError} />
    </div>
  );
}
