import type {
  AttentionItem,
  BoardItem,
  CommsAgentResponse,
  ConfigView,
  Crew,
  PullRequestView,
  RepoView,
} from "@mc/core";
import { useEffect, useId, useRef, useState } from "react";
import { callSign, freeSeats } from "../crew.ts";
import { RESOURCES, type Resource, useResource, useResources } from "../data.ts";
import { buildEntries, filterEntries, type PaletteEntry } from "../palette/entries.ts";
import { readRecent, rememberPick } from "../palette/recent.ts";
import { closePalette, trapTab, useOverlay, usePaletteOpen, useReturnFocus } from "./overlays.ts";
import "./CommandPalette.css";

const NO_REPOS: RepoView[] = [];

/**
 * ⌘K / Ctrl+K: type to reach any page, seat, open ticket, open PR or Comms thread, or to run an
 * operator action the pages already offer. Arrows move, Enter runs, Esc closes. The server still
 * decides every action; a refusal shows as a toast.
 */
export function CommandPalette() {
  const open = usePaletteOpen();
  useOverlay("palette", open, closePalette);
  return open ? <Palette /> : null;
}

/** What one source (crew, a repo's board…) is doing; the palette names the ones not yet in. */
interface Source {
  label: string;
  res: Resource<unknown>;
}

function Palette() {
  const reposRes = useResource<RepoView[]>(RESOURCES.repos);
  const repos = reposRes.data ?? NO_REPOS;
  const crewRes = useResource<Crew>(RESOURCES.crew);
  const configRes = useResource<ConfigView>(RESOURCES.config);
  const threadsRes = useResource<AttentionItem[]>(RESOURCES.attention);
  const crew = crewRes.data;
  const config = configRes.data;
  const boards = useResources<BoardItem[]>(repos.map((r) => RESOURCES.boards(r.id)));
  const prs = useResources<PullRequestView[]>(repos.map((r) => RESOURCES.allPrs(r.id)));
  // Stored Comms has no page for an observed loop or FLIGHT's own seat (the server rejects them).
  const watch = new Set(
    config?.crew?.sessions.flatMap((s) =>
      s.seats.filter((x) => x.loop === "watch").map((x) => x.id),
    ),
  );
  const commsSeats = config
    ? (crew?.rows ?? []).filter((r) => r.kind === "crew" && !watch.has(r.id))
    : [];
  const commsRes = useResources<CommsAgentResponse>(
    commsSeats.map((r) => RESOURCES.commsNav(r.id)),
  );
  const tickets = boards.flatMap((b) => b.data ?? []);
  const openPrs = prs.flatMap((p) => p.data ?? []);

  const sources: Source[] = [
    { label: "repos", res: reposRes },
    { label: "crew", res: crewRes },
    { label: "config", res: configRes },
    { label: "Needs you", res: threadsRes },
    ...repos.flatMap((r, i): Source[] => [
      { label: `tickets of ${r.id}`, res: boards[i] as Resource<unknown> },
      { label: `PRs of ${r.id}`, res: prs[i] as Resource<unknown> },
    ]),
    ...commsSeats.map(
      (r, i): Source => ({
        label: `Comms of ${callSign(r)}`,
        res: commsRes[i] as Resource<unknown>,
      }),
    ),
  ];
  const loading = sources
    .filter((x) => x.res.loading && x.res.data === undefined)
    .map((x) => x.label);
  const failed = sources.filter((x) => x.res.error !== null).map((x) => x.label);

  const entries = buildEntries({
    rows: crew?.rows,
    tickets,
    prs: openPrs,
    threads: threadsRes.data,
    comms: commsSeats.flatMap((r, i) => {
      const data = commsRes[i]?.data;
      return data ? [{ agentId: r.id, data }] : [];
    }),
    freeSeatFor:
      config && crew ? (repoId) => freeSeats(config, crew, repoId)[0]?.id ?? null : undefined,
  });
  const [recent] = useState(readRecent);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const shown = filterEntries(entries, query, recent);
  const active = Math.min(at, Math.max(shown.length - 1, 0));
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const head = useId();
  const listId = useId();
  useReturnFocus(true); // before the effect that moves focus in, so the opener is what it remembers
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    list.current?.children[active]?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const pick = (e: PaletteEntry | undefined) => {
    if (!e) return;
    rememberPick(e.id);
    closePalette();
    void e.run();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = shown.length;
      if (n > 0) setAt((active + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(shown[active]);
    }
  };
  const recentIds = new Set(query.trim() === "" ? recent : []);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop closes on a click; the keys are the dialog's
    <div
      className="modal palette-modal"
      tabIndex={-1}
      onKeyDown={trapTab}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closePalette();
      }}
    >
      <div className="panel palette" role="dialog" aria-modal="true" aria-labelledby={head}>
        <h2 id={head} className="sr-only">
          Command palette
        </h2>
        <input
          ref={input}
          className="palette-input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={shown.length > 0 ? `${listId}-${active}` : undefined}
          aria-label="Go to a page, seat, ticket, PR or thread, or run an action"
          placeholder="Go to a page, seat, ticket, PR or thread, or run an action"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setAt(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div id={listId} ref={list} className="palette-list" role="listbox" aria-label="Results">
          {shown.map((e, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the input owns the keys (aria-activedescendant)
            <div
              key={e.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              tabIndex={-1}
              className={`palette-row${i === active ? " on" : ""}`}
              onMouseMove={() => setAt(i)}
              onClick={() => pick(e)}
            >
              <span className="palette-group">{recentIds.has(e.id) ? "Recent" : e.group}</span>
              <span className="palette-title">{e.title}</span>
              {e.hint && <span className="palette-hint">{e.hint}</span>}
            </div>
          ))}
        </div>
        {loading.length > 0 && (
          <p className="palette-empty muted" role="status">
            {`Still loading: ${loading.join(", ")}.`}
          </p>
        )}
        {failed.length > 0 && (
          <p className="palette-empty crit-t" role="alert">
            {`Could not load: ${failed.join(", ")}. Results from there may be missing.`}
          </p>
        )}
        {shown.length === 0 && loading.length === 0 && failed.length === 0 && (
          <p className="palette-empty muted">Nothing matches “{query}”.</p>
        )}
        <p className="palette-keys keys">
          <kbd>↑</kbd>
          <kbd>↓</kbd> move · <kbd>Enter</kbd> go · <kbd>Esc</kbd> close
        </p>
      </div>
    </div>
  );
}
