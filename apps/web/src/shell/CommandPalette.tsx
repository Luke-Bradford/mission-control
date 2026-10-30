import type {
  AttentionItem,
  BoardItem,
  ConfigView,
  Crew,
  PullRequestView,
  RepoView,
} from "@mc/core";
import { useEffect, useId, useRef, useState } from "react";
import { freeSeats } from "../crew.ts";
import { RESOURCES, useResource, useResources } from "../data.ts";
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

function Palette() {
  const repos = useResource<RepoView[]>(RESOURCES.repos).data ?? NO_REPOS;
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const threads = useResource<AttentionItem[]>(RESOURCES.attention).data;
  const boards = useResources<BoardItem[]>(repos.map((r) => RESOURCES.boards(r.id)));
  const prs = useResources<PullRequestView[]>(repos.map((r) => RESOURCES.prs(r.id)));
  const tickets = boards.flatMap((b) => b.data ?? []);
  const openPrs = prs.flatMap((p) => p.data ?? []);

  const entries = buildEntries({
    rows: crew?.rows,
    tickets,
    prs: openPrs,
    threads,
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
        {shown.length === 0 && <p className="palette-empty muted">Nothing matches “{query}”.</p>}
        <p className="palette-keys keys">
          <kbd>↑</kbd>
          <kbd>↓</kbd> move · <kbd>Enter</kbd> go · <kbd>Esc</kbd> close
        </p>
      </div>
    </div>
  );
}
