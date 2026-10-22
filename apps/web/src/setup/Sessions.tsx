import {
  type ConfigView,
  type Crew,
  type CrewRow,
  type CrewSessionFolders,
  HUD_STATE_LABEL,
  HUD_STATE_TONE,
} from "@mc/core";
import { Fragment, useId } from "react";
import { modelLine, seatAreaText } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { CrewOff } from "../hud/CrewOff.tsx";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";
import { agentPath, navigate } from "../router.ts";
import { inSession, useSession } from "../shell/session.ts";

const DASH = "—";
export const FOLDERS_UNREADABLE = "Could not read the checkout's folders.";
export const FOLDER_FREE = "free";
export const FOLDERS_NOTE = "Tiles show who owns each folder; areas can't overlap.";

/** A seat's button: named by its call sign alone; area, model line and state are its description. */
function Seat({ id, area, row }: { id: string; area: string; row: CrewRow | undefined }) {
  const tag = useId();
  const info = useId();
  return (
    <button
      type="button"
      aria-labelledby={tag}
      aria-describedby={info}
      onClick={() => navigate(agentPath(id))}
    >
      <AgentTag domId={tag} id={id} index={row?.index ?? 0} />
      <span id={info} className="seatinfo">
        <span className="xs muted">{area}</span>
        {row && <span className="xs muted">{modelLine(row)}</span>}
        {row && <Pill tone={HUD_STATE_TONE[row.hudState]}>{HUD_STATE_LABEL[row.hudState]}</Pill>}
      </span>
    </button>
  );
}

/** One crew session (config.yaml, read-only in 2a): its seats, and who owns each top folder. */
function CrewSession({
  session,
  config,
  crew,
  folders,
}: {
  session: NonNullable<ConfigView["crew"]>["sessions"][number];
  config: ConfigView;
  crew: Crew | undefined;
  folders: CrewSessionFolders | undefined;
}) {
  const repo = config.repos.find((r) => r.id === session.repoId);
  return (
    <Panel
      title={`s/${session.id}`}
      sub={`${session.checkout} · ${repo?.github ?? session.repoId}`}
    >
      <div className="pb">
        <div className="crew">
          {session.seats.map((seat) => {
            const row = crew?.rows.find((c) => c.id === seat.id);
            return <Seat key={seat.id} id={seat.id} area={seatAreaText(seat)} row={row} />;
          })}
        </div>
        {folders?.readable === false && <p className="muted s">{FOLDERS_UNREADABLE}</p>}
        {folders && folders.folders.length > 0 && (
          <ul className="tiles" aria-label={`Folders of s/${session.id}`}>
            {folders.folders.map((f) => (
              <li key={f.name} className="tile">
                <span className="tile-vis" aria-hidden="true">
                  {f.owners.length > 0 ? (
                    f.owners.map((id, i) => (
                      <Fragment key={id}>
                        {i > 0 && <span className="xs muted"> · </span>}
                        <AgentTag
                          id={id}
                          index={crew?.rows.find((c) => c.id === id)?.index ?? 0}
                          sm
                        />
                      </Fragment>
                    ))
                  ) : (
                    <span className="xs muted">{FOLDER_FREE}</span>
                  )}
                  <span className="s">{`${f.name}/`}</span>
                </span>
                <span className="sr-only">
                  {`${f.name}/: ${f.owners.length > 0 ? f.owners.join(", ") : FOLDER_FREE}`}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="note s">{FOLDERS_NOTE}</p>
      </div>
    </Panel>
  );
}

/**
 * Setup › Sessions (catalogue 2.7.1), read-only: a panel per repo with its observed loops (none
 * for a repo without any), then one per crew session (`s/{id}`) with its seats.
 */
export function Sessions({ config }: { config: ConfigView }) {
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const folders = useResource<CrewSessionFolders[]>(RESOURCES.crewSessions).data;
  const [session] = useSession();
  const crewSessions = config.crew?.sessions.filter((s) => inSession(session, s.repoId)) ?? [];
  return (
    <>
      <p className="note wide">
        A session is one repo and the agents working on it. They come from config.yaml for now;
        adding and editing them here arrives in phase 2d.
      </p>
      {config.repos
        .filter((r) => inSession(session, r.id))
        .filter((r) => config.loops.some((l) => l.repoId === r.id))
        .map((r) => {
          const first = config.loops.find((l) => l.repoId === r.id);
          const branch = crew?.rows.find((c) => c.id === first?.id)?.run?.branch ?? DASH;
          const rows = crew?.rows.filter((c) => c.kind === "loop" && c.repoId === r.id) ?? [];
          return (
            <Panel key={r.id} title={`${r.id} · observed loops`} sub={`${r.github} · ${branch}`}>
              <div className="pb">
                {/* Nothing is known until the crew loads (or while it fails to). */}
                {crew === undefined ? null : rows.length === 0 ? (
                  <p className="muted s">No agents yet.</p>
                ) : (
                  <div className="crew">
                    {rows.map((c) => (
                      <button key={c.id} type="button" onClick={() => navigate(agentPath(c.id))}>
                        <AgentTag id={c.id} index={c.index} />
                        <span className="xs muted">observed loop</span>
                        <Pill tone={HUD_STATE_TONE[c.hudState]}>{HUD_STATE_LABEL[c.hudState]}</Pill>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </Panel>
          );
        })}
      {crewSessions.length > 0 && <CrewOff className="note wide" />}
      {crewSessions.map((s) => (
        <CrewSession
          key={s.id}
          session={s}
          config={config}
          crew={crew}
          folders={folders?.find((f) => f.id === s.id)}
        />
      ))}
    </>
  );
}
