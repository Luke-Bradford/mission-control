// @ts-nocheck
// biome-ignore-all lint: the crew map is the operator's chosen prototype, kept as one framework-free piece
// biome-ignore-all format: ported from docs/prototype/comms-crew-map-live.html; keep it diffable against that file
/* Crew map: an orbital tracking display of a crew of coding agents. Framework-free, no dependencies.

   import { createCrewMap } from './crew-map.js';
   const map = createCrewMap(container, options);   // builds everything inside `container`
   source.subscribe(s => map.update(s));            // the only way data gets in
   map.destroy();                                   // removes every timer, observer, listener and node it made

   The map never knows which source feeds it. Everything it shows comes from Snapshots of this shape
   (copied from the contract, v4-tools/contract.md):

   type Snapshot = {
     now: number;                        // the data clock, ms since epoch
     source: {
       kind: 'live' | 'demo' | 'replay'; // the stage tag says LIVE, DEMO or REPLAY from this, never from a guess
       label: string;                    // short words for the tag, e.g. "hub 127.0.0.1:7420", "seed 7", "48 hours to 9 Nov"
       ok: boolean;                      // false: the source could not refresh; the map keeps the last picture, dimmed
       error?: string;                   // plain words, shown on the stage when ok is false ("The hub is not answering.")
       speed?: number;                   // data seconds per real second; absent or 1 for real time; replays are much faster
       progress?: number;                // 0..1 for a replay
     };
     contextLimit?: number;              // the working limit a context is measured against; default 150000
     participants: Participant[];
     messages: Message[];                // ascending by `at`; the source may send the whole recent window every time
     waits: Wait[];                      // only asks under a day old
     olderWaits: number;                 // asks more than a day old: one quiet count, never drawn
     olderWaitsOldest?: number | null;   // when the oldest of those was asked
     history?: { tokensPerMinute?: Array<[minuteStartMs: number, tokens: number]> };  // crew total per minute, where the source knows it
   };
   type Participant = {
     id: string;                         // 'flight-1', 'guido-1', 'CAPCOM', 'CONTROLLER', 'MC'
     label: string;                      // 'FLIGHT', 'GUIDO-1', 'CAPCOM', 'CONTROLLER', 'HUB'
     role: 'flight' | 'server' | 'web' | 'review' | 'plan' | 'operator' | 'helper' | 'hub';
     kind: 'seat' | 'operator' | 'helper' | 'hub';   // FLIGHT is a seat with role 'flight'. The hub is never drawn as a node.
     state: 'running' | 'idle' | 'stopped' | 'unknown' | 'nodata';   // unknown: not tracked (replays); nodata: not in this feed
     stateSince?: number | null;
     ticket?: string | null;             // 'mission-control#2172'
     ticketTitle?: string | null;
     contextTokens?: number | null;
     contextLimit?: number | null;       // per-seat override of Snapshot.contextLimit, when the hub supplies one
     liveTool?: string | null;           // the tool call running now, e.g. 'Edit'; null when none
     tokensPerMinute?: number | null;
     hold?: 'blocked' | 'stalled' | 'error' | null;   // a seat that is stuck, not stopped: drawn as a red square and named in words
   };
   type Message = { id: string; at: number; from: string; to: string; ask?: boolean; ticket?: string | null; text: string };
                                         // a hub notice is a message whose `from` is the participant of kind 'hub'
   type Wait = { id: string; from: string; to: string; since: number; followUpAt?: number | null; text: string };
                                         // `from` asked, `to` owes the reply; id equals the asking message's id when known

   Options (all optional):
     view: 'panel' | 'full' | 'ambient'          default 'panel'
     contextLimit: number                        used when the snapshot gives none; default 150000
     chart: boolean                              the 60-minute strip in the full view; default true
     sweep: boolean                              default true
     hubNotices: boolean                         default true
     reducedMotion: 'auto' | boolean             default 'auto' (follows the system setting)
     key: boolean                                the key starts open; default false
     catchUp: boolean                            play the last hour in about 6 s on the first real-time snapshot; default true
     actions: Array<{ label, title?, onClick, pressed?, only?: 'panel' | 'full' }>   extra header buttons owned by the page
     pins: { panel?: {[id]: [nx, ny]}, full?: {...}, ambient?: {...} }   places the operator kept, per view size
     onPinsChange(pins)                          called with the whole pins object whenever one is kept or sent home
     onSelect(sel | null), onOpenConversation(sel), onViewChange(view)
     perf: boolean                               a small frame-cost readout on the stage (for measuring, not part of the design)
   Returns { update, setView, select, setActions, setOptions, resetPlaces, getPins, colorOf, destroy }.
*/

const MIN = 60e3, HOUR = 3600e3, TAU = Math.PI * 2;
const WARM_MS = 20 * MIN;                 // a lane stays warm this long after a message
const FLOOD_WIN = 5 * MIN, FLOOD_N = 5;   // "sending a lot": 5 or more messages sent in 5 minutes
const CATCHUP_MS = HOUR, CATCHUP_WALL = 6000;
const RECENT_WALL = 5000;                 // a message first seen this soon after it was sent (in real seconds) travels as a comet
const FAST = 4;                           // a source faster than this is a replay at speed: afterglow runs on the wall clock
const SPRING_W = 15, SPRING_Z = .6;       // the spring that takes a seat home: rad/s and damping ratio (about 9% overshoot, settled in half a second)
const DRAG_PX = 4, DRAG_PX_TOUCH = 8;     // a press that moves less than this is a click, not a drag
const SLOW_MS = 44;                       // wait between frames when only slow things move (the sweep, rings, drifting dots, the amber beat): about 20 a second
const HOLDCOL = '#ff7a7a';
const AMBER = '#ffb42e', HUBCOL = '#aeb9cb';
const HUE = { CAPCOM: '#f4f6f8', CONTROLLER: '#b9a7ff', 'flight-1': '#56d8e6', 'fao-1': '#4fd18b', 'guido-1': '#5aa2ff', 'guido-2': '#e88f6a',
  'guido-cx': '#ff6a4a', 'inco-1': '#8fdc6a', 'inco-cx': '#a08bff', 'retro-1': '#ff6fa8', 'retro-cx': '#e6e07a' };
const ROLE_WORD = { flight: 'head agent', operator: 'operator', helper: 'outside helper', server: 'server developer', web: 'web developer', review: 'reviewer', plan: 'planner' };
const STATES = new Set(['running', 'idle', 'stopped', 'unknown', 'nodata']);
// Fixed places. [bearing in degrees clockwise from the top, orbit radius as a share of the outer rim].
// A seat's slot never depends on how many others there are, so adding a seat moves nobody.
const ORB = { op: .30, dev: .56, dev2: .745, out: .93 };
const SLOTS = {
  server: [[63, .56], [90, .56], [117, .56], [144, .56], [76.5, .745], [103.5, .745], [130.5, .745], [50, .745], [157, .745]],
  web: [[297, .56], [270, .56], [243, .56], [216, .56], [283.5, .745], [256.5, .745], [229.5, .745], [310, .745], [203, .745]],
  review: [[338, .93], [22, .93], [40, .93], [325, .93], [58, .93]],
  plan: [[180, .93], [200, .93], [160, .93]],
  other: [[140, .93], [220, .93], [125, .93], [235, .93]],
  operator: [[0, .30], [35, .30], [325, .30]],
};
const NPT = 40;
const OVERFLOW_STEP = 15;                // degrees between seats past the end of a role's table; wide enough that two name tags do not meet

const pad2 = n => String(n).padStart(2, '0');
const fmtHM = ms => { const d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
const fmtHMS = ms => fmtHM(ms) + ':' + pad2(new Date(ms).getSeconds());
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtDHM = ms => DAYS[new Date(ms).getDay()] + ' ' + fmtHM(ms);
const fmtK = n => n >= 999500 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : n < 1000 ? String(Math.round(n)) : Math.round(n / 1000) + 'K';
const fmtRate = n => n >= 10000 ? Math.round(n / 1000) + 'K' : n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(Math.round(n));
const fmtAge = ms => { const m = Math.max(0, ms) / MIN; return m < 1 ? 'now' : m < 90 ? Math.round(m) + ' min' : m < 48 * 60 ? (m / 60).toFixed(m < 600 ? 1 : 0) + ' h' : Math.round(m / 1440) + ' days'; };
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const hsl = (h, s, l) => { const f = n => { const k = (n + h / 30) % 12, a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0'); }; return '#' + f(0) + f(8) + f(4); };
const rgba = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true });
const shortTicket = t => t ? t.replace(/^[\w.-]+#/, '#') : '';
const shortTool = t => { t = t ? String(t).split('__').pop() : ''; return t.length > 18 ? t.slice(0, 17) + '…' : t; };
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/* ---------------------------------------------------------------- styles, injected once and removed with the last map */
const STYLE = `
.cm { --cm-surface: var(--surface, #0c1117); --cm-surface-2: var(--surface-2, #131a23); --cm-line: var(--line, #1b2430); --cm-line-2: var(--line-2, #2a3646);
  --cm-fg: var(--fg, #e7eaef); --cm-fg-2: var(--fg-2, #aab2bf); --cm-muted: var(--muted, #808999); --cm-accent: var(--accent, #56d8e6);
  --cm-accent-soft: var(--accent-soft, rgba(86, 216, 230, .14)); --cm-ok: var(--ok, #45c486); --cm-warn: var(--warn, #f2b53a);
  --cm-void: var(--void, #04060c); --cm-void-2: #070c18; --cm-void-line: var(--void-line, #1a2440); --cm-void-ink: var(--void-ink, #dbe4f5); --cm-void-muted: var(--void-muted, #8391ad);
  --cm-sans: var(--sans, "IBM Plex Sans", "Segoe UI", system-ui, sans-serif); --cm-mono: var(--mono, "IBM Plex Mono", "Cascadia Mono", Consolas, ui-monospace, monospace);
  --cm-display: var(--display, "Barlow Semi Condensed", "Arial Narrow", "IBM Plex Sans", sans-serif);
  display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; min-width: 0; overflow: hidden; color: var(--cm-fg); font: 13px/20px var(--cm-sans); }
.cm, .cm * { box-sizing: border-box; }
.cm [hidden] { display: none !important; }
.cm button { font: inherit; color: inherit; }
.cm h4 { margin: 0; font: 500 11px/16px var(--cm-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--cm-muted); }
.cm .cm-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.cm .cm-head { display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 12px; border-bottom: 1px solid var(--cm-line); min-height: 44px; flex: none; }
.cm .cm-head h3 { margin: 0; font: 600 14px/20px var(--cm-sans); white-space: nowrap; }
.cm .cm-status { font: 11px/16px var(--cm-mono); color: var(--cm-fg-2); letter-spacing: .03em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1; }
.cm .cm-status i { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--cm-ok); margin-right: 6px; }
.cm .cm-status.cm-is-demo i, .cm .cm-status.cm-is-replay i { background: none; border: 1px solid var(--cm-fg-2); border-radius: 1px; }
.cm .cm-status.cm-is-off i { background: none; border: 1px solid var(--cm-muted); }
.cm .cm-actions { display: contents; }
.cm .cm-btn { border: 1px solid var(--cm-line-2); background: var(--cm-surface-2); border-radius: 3px; height: 26px; min-width: 26px; padding: 0 8px; font: 500 11px/1 var(--cm-mono); letter-spacing: .04em; cursor: pointer; white-space: nowrap; color: var(--cm-fg-2); flex: none; }
.cm .cm-btn:hover { color: var(--cm-fg); border-color: var(--cm-muted); }
.cm .cm-btn[aria-pressed="true"] { background: var(--cm-accent-soft); color: var(--cm-accent); border-color: var(--cm-accent); }
.cm .cm-btn:focus-visible, .cm .cm-side button:focus-visible { outline: 2px solid var(--cm-accent); outline-offset: 1px; }
.cm .cm-only-full { display: none; }
.cm .cm-body { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.cm .cm-main { display: flex; flex-direction: column; flex: none; min-width: 0; min-height: 0; position: relative; }
.cm .cm-stage { position: relative; height: 356px; flex: none; overflow: hidden; color: var(--cm-void-ink); user-select: none; -webkit-user-select: none;
  background: radial-gradient(ellipse 75% 70% at 50% 50%, #0d1830 0%, #070c18 55%, var(--cm-void) 100%); }
:root[data-theme="light"] .cm:not(.cm-is-full) .cm-stage { margin: 8px 8px 0; border-radius: 4px; box-shadow: inset 0 0 0 1px #0a0f1d, 0 1px 3px rgba(20, 30, 50, .25); }
.cm .cm-stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.cm .cm-labels { position: absolute; inset: 0; pointer-events: none; }
.cm .cm-stage.cm-is-stale canvas, .cm .cm-stage.cm-is-stale .cm-labels { opacity: .38; }
.cm .cm-seat, .cm .cm-pair { position: absolute; left: 0; top: 0; width: 0; height: 0; padding: 0; border: 0; background: none; pointer-events: auto; cursor: pointer; overflow: visible; }
.cm .cm-seat { cursor: grab; touch-action: none; }
.cm .cm-seat .cm-hit, .cm .cm-seat .cm-lab { touch-action: none; }
.cm .cm-stage.cm-is-dragging, .cm .cm-stage.cm-is-dragging .cm-seat { cursor: grabbing; }
.cm .cm-seat.cm-is-moving { z-index: 1; }
.cm .cm-seat:focus, .cm .cm-pair:focus { outline: none; }
.cm .cm-hit { position: absolute; border-radius: 50%; }
.cm .cm-lab { position: absolute; white-space: nowrap; padding: 1px 4px; border-radius: 2px; background: rgba(4, 6, 12, .66); color: var(--cm-void-ink);
  font: 500 11px/13px var(--cm-mono); letter-spacing: .02em; text-align: left; }
.cm .cm-lab small { display: none; font: 400 11px/14px var(--cm-mono); color: var(--cm-void-muted); letter-spacing: 0; }
.cm .cm-lab i { display: none; font: 400 11px/13px var(--cm-mono); font-style: normal; color: var(--cm-void-ink); margin-left: 8px; letter-spacing: 0; }
.cm .cm-seat.cm-is-over .cm-lab i { color: #fff; font-weight: 500; }
.cm .cm-seat.cm-is-hold .cm-lab small { color: #ff9a9a; }
.cm .cm-seat.cm-is-stopped .cm-lab, .cm .cm-seat.cm-is-nodata .cm-lab { color: var(--cm-void-muted); }
.cm .cm-seat:focus-visible .cm-lab { outline: 2px solid #fff; outline-offset: 1px; background: #04060c; }
.cm .cm-seat[aria-pressed="true"] .cm-lab { background: #fff; color: #04060c; }
.cm .cm-seat[aria-pressed="true"] .cm-lab small, .cm .cm-seat[aria-pressed="true"] .cm-lab i { color: #3a4458; }
.cm .cm-tag { position: absolute; left: 8px; bottom: 6px; font: 11px/14px var(--cm-mono); color: var(--cm-void-muted); pointer-events: none; max-width: 42%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cm .cm-tag b { color: var(--cm-void-ink); font-weight: 500; display: block; }
.cm .cm-tag i { display: none; font-style: normal; }
.cm.cm-is-full .cm-tag b { display: inline; }
.cm.cm-is-full .cm-tag i { display: inline; }
.cm .cm-empty, .cm .cm-alert { position: absolute; left: 50%; top: 66%; transform: translateX(-50%); width: min(78%, 420px); text-align: center; font: 12px/16px var(--cm-sans); color: var(--cm-void-ink); background: rgba(4, 6, 12, .82); border: 1px solid var(--cm-void-line); border-radius: 3px; padding: 8px 12px; pointer-events: none; }
.cm .cm-alert { top: 8px; z-index: 3; border-color: #5b6a8c; background: rgba(4, 6, 12, .92); }
.cm .cm-alert b { display: block; font: 500 11px/16px var(--cm-mono); letter-spacing: .06em; }
.cm.cm-is-full .cm-alert { top: 48px; }
.cm .cm-strip { flex: none; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0 8px; padding: 4px 12px; min-height: 41px; background: var(--cm-void-2); border-top: 1px solid var(--cm-void-line); color: var(--cm-void-ink); font: 11px/16px var(--cm-mono); }
.cm .cm-strip b { font-weight: 500; }
.cm .cm-strip span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.cm .cm-l2 { grid-column: 1 / 3; color: var(--cm-void-muted); }
.cm .cm-strip.cm-is-detail .cm-l1 { color: #fff; font-weight: 500; }
.cm .cm-key { flex: none; background: var(--cm-void-2); border-top: 1px solid var(--cm-void-line); padding: 8px 12px; font: 12px/16px var(--cm-sans); color: var(--cm-void-ink); display: grid; grid-template-columns: 1fr; gap: 4px; }
.cm .cm-key div { display: grid; grid-template-columns: 26px 1fr; gap: 8px; align-items: start; }
.cm .cm-key svg { width: 26px; height: 16px; display: block; }
.cm .cm-key p { margin: 0; color: var(--cm-void-muted); }
:root[data-theme="light"] .cm:not(.cm-is-full) .cm-strip, :root[data-theme="light"] .cm:not(.cm-is-full) .cm-key { margin: 0 8px; }
.cm .cm-progress { position: absolute; z-index: 2; left: 0; right: 0; top: 0; height: 2px; background: #1a2440; pointer-events: none; }
.cm .cm-progress i { display: block; height: 100%; width: 0; background: var(--cm-void-ink); }
.cm.cm-is-full:not(.cm-is-ambient) .cm-progress { top: 29px; }
.cm .cm-reset { position: absolute; z-index: 2; right: 8px; bottom: 6px; background: rgba(6, 9, 18, .8); color: var(--cm-void-ink); border-color: #2b3a5c; }
.cm .cm-perf { position: absolute; z-index: 4; right: 8px; top: 40px; font: 11px/14px var(--cm-mono); color: #ff9df0; background: rgba(4, 6, 12, .8); border: 1px dashed #ff5fd2; padding: 2px 6px; white-space: pre; pointer-events: none; }
.cm .cm-ticker { display: none; }
.cm .cm-side { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--cm-line-2) transparent;
  background: linear-gradient(var(--cm-surface) 30%, transparent) top / 100% 24px no-repeat local, linear-gradient(transparent, var(--cm-surface) 70%) bottom / 100% 24px no-repeat local,
    linear-gradient(rgba(128, 140, 160, .45), transparent) top / 100% 8px no-repeat scroll, linear-gradient(transparent, rgba(128, 140, 160, .45)) bottom / 100% 8px no-repeat scroll; }
.cm .cm-side section { padding: 8px 12px; border-top: 1px solid var(--cm-line); min-width: 0; flex: none; }
.cm .cm-side h4 b { color: var(--cm-fg); font-weight: 500; }
.cm .cm-side h4 span { text-transform: none; letter-spacing: 0; float: right; }
.cm .cm-side ul { list-style: none; margin: 4px 0 0; padding: 0; }
.cm .cm-side li button { all: unset; box-sizing: border-box; display: flex; gap: 8px; align-items: baseline; width: 100%; cursor: pointer; padding: 1px 0; min-height: 24px; }
.cm .cm-side li button:hover .cm-tx { color: var(--cm-fg); }
.cm .cm-who { font: 500 11px/16px var(--cm-mono); white-space: nowrap; flex: none; }
.cm .cm-tx { color: var(--cm-fg-2); font-size: 12px; line-height: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
.cm .cm-tm { font: 11px/16px var(--cm-mono); color: var(--cm-muted); flex: none; white-space: nowrap; }
.cm .cm-amb { width: 8px; height: 8px; border-radius: 50%; background: #ffb42e; box-shadow: 0 0 0 2px rgba(255, 180, 46, .28); flex: none; align-self: center; }
.cm .cm-age { font: 500 11px/16px var(--cm-mono); color: var(--cm-warn); flex: none; white-space: nowrap; }
.cm .cm-quiet { color: var(--cm-muted); font-size: 12px; line-height: 16px; margin: 4px 0 0; }
.cm .cm-hubline .cm-who { color: var(--cm-muted); font-weight: 400; }
.cm:not(.cm-is-full) .cm-said { min-height: 78px; }
.cm:not(.cm-is-full) .cm-wait { min-height: 26px; }
:root[data-theme="light"] .cm .cm-side .cm-who[data-c] { filter: brightness(.62) saturate(1.5); }
.cm .cm-side .cm-roster { display: block; flex: none; }
.cm .cm-roster li button { display: grid; grid-template-columns: 16px 76px minmax(0, 1fr) 44px auto; gap: 8px; align-items: center; min-height: 24px; padding: 0; font-size: 12px; line-height: 16px; }
.cm .cm-roster li button[aria-pressed="true"] { background: var(--cm-accent-soft); }
.cm .cm-roster svg { width: 16px; height: 16px; display: block; }
.cm .cm-roster .cm-nm { font: 500 11px/16px var(--cm-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cm .cm-roster .cm-st { color: var(--cm-fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cm .cm-cx { height: 4px; background: var(--cm-line-2); border-radius: 2px; position: relative; }
.cm .cm-cx i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--cm-fg-2); border-radius: 2px; }
.cm .cm-cx.cm-is-over i { background: var(--cm-fg); box-shadow: 0 0 0 1px var(--cm-fg); }
.cm .cm-cn { font: 11px/16px var(--cm-mono); color: var(--cm-fg-2); text-align: right; min-width: 30px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.cm .cm-cx.cm-is-over + .cm-cn { color: var(--cm-fg); font-weight: 500; }
.cm .cm-chart { display: none; flex: none; grid-template-columns: 400px minmax(0, 1fr); gap: 16px; align-items: center; padding: 8px 16px; background: var(--cm-void-2); border-top: 1px solid var(--cm-void-line); color: var(--cm-void-ink); }
.cm .cm-chart-words { min-width: 0; }
.cm .cm-chart h4 { color: var(--cm-void-muted); margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cm .cm-chart h4 span { text-transform: none; letter-spacing: 0; color: var(--cm-void-ink); margin-left: 8px; }
.cm .cm-chart canvas { display: block; width: 100%; height: 72px; cursor: crosshair; }
.cm .cm-chart p { margin: 0; font: 12px/16px var(--cm-sans); color: var(--cm-void-ink); display: grid; grid-template-columns: 16px 1fr; gap: 4px; align-items: start; }
.cm .cm-chart p svg { width: 16px; height: 16px; display: block; }
.cm .cm-exit { display: none; }

/* full screen: the same component, fixed over the page. --cm-inset-bottom lets the page keep a strip of its own in view */
.cm.cm-is-full { position: fixed; z-index: 20; inset: 0 0 var(--cm-inset-bottom, 0px) 0; background: var(--cm-surface); }
.cm.cm-is-full .cm-only-full { display: inline-block; }
.cm.cm-is-full .cm-only-panel { display: none; }
.cm.cm-is-full .cm-head { padding: 8px 16px; min-height: 48px; gap: 12px; }
.cm.cm-is-full .cm-head h3 { font: 500 20px/28px var(--cm-display); letter-spacing: .04em; }
.cm.cm-is-full .cm-status { font-size: 12px; }
.cm.cm-is-full .cm-body { flex-direction: row; }
.cm.cm-is-full .cm-main { flex: 1 1 auto; }
.cm.cm-is-full .cm-stage { height: auto; flex: 1 1 auto; margin: 0; border-radius: 0; box-shadow: none; }
.cm.cm-is-full .cm-side { width: 360px; flex: none; border-left: 1px solid var(--cm-line); overflow-y: auto; background: none; }
.cm.cm-is-full .cm-side section { padding: 12px 16px; border-top: 0; border-bottom: 1px solid var(--cm-line); }
.cm.cm-is-full .cm-side .cm-roster { flex: none; }
.cm.cm-is-full .cm-side li button { flex-wrap: wrap; padding: 4px 0; }
.cm.cm-is-full .cm-roster li button { padding: 0; }
.cm.cm-is-full .cm-side .cm-tx { flex-basis: 100%; white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.cm.cm-is-full .cm-side .cm-who { flex: 1; }
.cm.cm-is-full:not(.cm-is-ambient) .cm-chart { display: grid; }
.cm.cm-is-full .cm-lab { font-size: var(--cm-lab, 13px); line-height: calc(var(--cm-lab, 13px) + 2px); }
.cm.cm-is-full .cm-lab i { display: inline; font-size: var(--cm-lab2, 11px); }
.cm.cm-is-full .cm-lab small { display: block; font-size: var(--cm-lab2, 11px); line-height: calc(var(--cm-lab2, 11px) + 3px); }
.cm.cm-is-full .cm-strip { position: absolute; z-index: 2; left: 0; top: 0; right: 0; min-height: 28px; display: flex; gap: 16px; padding: 6px 16px; font-size: 12px; background: rgba(4, 6, 12, .6); border-top: 0; border-bottom: 1px solid var(--cm-void-line); margin: 0; }
.cm.cm-is-full .cm-l2 { flex: 1; }
.cm.cm-is-full .cm-l1 { flex: none; max-width: 60%; }
.cm.cm-is-full .cm-key { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px 24px; padding: 8px 16px; margin: 0; }
.cm.cm-is-full .cm-key p { grid-column: 1 / -1; }
.cm.cm-is-full .cm-tag { left: 16px; bottom: 10px; font-size: 12px; max-width: 42%; }
.cm.cm-is-full .cm-reset { right: 16px; bottom: 10px; }
/* ambient: chrome hidden, for leaving on a screen */
.cm.cm-is-ambient { inset: 0; }
.cm.cm-is-ambient .cm-head, .cm.cm-is-ambient .cm-side, .cm.cm-is-ambient .cm-key { display: none; }
.cm.cm-is-ambient .cm-ticker { display: block; position: absolute; left: 16px; bottom: 34px; max-width: 34%; font: 13px/20px var(--cm-sans); color: var(--cm-void-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: .85; pointer-events: none; }
.cm.cm-is-ambient .cm-ticker b { font: 500 12px/20px var(--cm-mono); margin-right: 8px; }
.cm.cm-is-ambient .cm-exit { display: block; position: absolute; z-index: 5; right: 16px; top: 44px; opacity: 0; transition: opacity .2s; background: rgba(6, 9, 18, .8); color: var(--cm-void-ink); border-color: #2b3a5c; }
.cm.cm-is-ambient .cm-stage:hover .cm-exit, .cm.cm-is-ambient .cm-exit:focus-visible { opacity: 1; }
`;
let styleEl = null, styleUsers = 0;
function useStyle() { if (!styleUsers++) { styleEl = el('style'); styleEl.dataset.cm = '1'; styleEl.textContent = STYLE; document.head.append(styleEl); } }
function dropStyle() { if (!--styleUsers && styleEl) { styleEl.remove(); styleEl = null; } }

const KEY_ROWS = lim => [
  ['<circle cx="5" cy="8" r="2.2" fill="#5aa2ff"/><path d="M5 2.5a5.5 5.5 0 0 1 5.5 5.5M5 13.5a5.5 5.5 0 0 1 -5.5 -5.5" fill="none" stroke="#5aa2ff" stroke-width="1.4"/><circle cx="15" cy="8" r="2.6" fill="#8fdc6a"/><circle cx="23" cy="8" r="2.6" fill="none" stroke="#8391ad" stroke-width="1.3"/>', 'Turning ring: working. Steady light: idle. Hollow: stopped.'],
  ['<circle cx="13" cy="8" r="6" fill="none" stroke="#dbe4f5" stroke-width=".8" opacity=".35"/><path d="M13 2a6 6 0 1 1 -5.2 9" fill="none" stroke="#dbe4f5" stroke-width="1.6"/><path d="M13 0v4" stroke="#dbe4f5" stroke-width="1.2"/>', `White arc: context used. A full circle is the ${fmtK(lim)} working limit, not the model’s window.`],
  ['<path d="M1 11 Q9 3 17 8" fill="none" stroke="#56d8e6" stroke-width="2" stroke-dasharray=".1 4" stroke-linecap="round"/><circle cx="12" cy="6.6" r="2.8" fill="#56d8e6"/><path d="M25 9l-6-2 1 5z" fill="#56d8e6"/>', 'Moving light: one message, in the sender’s colour. Its link stays lit, with an arrow, for 20 minutes.'],
  ['<rect x="7" y="2" width="12" height="12" fill="none" stroke="#ff7a7a" stroke-width="1.6"/><circle cx="13" cy="8" r="2.6" fill="#dbe4f5"/>', 'Red square: stuck, named in words as blocked, stalled or error. A stopped seat is hollow.'],
  ['<circle cx="13" cy="8" r="6" fill="none" stroke="#ffb42e" stroke-width="1.8" stroke-dasharray="26 12"/><circle cx="4" cy="8" r="2.4" fill="#ffb42e"/>', 'Amber: owes a reply. Its ring runs down to the hub’s next follow-up.'],
];
const GLYPH = {
  running: c => `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="${c}"/><path d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5M8 14.5A6.5 6.5 0 0 1 1.5 8" fill="none" stroke="${c}" stroke-width="1.6"/></svg>`,
  idle: c => `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.4" fill="${c}"/></svg>`,
  unknown: c => `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.4" fill="${c}"/></svg>`,
  hold: () => `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" fill="none" stroke="#ff7a7a" stroke-width="1.6"/></svg>`,
  stopped: () => `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4" fill="none" stroke="#8391ad" stroke-width="1.4"/></svg>`,
  nodata: c => `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.5" fill="none" stroke="${c}" stroke-width="1.4" stroke-dasharray="2 2.2"/></svg>`,
};

function createCrewMap(container, options) {
  if (!container) throw new Error('createCrewMap needs a container element');
  const O = Object.assign({ view: 'panel', contextLimit: 150000, chart: true, sweep: true, hubNotices: true, reducedMotion: 'auto', key: false, catchUp: true, perf: false, actions: [], pins: null }, options);
  const S = { view: ['panel', 'full', 'ambient'].includes(O.view) ? O.view : 'panel', key: !!O.key, sel: '' };
  let destroyed = false;
  const offs = [];
  const on = (t, type, fn, opt) => { t.addEventListener(type, fn, opt); offs.push(() => t.removeEventListener(type, fn, opt)); };
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = () => O.reducedMotion === true || O.reducedMotion === 'reduced' || (O.reducedMotion === 'auto' && !!mq && mq.matches);
  const pins = { panel: {}, full: {}, ambient: {} };
  if (O.pins) for (const v in pins) Object.assign(pins[v], O.pins[v] || {});

  /* ---------------------------------------------------------------- DOM */
  useStyle();
  const root = el('div', 'cm');
  root.innerHTML = `
<header class="cm-head">
  <h3>Crew map</h3><span class="cm-status" role="status"></span><span class="cm-actions"></span>
  <button type="button" class="cm-btn cm-b-key" aria-pressed="false" title="What the marks mean">Key</button>
  <button type="button" class="cm-btn cm-only-full cm-b-ambient" title="Hide everything but the map">Ambient</button>
  <button type="button" class="cm-btn cm-only-panel cm-b-full" title="Open the map full screen" aria-label="Open the map full screen">Full</button>
  <button type="button" class="cm-btn cm-only-full cm-b-close" title="Close full screen" aria-label="Close full screen">✕</button>
</header>
<div class="cm-body">
  <div class="cm-main">
    <div class="cm-stage">
      <canvas class="cm-bg" aria-hidden="true"></canvas>
      <canvas class="cm-fx" role="img" aria-label="Crew map. A tracking display: FLIGHT is the station at the centre, the operator beside it, seats on orbits by role, each with a context gauge. Lights travel along a link when one writes to another. The tables after this picture hold the same facts."></canvas>
      <div class="cm-labels" role="group" aria-label="Seats and links. Arrow keys move, Enter opens the conversation. Seats can also be dragged with a pointer."></div>
      <div class="cm-empty" hidden></div>
      <div class="cm-alert" role="alert" hidden></div>
      <div class="cm-tag"></div>
      <div class="cm-progress" hidden><i></i></div>
      <button type="button" class="cm-btn cm-reset" title="Send every kept seat back to its home place" hidden>Reset places</button>
      <div class="cm-ticker"></div>
      <button type="button" class="cm-btn cm-exit">Exit ambient (Esc)</button>
      <div class="cm-perf" hidden></div>
      <div class="cm-sr cm-tables"></div>
    </div>
    <div class="cm-strip"><b class="cm-clock"></b><span class="cm-l1"></span><span class="cm-l2"></span></div>
    <section class="cm-chart" aria-label="The last 60 minutes">
      <div class="cm-chart-words">
        <h4>Last 60 minutes <span class="cm-chart-at"></span></h4>
        <p><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 11l4-5 4 3 6-6" fill="none" stroke="#fff" stroke-width="1.6"/></svg><span class="cm-chart-t"></span></p>
        <p><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13V8M8 13V4M13 13V9" stroke="#9fb0d2" stroke-width="3"/></svg><span class="cm-chart-m"></span></p>
      </div>
      <canvas role="img" aria-label="Two small charts over the last 60 minutes: the crew’s tokens a minute as a line, and messages a minute as bars. The table after the map holds the same figures."></canvas>
    </section>
    <div class="cm-key" hidden></div>
  </div>
  <div class="cm-side">
    <section><h4>Waiting on a reply <b class="cm-waitn"></b><span class="cm-waitold"></span></h4><ul class="cm-wait"></ul></section>
    <section><h4>Just said</h4><ul class="cm-said"></ul></section>
    <section class="cm-roster"><h4>Seats <span>state · ticket · context</span></h4><ul></ul></section>
  </div>
</div>`;
  container.append(root);
  const $ = s => root.querySelector(s);
  const stage = $('.cm-stage'), bgc = $('.cm-bg'), fxc = $('.cm-fx'), bg = bgc.getContext('2d'), ctx = fxc.getContext('2d'), labels = $('.cm-labels');
  const D = { status: $('.cm-status'), actions: $('.cm-actions'), bKey: $('.cm-b-key'), empty: $('.cm-empty'), alert: $('.cm-alert'), tag: $('.cm-tag'), progress: $('.cm-progress'),
    reset: $('.cm-reset'), ticker: $('.cm-ticker'), perf: $('.cm-perf'), tables: $('.cm-tables'), strip: $('.cm-strip'), clock: $('.cm-clock'), l1: $('.cm-l1'), l2: $('.cm-l2'), key: $('.cm-key'),
    side: $('.cm-side'), chart: $('.cm-chart'), chartCv: $('.cm-chart canvas'), chartT: $('.cm-chart-t'), chartM: $('.cm-chart-m'), chartAt: $('.cm-chart-at'),
    waitn: $('.cm-waitn'), waitold: $('.cm-waitold'), wait: $('.cm-wait'), said: $('.cm-said'), roster: $('.cm-roster ul') };

  /* ---------------------------------------------------------------- model */
  const M = { parts: new Map(), list: [], lanes: [], lane: new Map(), pairs: [], pair: new Map(), comets: [], waits: [], allWaits: [], said: [], msgs: [], seen: new Set(), hubIds: new Set(),
    older: { n: 0, oldest: null }, selSeat: null, selPair: null, hotPair: null, hotSeat: null, focus: null, warmCut: -1e18, readout: null, tracked: false, hourN: 0, dropped: 0 };
  const E = { mode: 'wait', started: false, everOk: false, sig: '', kind: '', label: '', progress: null, speed: 1, fast: false, stale: false, error: '', base: 0, baseWall: 0, lastNow: -1e18, frozen: 0,
    limit: O.contextLimit || 150000, q: [], i: 0, w0: 0, t0d: 0, wallTau: 6500 };
  let T = 0;   // animation time in ms; only advances while frames are drawn
  const L = { W: 0, H: 0, dpr: 1, cx: 0, cy: 0, rx: 1, ry: 1, s: 1, compact: true, dense: false, laid: false, fs: 11, fs2: 11, fm: 9, fTop: 0, fSide: 0, flowDash: [.1, 11], at: 0, n: 0, cost: 0, pending: false };
  const hueUsed = [];
  function colorFor(id) {
    if (HUE[id]) return HUE[id];
    let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 3600; h = (h * 0.1 + 20) % 360;
    for (let k = 0; k < 9 && hueUsed.some(u => Math.min(Math.abs(u - h), 360 - Math.abs(u - h)) < 17); k++) h = (h + 47) % 360;
    hueUsed.push(h); return hsl(h, .85, .68);
  }
  // the data clock between snapshots: it runs on from the last one at the source's speed. A fast source is held to
  // a short run so a stalled replay does not race ahead; a source that could not refresh stops the clock
  function clockNow() {
    if (!E.started) return Date.now(); if (E.stale) return E.frozen;
    const dw = performance.now() - E.baseWall; return E.base + (E.fast ? Math.min(dw, 1500) : dw) * E.speed;
  }
  function newPart(id) {
    return { id, name: id, kind: 'seat', role: '', color: colorFor(id), state: 'unknown', hold: '', since: 0, ticket: null, title: null, tool: '', rate: null, ctx: 0, lim: 0, n: 0, hubN: 0,
      sent: [], flood: 0, flash: 0, rings: [], hubRings: [], ping: 0, rho: 0, th: 0, hx: 0, hy: 0, x: 0, y: 0, r: 0, rT: 6, phase: 0, lab: null, sub: '', ctxTxt: '', disp: id, nolab: false,
      btn: null, row: null, links: [], sig: '', selOn: true, ox: 0, oy: 0, vx: 0, vy: 0, tx: 0, ty: 0, mover: false, _amb: -1 };
  }
  function need(a, b) {
    const A = M.parts.get(a), B = M.parts.get(b); if (!A || !B || a === b) return null;
    const k = a + '>' + b; let l = M.lane.get(k);
    if (!l) {
      l = { key: k, a: A, b: B, n: 0, lastAt: -1e15, wallAt: -1e9, h: 0, home: null, pts: null, len: 1, path: null, w: 1, busy: 0, pair: null, sel: true, spoke: false, live: false, fresh: true };
      M.lane.set(k, l); M.lanes.push(l); A.links.push(l); B.links.push(l);
      const pk = [a, b].sort().join('~'); let p = M.pair.get(pk);
      if (!p) { p = { key: pk, lanes: [], a: l.a, b: l.b, mx: 0, my: 0, btn: null }; M.pair.set(pk, p); M.pairs.push(p); }
      p.lanes.push(l); l.pair = p; lanesNew = true;
    }
    return l;
  }
  function removePart(p) {
    for (const l of p.links.slice()) {
      M.lane.delete(l.key); M.lanes.splice(M.lanes.indexOf(l), 1);
      const o = l.a === p ? l.b : l.a; o.links.splice(o.links.indexOf(l), 1);
      const pr = l.pair; pr.lanes.splice(pr.lanes.indexOf(l), 1);
      if (!pr.lanes.length) { M.pair.delete(pr.key); M.pairs.splice(M.pairs.indexOf(pr), 1); if (pr.btn) pr.btn.remove(); if (M.hotPair === pr) M.hotPair = null; if (M.focus === pr) M.focus = null; }
    }
    M.comets = M.comets.filter(c => c.l.a !== p && c.l.b !== p);
    if (p.btn) p.btn.remove(); if (p.row) p.row.li.remove();
    active.delete(p); if (press && press.p === p) press = null;
    if (M.hotSeat === p) M.hotSeat = null; if (M.focus === p) M.focus = null;
    M.parts.delete(p.id);
  }
  function resetModel() {
    for (const p of [...M.parts.values()]) removePart(p);
    M.list = []; M.lanes = []; M.lane.clear(); M.pairs = []; M.pair.clear(); M.comets = []; M.waits = []; M.allWaits = []; M.said = []; M.msgs = []; M.seen.clear(); M.hubIds.clear();
    M.older = { n: 0, oldest: null }; M.hotPair = M.hotSeat = M.focus = M.readout = null; M.dropped = 0; M.hourN = 0;
    E.mode = 'wait'; E.q = []; E.i = 0; E.started = false; E.stale = false; E.everOk = false;
    C.samples.clear(); C.history = null; C.sampled0 = 0; C.hasTokens = false;
    labels.textContent = ''; D.roster.textContent = ''; L.laid = false;
  }

  /* ---------------------------------------------------------------- data in */
  let lanesNew = false, listsDirty = true, tablesDirty = true, textDirty = true, bgDirty = true, chartDirty = true, tokDirty = false, radiiDirty = false;
  function update(snap) {
    if (destroyed || !snap) return;
    const src = snap.source || { kind: 'live', label: '', ok: true };
    if (src.ok === false) {
      if (!E.stale) E.frozen = clockNow();
      E.stale = true; E.error = src.error || 'The source could not refresh.'; if (!E.kind) { E.kind = src.kind || 'live'; E.label = src.label || ''; }
      // the last picture stays. Only when there is none yet does whatever came with the failed refresh get drawn
      if (E.started || !(snap.participants && snap.participants.length)) { renderChrome(); lastStatus = ''; renderStatus(); listsDirty = true; wake(); return; }
      E.frozen = snap.now;
    } else { if (E.stale) listsDirty = true; E.stale = false; }
    const sig = src.kind + '|' + src.label;
    const first = !E.started || sig !== E.sig || snap.now < E.lastNow - 1000;   // a new source, or a replay that started again
    if (first) { const st = E.stale, er = E.error, fr = E.frozen; resetModel(); E.stale = st; E.error = er; E.frozen = fr; }
    E.started = true; if (!E.stale) E.everOk = true; E.sig = sig; E.kind = src.kind; E.label = src.label || ''; E.progress = typeof src.progress === 'number' ? clamp(src.progress, 0, 1) : null;
    E.speed = src.speed > 0 ? src.speed : 1; E.fast = E.speed > FAST;
    E.lastNow = snap.now; E.base = snap.now; E.baseWall = performance.now();
    const lim = snap.contextLimit || O.contextLimit || 150000; if (lim !== E.limit) { E.limit = lim; renderKey(); }
    const structural = syncParts(snap);

    // messages: told apart by id. One not seen before travels as a comet if it is recent, otherwise it is applied quietly
    const fresh = []; let resent = false;
    for (const m of snap.messages || []) {
      if (M.seen.has(m.id)) { resent = true; continue; } M.seen.add(m.id);
      const e = { id: m.id, at: m.at, from: m.from, to: m.to, hub: M.hubIds.has(m.from), ask: !!m.ask, ticket: m.ticket || null, text: m.text || '' };
      if (M.msgs.length && e.at < M.msgs[M.msgs.length - 1].at) { let i = M.msgs.length; while (i > 0 && M.msgs[i - 1].at > e.at) i--; M.msgs.splice(i, 0, e); } else M.msgs.push(e);
      count(e, 1); fresh.push(e);
    }
    // a source that sends its whole window again each time also tells us when a message has left that window
    const cut = resent && snap.messages.length ? snap.messages[0].at : -1e18;
    while (M.msgs.length && (M.msgs[0].at < cut || M.msgs.length > 6000)) { const e = M.msgs.shift(); M.seen.delete(e.id); count(e, -1); }
    if (fresh.length) { chartDirty = true; radiiDirty = true; tablesDirty = true; }

    M.allWaits = (snap.waits || []).map(w => ({ id: w.id, from: w.from, to: w.to, since: w.since, followUpAt: w.followUpAt || null, text: w.text || '' }));
    if ((snap.olderWaits || 0) !== M.older.n) listsDirty = true;
    M.older = { n: snap.olderWaits || 0, oldest: snap.olderWaitsOldest || null };
    if (first) E.mode = 'live';   // so that waits are not held back before the mode is known
    syncWaits();
    sampleTokens(snap);
    // places and routes first, so that a message on a link nobody has used before still has a path to travel
    // (a layout that falls due in the middle of a drag waits until the seat is let go)
    if (L.W && (structural || !L.laid)) { if (press && press.started && L.laid) L.pending = true; else layout(); } else if (lanesNew && L.laid) layoutLanes();
    if (first) {
      E.wallTau = 6500;
      if (!E.fast && O.catchUp && !reduced() && !E.stale) {
        E.t0d = snap.now - CATCHUP_MS; E.q = [];
        for (const e of fresh) { if (e.at >= E.t0d) E.q.push(e); else fire(e, true); }
        if (E.q.length) { E.mode = 'catchup'; E.i = 0; E.w0 = T; M.said.length = 0; } else E.mode = 'live';
      } else { for (const e of fresh) fire(e, snap.now - e.at > RECENT_WALL * E.speed); E.mode = E.fast ? 'fast' : 'live'; }
    } else if (E.mode === 'catchup') { for (const e of fresh) E.q.push(e); }
    else for (const e of fresh) fire(e, snap.now - e.at > RECENT_WALL * E.speed);

    if (E.mode === 'catchup') syncWaits();
    // words and lists are written by the slow clock inside the next frame, and only where they changed
    textDirty = true;
    const seats = M.list.filter(p => p.kind === 'seat' || p.kind === 'flight'), ck = [E.stale, E.error, M.list.length, seats.length && seats.every(p => p.state === 'stopped'), M.msgs.length > 0].join('|');
    if (first || ck !== chromeKey) { chromeKey = ck; renderChrome(); lastHouse = -1e9; }
    if (tier === 'still' || first || (!raf && !timer)) wake();   // in the slow tier the next frame is at most a twentieth of a second away
  }
  let chromeKey = '';
  function count(e, d) {
    if (e.hub) { const p = M.parts.get(e.to); if (p) p.hubN += d; return; }
    const l = d > 0 ? need(e.from, e.to) : M.lane.get(e.from + '>' + e.to);
    if (!l) { if (d > 0) M.dropped++; return; }
    l.n += d; l.a.n += d; l.b.n += d;
  }
  function syncParts(snap) {
    let structural = false; const ids = new Set(), order = [];
    for (const sp of snap.participants || []) {
      if (sp.kind === 'hub' || sp.role === 'hub') { M.hubIds.add(sp.id); continue; }
      ids.add(sp.id);
      let p = M.parts.get(sp.id); if (!p) { p = newPart(sp.id); M.parts.set(sp.id, p); structural = true; }
      order.push(p);
      const state = STATES.has(sp.state) ? sp.state : 'unknown', gauge = sp.contextTokens != null && state !== 'stopped' && state !== 'nodata';
      p.name = sp.label || sp.id.toUpperCase(); p.role = sp.role || ''; p.kind = sp.role === 'flight' ? 'flight' : sp.kind || 'seat';
      p.state = state; p.hold = state === 'running' || state === 'idle' ? sp.hold || '' : ''; p.since = sp.stateSince || 0; p.ticket = sp.ticket || null; p.title = sp.ticketTitle || null;
      p.tool = state === 'running' ? shortTool(sp.liveTool) : ''; p.rate = typeof sp.tokensPerMinute === 'number' ? sp.tokensPerMinute : null;
      const ctx0 = p.ctx, lim0 = p.lim; p.ctx = gauge ? sp.contextTokens : 0; p.lim = gauge ? sp.contextLimit || snap.contextLimit || O.contextLimit || 150000 : 0; if (p.ctx !== ctx0 || p.lim !== lim0) bgDirty = true;
      const sig = p.name + '|' + p.role + '|' + p.kind + '|' + (gauge ? 1 : 0) + '|' + state + '|' + p.hold;
      if (sig !== p.sig) { p.sig = sig; structural = true; }
    }
    for (const p of [...M.parts.values()]) if (!ids.has(p.id)) { removePart(p); structural = true; }
    M.tracked = order.some(p => p.state === 'running' || p.state === 'idle' || p.state === 'unknown');
    if (structural || order.length !== M.list.length) { M.list = order; place(); buildDom(); resolveSel(); tablesDirty = true; }
    return structural;
  }
  function place() {   // places come from the fixed table: role, then natural order of id. Never from head-count
    const by = { server: [], web: [], review: [], plan: [], other: [], operator: [] }; let helpers = 0, flights = 0;
    for (const p of M.list) {
      if (p.kind === 'flight') { if (flights++) by.other.push(p); else { p.rho = 0; p.th = 0; } }
      else if (p.kind === 'operator') by.operator.push(p);
      else if (p.kind === 'helper') { p.rho = 1.386; p.th = 315; p.slot = helpers++; }
      else (by[p.role] || by.other).push(p);
    }
    for (const role in by) by[role].sort((a, b) => natural(a.id, b.id)).forEach((p, i) => { const t = SLOTS[role], s = t[Math.min(i, t.length - 1)]; p.th = (s[0] + (i >= t.length ? (i - t.length + 1) * OVERFLOW_STEP : 0)) % 360; p.rho = s[1]; });
    for (const p of M.list) p.phase = (p.th * 7 % 360) / 57.3;
  }
  function syncWaits() {
    const clock = dataClock(), out = [];
    for (const w of M.allWaits) { if (E.mode === 'catchup' && w.since > clock) continue; if (!need(w.from, w.to)) continue; out.push(w); }
    if (out.length !== M.waits.length || out.some((w, i) => M.waits[i].id !== w.id || M.waits[i].followUpAt !== w.followUpAt)) { listsDirty = tablesDirty = true; }
    M.waits = out;
  }

  /* ---------------------------------------------------------------- engine: what fires when */
  function tick() {
    if (E.mode !== 'catchup') return;
    const f = (T - E.w0) / CATCHUP_WALL, clock = E.t0d + Math.min(1, f) * CATCHUP_MS;
    while (E.i < E.q.length && (E.q[E.i].at <= clock || f >= 1)) fire(E.q[E.i++]);
    if (f >= 1) { E.mode = 'live'; E.q = []; syncWaits(); if (lanesNew && L.laid) layoutLanes(); listsDirty = true; lastStatus = ''; }
  }
  const dataClock = () => E.mode === 'catchup' ? E.t0d + clamp((T - E.w0) / CATCHUP_WALL, 0, 1) * CATCHUP_MS : clockNow();
  function fire(e, quiet) {
    const to = M.parts.get(e.to);
    if (e.hub) { if (!to) return; if (!quiet && !reduced() && O.hubNotices) to.hubRings.push(T); say(e); return; }
    const l = M.lane.get(e.from + '>' + e.to); if (!l) return;
    l.a.sent.push(e.at); if (l.a.sent.length > 40) l.a.sent.shift();
    say(e);
    if (quiet || halted || reduced() || !L.laid || !l.pts) { land(l, e, true); return; }
    const t0 = Math.max(T, l.busy); l.busy = t0 + 160;
    M.comets.push({ l, t0, dur: clamp(520 + l.len * 2.1 / Math.sqrt(L.s), 650, 1900) * (E.mode === 'catchup' ? .7 : 1), e });
    wake();
  }
  function land(l, e, quiet) {
    if (e.at > l.lastAt) l.lastAt = e.at;
    if (quiet) { if (reduced() && E.fast) l.wallAt = T; return; }
    cutWarm(); l.wallAt = T; l.b.flash = 1; l.b.rings.push({ t0: T, col: l.a.color }); if (l.b.rings.length > 4) l.b.rings.shift();
  }
  function say(e) { M.said.unshift(e); if (M.said.length > 14) M.said.length = 14; listsDirty = chartDirty = true; }
  // afterglow: by the data clock when it runs in real time (live, catch-up), by the wall clock in a replay at speed
  const heatOf = (l, clock) => { if (l.lastAt < M.warmCut) return 0; if (!E.fast) { const a = (clock - l.lastAt) / WARM_MS; return a >= 1 ? 0 : a <= 0 ? (l.lastAt > clock + 1000 ? 0 : 1) : Math.pow(1 - a, 2.2); } const hw = 1 - (T - l.wallAt) / E.wallTau; return hw > 0 ? Math.pow(hw, 1.4) : 0; };
  function cutWarm() {   // only the most recently used links are drawn warm: 8 on the small map, 24 on the big one
    const K = L.compact ? 8 : 24; if (M.lanes.length <= K) { M.warmCut = -1e18; return; } M.warmCut = M.lanes.map(l => l.lastAt).sort((a, b) => b - a)[K - 1];
  }

  /* ---------------------------------------------------------------- layout: polar, fixed bearings */
  const polar = (rho, deg) => { const a = deg * Math.PI / 180; return { x: L.cx + L.rx * rho * Math.sin(a), y: L.cy - L.ry * rho * Math.cos(a) }; };
  const radius = (p, nmax) => L.s * (4.4 + 10.6 * Math.sqrt(p.n / nmax)) * (p.kind === 'flight' ? 1.08 : 1);
  function layout() {
    const W = L.W, H = L.H; if (W < 50 || H < 50 || destroyed) return; const t0 = performance.now();
    L.compact = W < 620; L.dense = L.compact && M.list.filter(p => p.kind === 'seat').length > 12;
    const padX = L.compact ? 62 : 104, padT = L.compact ? 34 : 78, padB = L.compact ? 36 : 76;
    L.ry = (H - padT - padB) / 2; L.rx = Math.min((W - 2 * padX) / 2, L.ry * 2.1); L.cx = W / 2; L.cy = padT + L.ry;   // the ellipse stretches to use a wide stage
    L.s = clamp(L.ry / 150, .9, 2.4); L.fs = L.compact ? 11 : Math.round(clamp(9.5 + L.s * 2, 12, 15)); L.fs2 = Math.max(11, L.fs - 2);
    L.fm = L.compact ? 9 : 14; L.fTop = Math.max(L.fm, L.cy - L.ry - 24); L.fSide = L.compact ? padX - L.fm : 30 + 14 * L.s; L.flowDash = [.1, 11 * Math.min(L.s, 1.5)];
    root.style.setProperty('--cm-lab', L.fs + 'px'); root.style.setProperty('--cm-lab2', L.fs2 + 'px');
    const nmax = Math.max(12, ...M.list.map(p => p.n)), pv = pins[S.view] || {}, clock = clockNow();   // how long a seat has been in its state is told by the real clock, also while the last hour is catching up
    for (const p of M.list) {
      const q = p.kind === 'helper' ? { x: L.cx - L.rx * (L.compact ? 1 : .98), y: L.cy - L.ry * (L.compact ? .9 : .98) + (p.slot || 0) * 46 * L.s } : polar(p.rho, p.th);
      p.hx = q.x; p.hy = q.y; p.rT = radius(p, nmax); if (!p.r) p.r = p.rT;
      const pin = pv[p.id]; p.tx = pin ? L.cx + pin[0] * L.rx - p.hx : 0; p.ty = pin ? L.cy + pin[1] * L.ry - p.hy : 0;
      if (!active.has(p)) { p.ox = p.tx; p.oy = p.ty; p.vx = p.vy = 0; }
      p.x = p.hx + p.ox; p.y = p.hy + p.oy;
      // a crowded small map folds what it can: short names, and no name on a stopped seat (its place and its readout stay)
      p.disp = L.dense && p.kind === 'seat' && p.name.includes('-') ? p.name[0] + p.name.slice(p.name.indexOf('-')) : p.name; p.nolab = L.dense && p.state === 'stopped';
      p.ctxTxt = ctxShort(p); p.sub = subOf(p, clock);
    }
    for (const l of M.lanes) { l.spoke = l.a.kind === 'flight' || l.b.kind === 'flight'; if (l.spoke) laneGeom(l); }
    placeLabels();   // names are placed clear of the spokes; then every other link picks the route that crosses the fewest names
    for (const l of M.lanes) if (!l.spoke) laneGeom(l);
    lanesNew = false; L.laid = true; L.at = T;
    buildPairDom(); pairMids(); cutWarm(); placeDom(); bgDirty = true; radiiDirty = false; stageRect = null; L.n++; L.cost = performance.now() - t0; wake();
  }
  function layoutLanes() {   // links that appeared since the last layout: only they are routed
    for (const l of M.lanes) if (l.fresh) { l.spoke = l.a.kind === 'flight' || l.b.kind === 'flight'; laneGeom(l); }
    lanesNew = false; buildPairDom(); pairMids(); cutWarm(); bgDirty = true; tablesDirty = true;
  }
  function pairMids() {
    for (const p of M.pairs) { const l = p.lanes[0], i = (NPT >> 1) * 2; if (!l || !l.pts) continue; let x = l.pts[i], y = l.pts[i + 1]; if (p.lanes[1] && p.lanes[1].pts) { x = (x + p.lanes[1].pts[i]) / 2; y = (y + p.lanes[1].pts[i + 1]) / 2; } p.mx = x; p.my = y;
      if (p.btn) { p.btn.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`; } }
  }
  function laneGeom(l) {   // the route between two home places. A seat that is away from home stretches it (laneWarp)
    const A = l.a, B = l.b; let pts;
    if (l.spoke) {
      // a spoke: a gentle bow to the left of travel, so out and back make a lens and never share a line
      pts = new Float32Array((NPT + 1) * 2);
      const dx = B.hx - A.hx, dy = B.hy - A.hy, len = Math.hypot(dx, dy) || 1, o = Math.min(22 * L.s, len * .12);
      quad(pts, A, (A.hx + B.hx) / 2 - dy / len * o, (A.hy + B.hy) / 2 + dx / len * o, B);
    } else {
      let bestBad = 1e9;
      (A.kind === 'helper' || B.kind === 'helper' ? [0, .3, -.3, .6] : [0, .14, .26, -.12]).forEach((extra, ci) => {
        const q = new Float32Array((NPT + 1) * 2); route(l, extra, q); const bad = ci * 1.5 + crossings(q, l); if (bad < bestBad) { bestBad = bad; pts = q; } });
    }
    l.home = pts; l.pts = new Float32Array(pts.length); l.fresh = false; l.w = Math.min(L.s, 1.5) * (.8 + Math.min(1.4, Math.sqrt(l.n) * .22));
    laneWarp(l);
  }
  function laneWarp(l) {   // cheap: 41 points, each the home route shifted by a blend of the two ends' offsets
    const h = l.home, p = l.pts, ax = l.a.ox, ay = l.a.oy, bx = l.b.ox, by = l.b.oy, path = new Path2D(); let len = 0;
    for (let i = 0; i <= NPT; i++) { const u = i / NPT, v = 1 - u; p[i * 2] = h[i * 2] + ax * v + bx * u; p[i * 2 + 1] = h[i * 2 + 1] + ay * v + by * u;
      if (i) { path.lineTo(p[i * 2], p[i * 2 + 1]); len += Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1]); } else path.moveTo(p[0], p[1]); }
    l.path = path; l.len = len || 1;
  }
  function quad(pts, A, cx, cy, B) { for (let i = 0; i <= NPT; i++) { const u = i / NPT, v = 1 - u; pts[i * 2] = v * v * A.hx + 2 * v * u * cx + u * u * B.hx; pts[i * 2 + 1] = v * v * A.hy + 2 * v * u * cy + u * u * B.hy; } }
  function route(l, extra, pts) {
    const A = l.a, B = l.b;
    if (A.kind === 'helper' || B.kind === 'helper') {   // the outside helper reaches a seat by a long curve round the rim
      const S0 = A.kind === 'helper' ? B : A, d = ((S0.th - 315 + 540) % 360) - 180, c = polar(.92 + .42 * Math.abs(d) / 180 + (A.kind === 'helper' ? .05 : -.05) + extra, 315 + d / 2);
      quad(pts, A, c.x, c.y, B); return;
    }
    // seat to seat: a transfer orbit. It sweeps round FLIGHT the short way and bulges outward, so it can never be taken for a spoke
    const d = ((B.th - A.th + 540) % 360) - 180, span = Math.abs(d); let hsh = 0; for (const ch of l.pair.key) hsh = (hsh * 31 + ch.charCodeAt(0)) % 997;
    const k = (Math.min(A.rho, B.rho) >= .5 ? .05 + .09 * Math.min(1, span / 90) : 0) + (d >= 0 ? 1 : -1) * .03 + (hsh % 7 - 3) * .012 + extra, cap = 1.05 + Math.max(0, extra);
    for (let i = 0; i <= NPT; i++) { const u = i / NPT, e = u * u * (3 - 2 * u); const q = polar(Math.min(cap, A.rho + (B.rho - A.rho) * e + k * Math.sin(Math.PI * u)), A.th + d * u); pts[i * 2] = q.x; pts[i * 2 + 1] = q.y; }
  }
  function crossings(pts, l) {   // how much of a route runs over names, over other seats, or off the stage
    let n = 0; const top = L.compact ? 2 : 32;
    for (let i = 2; i < NPT - 1; i++) { const x = pts[i * 2], y = pts[i * 2 + 1]; if (x < 4 || x > L.W - 4 || y < top || y > L.H - 4) { n += 6; continue; }
      for (const p of M.list) { const b = p.lab; if (b && x > b.x - 2 && x < b.x + b.w + 2 && y > b.y - 2 && y < b.y + b.h + 2) n += p === l.a || p === l.b ? 1 : 2; if (p !== l.a && p !== l.b && (x - p.hx) ** 2 + (y - p.hy) ** 2 < (p.rT + 12 * L.s) ** 2) n += 3; } }
    return n;
  }
  function lanePt(l, u, out) { const f = clamp(u, 0, 1) * NPT, i = Math.min(NPT - 1, f | 0), k = f - i, p = l.pts; out.x = p[i * 2] + (p[i * 2 + 2] - p[i * 2]) * k; out.y = p[i * 2 + 1] + (p[i * 2 + 3] - p[i * 2 + 1]) * k; out.a = Math.atan2(p[i * 2 + 3] - p[i * 2 + 1], p[i * 2 + 2] - p[i * 2]); return out; }

  /* ---------------------------------------------------------------- words */
  const ctxOver = p => p.lim > 0 && p.ctx > p.lim;
  const ctxShort = p => !p.lim ? '' : ctxOver(p) ? `${fmtK(p.ctx)}, over ${fmtK(p.lim)}` : fmtK(p.ctx);
  const ctxWords = p => !p.lim ? '' : ctxOver(p) ? `${fmtK(p.ctx)}, over the ${fmtK(p.lim)} working limit` : `${fmtK(p.ctx)} of the ${fmtK(p.lim)} working limit`;
  function subOf(p, clock, brief) {   // the line under a name in the full view, and the state words everywhere else
    if (p.kind === 'operator') return p.state === 'nodata' ? 'you · not in this feed' : 'you';
    if (p.kind === 'helper') return 'outside helper';
    const dur = p.since ? ' ' + fmtAge(clock - p.since) : '', tk = p.ticket ? ' · ' + shortTicket(p.ticket) : '';
    if (p.hold) return p.hold + dur + tk;
    if (p.state === 'running') return 'working' + dur + tk + (p.tool && !brief ? ' · running ' + p.tool : '');
    if (p.state === 'idle') return 'idle' + dur + tk;
    if (p.state === 'stopped') return 'stopped';
    if (p.state === 'nodata') return 'not in this feed';
    return p.kind === 'flight' ? 'head agent' : ROLE_WORD[p.role] || '';
  }
  function stateWords(p, clock) {
    if (p.state === 'nodata') return p.kind === 'operator' ? 'none of the operator’s messages are in this feed, so nothing is drawn; that does not mean nothing was said' : 'not in this feed';
    if (p.state === 'unknown') return 'this feed does not carry its state';
    return subOf(p, clock);
  }
  const pairWords = pr => pr.lanes.map(l => `${l.a.name} to ${l.b.name}: ${plural(l.n, 'message')}${l.lastAt > 0 ? ', last ' + fmtHM(l.lastAt) : ''}`).join('. ');
  function placeLabels() {
    const W = L.W, H = L.H, fs = L.fs, cw = fs * .6 + .25, cw2 = L.fs2 * .6 + .15, obs = [];
    for (const p of M.list) obs.push({ x0: p.hx - p.rT - 2, y0: p.hy - p.rT - 2, x1: p.hx + p.rT + 2, y1: p.hy + p.rT + 2, own: p });
    const fz = L.compact ? 7 : 12, sx = L.rx + L.fSide;   // frame labels: role names on the four sides
    obs.push({ x0: L.cx - 44, y0: L.fTop - fz, x1: L.cx + 44, y1: L.fTop + fz }, { x0: L.cx - 44, y0: H - L.fm - fz, x1: L.cx + 44, y1: H }, { x0: L.cx - sx - fz, y0: L.cy - 44, x1: L.cx - sx + fz, y1: L.cy + 44 }, { x0: L.cx + sx - fz, y0: L.cy - 44, x1: L.cx + sx + fz, y1: L.cy + 44 });
    if (!L.compact) obs.push({ x0: 0, y0: 0, x1: W, y1: 32 });   // the readout strip lies over the top of the big stage
    const spokes = M.lanes.filter(l => l.spoke && l.home);
    const order = [...M.list].sort((a, b) => (a.kind === 'flight' ? -1 : 0) - (b.kind === 'flight' ? -1 : 0) || b.rho - a.rho || a.th - b.th);
    for (const p of order) {
      if (p.nolab) { p.lab = null; continue; }
      const two = !L.compact && p.sub, seat = p.kind === 'seat' || p.kind === 'flight', l1 = p.disp.length * cw + (!L.compact && p.ctxTxt ? p.ctxTxt.length * cw2 + 10 : 0);
      // a working seat keeps room for "· running <tool>", which comes and goes without a new layout
      const subLen = p.sub.length + (p.state === 'running' && !p.tool ? 14 : 0);
      const w = Math.max(l1, two ? Math.max(subLen + 1, seat ? 16 : 0) * cw2 : 0) + 9, wNow = Math.max(l1, two ? Math.max(p.sub.length + 1, seat ? 16 : 0) * cw2 : 0) + 9, h = L.compact ? 15 : two ? fs + L.fs2 + 9 : fs + 5;
      const g = (seat ? (p.lim ? 12.5 : 8) : 5) * L.s, d = p.rT * .72;   // a seat with a context gauge keeps its name outside the gauge
      const x = p.hx, y = p.hy, r = p.rT;
      const cands = w => ({ E: [x + r + g, y - h / 2], W: [x - r - g - w, y - h / 2], N: [x - w / 2, y - r - g - h], S: [x - w / 2, y + r + g],
        NE: [x + d + g * .6, y - d - g * .6 - h], SE: [x + d + g * .6, y + d + g * .6], NW: [x - d - g * .6 - w, y - d - g * .6 - h], SW: [x - d - g * .6 - w, y + d + g * .6] }), c = cands(w);
      const nx = (x - L.cx) / L.rx, ny = (y - L.cy) / L.ry, e = nx >= 0;
      const pref = p.kind === 'flight' ? ['S', 'SE', 'SW', 'N', 'NE', 'NW', 'E', 'W'] : p.kind === 'helper' ? ['N', 'S', 'E', 'SE'] : Math.abs(nx) >= Math.abs(ny) * .9 ? (e ? ['E', 'NE', 'SE', 'N', 'S', 'W'] : ['W', 'NW', 'SW', 'N', 'S', 'E'])
        : ny < 0 ? (e ? ['N', 'NE', 'E', 'NW', 'W', 'S'] : ['N', 'NW', 'W', 'NE', 'E', 'S']) : (e ? ['S', 'SE', 'E', 'SW', 'W', 'N'] : ['S', 'SW', 'W', 'SE', 'E', 'N']);
      let best = null, bestBad = 1e9;
      const badAt = (x0, y0, w) => {
        const x1 = x0 + w, y1 = y0 + h; let bad = 0;
        if (x0 < 2 || y0 < 2 || x1 > W - 2 || y1 > H - 2) bad += 500;
        for (const o of obs) if (o.own !== p && x0 < o.x1 && x1 > o.x0 && y0 < o.y1 && y1 > o.y0) bad += (Math.min(x1, o.x1) - Math.max(x0, o.x0)) * (Math.min(y1, o.y1) - Math.max(y0, o.y0));
        for (const l of spokes) { const q = l.home; for (let i = 2; i <= NPT - 2; i++) { const px = q[i * 2], py = q[i * 2 + 1]; if (px > x0 && px < x1 && py > y0 && py < y1) bad += 30; } }
        return bad;
      };
      const fit = (w, c) => { for (const a of pref) {
        const bad = badAt(c[a][0], c[a][1], w);
        if (bad < bestBad) { bestBad = bad; best = { x: c[a][0], y: c[a][1], w, h, a }; if (!bad) break; }
      } };
      fit(w, c);
      if (bestBad > 0 && wNow < w) { bestBad = 1e9; fit(wNow, cands(wNow)); }
      // still touching a neighbour: try every direction round the seat, a little further out each time, and keep the cleanest
      for (let ring = 1; bestBad > 0 && ring <= 4; ring++) for (let k = 0; k < 16 && bestBad > 0; k++) {
        const ang = k * TAU / 16, cs = Math.cos(ang), sn = Math.sin(ang), dd = r + g + ring * 10 * L.s, cx = x + cs * dd, cy = y + sn * dd;
        const a = (sn < -.35 ? 'N' : sn > .35 ? 'S' : '') + (cs > .35 ? 'E' : cs < -.35 ? 'W' : '') || 'E';
        const x0 = a === 'N' || a === 'S' ? cx - w / 2 : /W/.test(a) ? cx - w : cx, y0 = /N/.test(a) ? cy - h : /S/.test(a) ? cy : cy - h / 2, bad = badAt(x0, y0, w);
        if (bad < bestBad) { bestBad = bad; best = { x: x0, y: y0, w, h, a }; }
      }
      p.lab = best; p.labBad = bestBad; obs.push({ x0: best.x, y0: best.y, x1: best.x + best.w, y1: best.y + h, own: p });
    }
  }

  /* ---------------------------------------------------------------- DOM over the canvas: names, focus targets, tables */
  function buildDom() {
    const had = document.activeElement && labels.contains(document.activeElement) ? document.activeElement.dataset.seat || document.activeElement.dataset.pair : null;
    const order = [...M.list].sort((a, b) => (a.kind === 'flight' ? 0 : a.kind === 'operator' ? 1 : a.kind === 'helper' ? 9 : 2) - (b.kind === 'flight' ? 0 : b.kind === 'operator' ? 1 : b.kind === 'helper' ? 9 : 2) || a.rho - b.rho || a.th - b.th);
    for (const p of order) {
      if (!p.btn) { const b = el('button', 'cm-seat'); b.type = 'button'; b.dataset.seat = p.id; b.tabIndex = -1; b.setAttribute('aria-pressed', 'false');
        const lab = el('span', 'cm-lab'); lab.append(p.name, el('i'), el('small')); b.append(el('span', 'cm-hit'), lab); p.btn = b; }
      labels.append(p.btn);
    }
    buildPairDom();
    D.roster.textContent = '';
    for (const p of M.list) {
      if (p.kind !== 'seat' && p.kind !== 'flight') { p.row = null; continue; }
      const li = el('li'), b = el('button'), g = el('span'), bar = el('span', 'cm-cx'), fill = el('i'); b.type = 'button'; b.dataset.seat = p.id; b.setAttribute('aria-pressed', 'false'); bar.append(fill);
      const nm = el('span', 'cm-nm', p.name), st = el('span', 'cm-st'), cn = el('span', 'cm-cn'); b.append(g, nm, st, bar, cn); li.append(b); D.roster.append(li);
      p.row = { li, b, g, nm, st, bar, fill, cn, gk: '', sk: '', ck: null };
    }
    listsDirty = true;
    if (had) { const b = labels.querySelector(`[data-seat="${CSS.escape(had)}"],[data-pair="${CSS.escape(had)}"]`); if (b) b.focus(); }
    roving();
  }
  function buildPairDom() {
    for (const p of M.pairs) { if (!p.btn) { const b = el('button', 'cm-pair'); b.type = 'button'; b.dataset.pair = p.key; b.tabIndex = -1; const h = el('span', 'cm-hit'); h.style.cssText = 'left:-12px;top:-12px;width:24px;height:24px'; b.append(h); p.btn = b; }
      if (p.btn.parentNode !== labels) labels.append(p.btn); }
    roving();
  }
  function roving() { if (!labels.querySelector('[tabindex="0"]') && labels.firstChild) labels.firstChild.tabIndex = 0; }
  function placeDom() {
    for (const p of M.list) {
      const b = p.btn, h = Math.max(13, p.rT + 5), hit = b.firstChild, lab = b.lastChild;
      b.style.transform = `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px)`;
      hit.style.cssText = `left:${-h}px;top:${-h}px;width:${2 * h}px;height:${2 * h}px`;
      lab.hidden = !p.lab; if (!p.lab) continue;
      const a = p.lab.a, west = /W/.test(a), mid = a === 'N' || a === 'S';   // the box hugs its text; the side nearest the seat is the one that is pinned
      lab.firstChild.nodeValue = p.disp; lab.style.top = (p.lab.y - p.hy).toFixed(1) + 'px'; lab.style.textAlign = west ? 'right' : mid ? 'center' : 'left';
      lab.style.left = west ? 'auto' : (p.lab.x + (mid ? p.lab.w / 2 : 0) - p.hx).toFixed(1) + 'px'; lab.style.right = west ? (p.hx - p.lab.x - p.lab.w).toFixed(1) + 'px' : 'auto'; lab.style.transform = mid ? 'translateX(-50%)' : 'none';
    }
    textDirty = true; refreshText();
  }
  function refreshText() {   // names, state lines and the Seats list: only what changed is written
    if (!textDirty) return; textDirty = false;
    const clock = clockNow();
    for (const p of M.list) {
      p.sub = subOf(p, clock); p.ctxTxt = ctxShort(p);
      const b = p.btn; if (!b) continue; const lab = b.lastChild, cls = 'cm-seat cm-is-' + p.state + (p.hold ? ' cm-is-hold' : '') + (ctxOver(p) ? ' cm-is-over' : '') + (active.has(p) ? ' cm-is-moving' : '');
      if (b.className !== cls) b.className = cls;
      if (lab.children[0].textContent !== p.ctxTxt) lab.children[0].textContent = p.ctxTxt;
      if (lab.lastChild.textContent !== p.sub) lab.lastChild.textContent = p.sub;
      const al = `${p.name}, ${ROLE_WORD[p.role] || 'seat'}, ${stateWords(p, clock)}. ${p.lim ? 'Context ' + ctxWords(p) + '. ' : ''}${plural(p.n, 'message')} in the feed. Enter opens its messages.`;
      if (p.al !== al) { p.al = al; b.setAttribute('aria-label', al); }
    }
    for (const pr of M.pairs) { const al = `Link ${pr.a.name} and ${pr.b.name}. ${pairWords(pr)}. Enter opens the conversation.`; if (pr.al !== al && pr.btn) { pr.al = al; pr.btn.setAttribute('aria-label', al); } }
    refreshRoster();
  }
  function refreshRoster() {
    const clock = clockNow();
    for (const p of M.list) {
      const r = p.row; if (!r) continue;
      const gk = (p.hold ? 'hold' : p.state) + p.color; if (r.gk !== gk) { r.gk = gk; r.g.innerHTML = GLYPH[p.hold ? 'hold' : p.state](p.color); }
      const sk = subOf(p, clock, true) || stateWords(p, clock); if (r.sk !== sk) { r.sk = sk; r.st.textContent = sk; r.st.title = sk + (p.title ? ' · ' + p.title : ''); }
      const al = p.name + ', ' + sk + (p.lim ? ', context ' + ctxWords(p) : ''); if (r.al !== al) { r.al = al; r.b.setAttribute('aria-label', al); }
      const ck = p.lim ? p.ctx + '/' + p.lim : ''; if (r.ck !== ck) { r.ck = ck;
        if (p.lim) { r.bar.style.visibility = ''; r.bar.className = 'cm-cx' + (ctxOver(p) ? ' cm-is-over' : ''); r.fill.style.width = Math.max(4, Math.round(100 * Math.min(1, p.ctx / p.lim))) + '%'; r.bar.title = 'Context ' + ctxWords(p); r.cn.textContent = ctxShort(p); r.cn.title = ''; }
        else { r.bar.style.visibility = 'hidden'; r.cn.textContent = '—'; r.cn.title = p.state === 'stopped' ? 'A stopped seat holds no context.' : 'This feed does not carry the seat’s context.'; } }
    }
  }
  let lastTables = -1e9;
  function buildTables() {
    const box = D.tables, clock = dataClock(), sclock = clockNow(); box.textContent = '';
    const head = (t, cols) => { const r = t.insertRow(); for (const c of cols) { const th = el('th', '', c); th.scope = 'col'; r.append(th); } };
    const t1 = el('table'); t1.append(el('caption', '', 'Seats and their state')); head(t1, ['Seat', 'Role', 'State', 'Messages in the feed', 'Hub notices', 'Owes a reply to', 'Context']);
    for (const p of M.list) { const r = t1.insertRow(); const owes = M.waits.filter(w => w.to === p.id).map(w => (M.parts.get(w.from) || { name: w.from }).name + ' (' + fmtAge(clock - w.since) + ')').join(', ');
      const th = el('th', '', p.name); th.scope = 'row'; r.append(th);
      for (const v of [ROLE_WORD[p.role] || '', stateWords(p, sclock), p.n, p.hubN, owes || 'nobody', ctxWords(p) || 'not known']) r.insertCell().textContent = v; }
    const t2 = el('table'); t2.append(el('caption', '', 'Who wrote to whom')); head(t2, ['From', 'To', 'Messages', 'Last', 'Waiting on a reply']);
    for (const l of M.lanes) { const r = t2.insertRow(); const w = M.waits.filter(w => w.from === l.a.id && w.to === l.b.id).length;
      for (const v of [l.a.name, l.b.name, l.n, l.lastAt > 0 ? fmtDHM(l.lastAt) : 'not in the feed', w ? l.a.name + ' waits on ' + l.b.name + (w > 1 ? ' (' + w + ' asks)' : '') : 'no']) r.insertCell().textContent = v; }
    box.append(t1, t2);
    if (M.older.n) box.append(el('p', '', `${plural(M.older.n, 'older ask')}${M.older.oldest ? ', the oldest ' + fmtAge(clock - M.older.oldest) + ' old,' : ''} not shown as waiting.`));
    if (O.chart && C.m0) { const t3 = el('table'); t3.append(el('caption', '', 'The last 60 minutes, minute by minute')); head(t3, ['Minute', 'Messages', 'Crew tokens']);
      for (let i = 0; i < 60; i++) { if (!C.bars[i] && !(C.tok[i] >= 0)) continue; const r = t3.insertRow(); for (const v of [fmtHM((C.m0 + i) * MIN), C.bars[i], C.tok[i] >= 0 ? Math.round(C.tok[i]) : 'not known']) r.insertCell().textContent = v; }
      box.append(t3); }
    tablesDirty = false; lastTables = T;
  }

  /* ---------------------------------------------------------------- sprites: every glow is drawn once, then stamped */
  const sprites = new Map();
  function sprite(key, make) { let s = sprites.get(key); if (!s) { s = document.createElement('canvas'); s.width = s.height = 128; make(s.getContext('2d')); sprites.set(key, s); } return s; }
  const glowS = col => sprite('g' + col, g => { const r = g.createRadialGradient(64, 64, 0, 64, 64, 64); r.addColorStop(0, rgba(col, 1)); r.addColorStop(.16, rgba(col, .6)); r.addColorStop(.42, rgba(col, .19)); r.addColorStop(.72, rgba(col, .05)); r.addColorStop(1, rgba(col, 0)); g.fillStyle = r; g.fillRect(0, 0, 128, 128); });
  const coreS = col => sprite('c' + col, g => { const r = g.createRadialGradient(64, 64, 0, 64, 64, 64); r.addColorStop(0, '#fff'); r.addColorStop(.26, '#fff'); r.addColorStop(.5, rgba(col, 1)); r.addColorStop(.72, rgba(col, .5)); r.addColorStop(1, rgba(col, 0)); g.fillStyle = r; g.fillRect(0, 0, 128, 128); });
  const streakS = col => sprite('s' + col, g => { const r = g.createRadialGradient(64, 64, 0, 64, 64, 64); r.addColorStop(0, rgba(col, .9)); r.addColorStop(.3, rgba(col, .3)); r.addColorStop(1, rgba(col, 0)); g.fillStyle = r; g.fillRect(0, 0, 128, 128); });
  function blit(c, sp, x, y, R, a) { if (a <= 0.004) return; c.globalAlpha = a > 1 ? 1 : a; c.drawImage(sp, x - R, y - R, R * 2, R * 2); }
  function blit2(c, sp, x, y, RX, RY, a) { c.globalAlpha = a > 1 ? 1 : a; c.drawImage(sp, x - RX, y - RY, RX * 2, RY * 2); }
  let sweepCv = null;
  function sweepSprite() {   // the fading wedge behind the sweep line, painted once
    if (sweepCv) return sweepCv; const cv = document.createElement('canvas'); cv.width = cv.height = 512; const g = cv.getContext('2d');
    if (g.createConicGradient) { const cg = g.createConicGradient(0, 256, 256); cg.addColorStop(0, 'rgba(120,180,255,0)'); cg.addColorStop(.87, 'rgba(120,180,255,0)'); cg.addColorStop(1, 'rgba(120,180,255,.16)'); g.fillStyle = cg; g.fillRect(0, 0, 512, 512);
      const rg = g.createRadialGradient(256, 256, 0, 256, 256, 256); rg.addColorStop(0, '#000'); rg.addColorStop(.86, '#000'); rg.addColorStop(1, 'rgba(0,0,0,0)'); g.globalCompositeOperation = 'destination-in'; g.fillStyle = rg; g.fillRect(0, 0, 512, 512); }
    return sweepCv = cv;
  }

  /* ---------------------------------------------------------------- static backdrop: painted once per layout, selection or move, never per frame */
  function ell(c, rho, a0, a1) { c.beginPath(); c.ellipse(L.cx, L.cy, L.rx * rho, L.ry * rho, 0, (a0 - 90) * Math.PI / 180, (a1 - 90) * Math.PI / 180); c.stroke(); }
  const coldAlpha = (l, sel) => (.07 + Math.min(.1, Math.sqrt(l.n) * .022)) * (sel && !l.sel ? .3 : 1) * (l.spoke ? 1 : 1.5);
  function drawBg() {
    bgDirty = false; if (!L.laid) return;
    const c = bg, W = L.W, H = L.H; c.setTransform(L.dpr, 0, 0, L.dpr, 0, 0); c.clearRect(0, 0, W, H);
    // range rings: the orbits. A dashed fourth appears when a second developer lane is in use
    c.lineWidth = 1; c.strokeStyle = 'rgba(120,150,210,.13)';
    for (const rho of [ORB.op, ORB.dev, ORB.out]) ell(c, rho, 0, 360);
    if (M.list.some(p => p.rho === ORB.dev2)) { c.setLineDash([2, 5]); ell(c, ORB.dev2, 0, 360); c.setLineDash([]); }
    // bearing ticks on the outer ring: every 10 degrees, longer every 30
    c.strokeStyle = 'rgb(140,170,225)';
    for (let b = 0; b < 360; b += 10) { const major = b % 30 === 0, a = polar(ORB.out, b), z = polar(ORB.out + (major ? .04 : .018), b); c.globalAlpha = major ? .42 : .2; c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(z.x, z.y); c.stroke(); }
    c.globalAlpha = 1;
    // the arc a role owns is drawn a little brighter
    c.strokeStyle = 'rgba(140,175,235,.26)'; c.lineWidth = 1.5 * Math.min(1.4, L.s);
    ell(c, ORB.dev, 50, 157); ell(c, ORB.dev, 203, 310); ell(c, ORB.out, 322, 418); ell(c, ORB.out, 158, 202);
    c.fillStyle = 'rgba(131,145,173,.85)'; c.font = '500 11px "IBM Plex Mono", ui-monospace, monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
    try { c.letterSpacing = '2px'; } catch (e) {}
    c.fillText('REVIEW', L.cx, L.fTop); c.fillText('PLAN', L.cx, H - L.fm + (L.compact ? 1 : 0));
    c.save(); c.translate(L.cx + L.rx + L.fSide, L.cy); c.rotate(Math.PI / 2); c.fillText('SERVER', 0, 0); c.restore();
    c.save(); c.translate(L.cx - L.rx - L.fSide, L.cy); c.rotate(-Math.PI / 2); c.fillText('WEB', 0, 0); c.restore();
    try { c.letterSpacing = '0px'; } catch (e) {}
    // cold links: every pair that has spoken, faint, in the sender's colour. A link whose seat is on the move is drawn per frame instead
    c.globalCompositeOperation = 'lighter';
    const sel = M.selSeat || M.selPair;
    for (const l of M.lanes) { if (!l.n || l.live || !l.path) continue; c.strokeStyle = l.a.color; c.globalAlpha = coldAlpha(l, sel); c.lineWidth = l.spoke ? 1 : 1.3; c.stroke(l.path); }
    for (const p of M.list) if (p.lim && !active.has(p) && p.r === p.rT) gauge(c, p, sel && !p.selOn ? .45 : 1);
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  }

  /* ---------------------------------------------------------------- springs: a seat away from its place is pulled back to it */
  const active = new Set();   // seats that are being dragged, are on their way back, or were nudged
  let press = null;           // { p, id, x0, y0, gx, gy, started, touch, hist }
  function activate(p) { if (active.has(p)) return; active.add(p); bgDirty = true; for (const l of p.links) l.live = true; p.btn && p.btn.classList.add('cm-is-moving'); wake(); }
  function physics(dt) {
    if (!active.size) return false;
    const still = reduced(); let h = Math.min(dt, 64) / 1000; const steps = Math.max(1, Math.ceil(h / .008)); h /= steps;
    const dragP = press && press.started ? press.p : null;
    for (let k = 0; k < steps; k++) {
      // a seat that is dragged or flying home pushes the seats it passes aside; they spring back behind it
      if (!still) for (const p of active) { if (!p.mover) continue;
        for (const q of M.list) { if (q === p || q === dragP || q.mover) continue; const dx = q.x - p.x, dy = q.y - p.y, R = p.r + q.r + 14 * L.s, d2 = dx * dx + dy * dy; if (d2 >= R * R) continue;
          const d = Math.sqrt(d2) || 1, f = 1100 * (R - d) * h; q.vx += (d2 ? dx / d : 1) * f; q.vy += (d2 ? dy / d : 0) * f; if (!active.has(q)) activate(q); } }
      for (const p of active) { if (p === dragP) continue;
        if (still) { p.ox = p.tx; p.oy = p.ty; p.vx = p.vy = 0; }
        else { p.vx += (-SPRING_W * SPRING_W * (p.ox - p.tx) - 2 * SPRING_Z * SPRING_W * p.vx) * h; p.vy += (-SPRING_W * SPRING_W * (p.oy - p.ty) - 2 * SPRING_Z * SPRING_W * p.vy) * h; p.ox += p.vx * h; p.oy += p.vy * h; }
        p.x = p.hx + p.ox; p.y = p.hy + p.oy; }
    }
    for (const p of active) {
      if (p !== dragP && Math.abs(p.ox - p.tx) < .3 && Math.abs(p.oy - p.ty) < .3 && Math.abs(p.vx) < 6 && Math.abs(p.vy) < 6) { p.ox = p.tx; p.oy = p.ty; p.vx = p.vy = 0; p.mover = false; p.done = true; }
      p.x = p.hx + p.ox; p.y = p.hy + p.oy; p.btn.style.transform = `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px)`;
      for (const l of p.links) if (l._w !== T) { l._w = T; laneWarp(l); }
    }
    for (const p of [...active]) if (p.done) { p.done = false; active.delete(p); bgDirty = true; p.btn.classList.remove('cm-is-moving'); }
    for (const l of M.lanes) if (l.live && !active.has(l.a) && !active.has(l.b)) { l.live = false; bgDirty = true; }
    if (!active.size) pairMids();
    return true;
  }
  function setPin(p, keep) {
    const pv = pins[S.view];
    if (keep) pv[p.id] = [+((p.x - L.cx) / L.rx).toFixed(4), +((p.y - L.cy) / L.ry).toFixed(4)]; else { if (!pv[p.id]) return; delete pv[p.id]; }
    pinsChanged();
  }
  function pinsChanged() { D.reset.hidden = !Object.keys(pins[S.view] || {}).length; if (O.onPinsChange) O.onPinsChange(getPins()); }
  const getPins = () => ({ panel: { ...pins.panel }, full: { ...pins.full }, ambient: { ...pins.ambient } });
  function resetPlaces() {
    const pv = pins[S.view]; if (!Object.keys(pv).length) return;
    for (const id in pv) { const p = M.parts.get(id); delete pv[id]; if (p) { p.tx = p.ty = 0; p.mover = true; activate(p); } }
    pinsChanged(); showTip(M.selSeat || M.selPair);
  }

  /* ---------------------------------------------------------------- drawing */
  const q = { x: 0, y: 0, a: 0 };
  let turn = 0, flow = 0, warmN = 0, sweepA = 200, lastWall = 0, raf = 0, timer = 0, halted = false, tier = 'fast', quietFrames = 0, lastMin = 0;
  const perf = { cost: new Float32Array(600), n: 0, stamps: [] };
  function frame(wall) {
    raf = 0; if (halted || destroyed) return;
    if (!L.laid) { tier = 'still'; schedule(); return; }
    const c0 = performance.now(), still = reduced() || E.stale;
    const dt = lastWall ? Math.min(1500, wall - lastWall) : 16; lastWall = wall; T += dt;
    tick();
    let moving = physics(dt);
    if (bgDirty) drawBg();
    const clock = dataClock();
    const c = ctx, s = L.s; c.setTransform(L.dpr, 0, 0, L.dpr, 0, 0); c.clearRect(0, 0, L.W, L.H);
    if (M.comets.length || E.mode === 'catchup') moving = true;
    let ambient = false, sweeping = false;
    const sel = M.selSeat || M.selPair;

    // 1. the sweep: one turn in 12 seconds. A seat lights as the line passes it: bright if working, faint if idle, not at all if stopped.
    //    When nothing else moves it is drawn about 20 times a second (see schedule). A compositor animation was tried and cost more
    if (O.sweep && !still && M.tracked) {
      sweeping = true; const prev = sweepA, adv = dt * .03; sweepA = (sweepA + adv) % 360;
      for (const p of M.list) { if (!p.rho) continue; const d = ((p.th - prev) % 360 + 360) % 360; if (d > 0 && d <= adv) p.ping = p.state === 'running' ? 1 : p.state === 'idle' ? .45 : p.state === 'unknown' ? .6 : 0; }
      c.save(); c.translate(L.cx, L.cy); c.scale(L.rx * 1.02 / 256, L.ry * 1.02 / 256); c.rotate((sweepA - 90) * Math.PI / 180); c.drawImage(sweepSprite(), -256, -256); c.restore();
      c.strokeStyle = 'rgb(150,200,255)'; c.globalAlpha = .3; c.lineWidth = 1; c.beginPath(); c.moveTo(L.cx, L.cy); const sa = sweepA * Math.PI / 180; c.lineTo(L.cx + L.rx * 1.02 * Math.sin(sa), L.cy - L.ry * 1.02 * Math.cos(sa)); c.stroke(); c.globalAlpha = 1;
    }

    // 2. links: brightness is how recently a message went that way; the dots drift toward whoever received it
    c.globalCompositeOperation = 'lighter'; c.lineCap = 'round';
    const ls0 = Math.min(s, 1.5), dens = clamp(9 / Math.max(1, warmN), .55, 1), ls = ls0 * dens; let warmNow = 0;
    if (!still) { flow += dt * .016 * ls0; turn += dt * TAU / 7000; }
    for (const l of M.lanes) {
      const tg = heatOf(l, clock); l.h += (tg - l.h) * Math.min(1, dt / 160); if (Math.abs(tg - l.h) > .02) moving = true;
      const hot = l.pair === M.hotPair || l.pair === M.selPair || (M.hotSeat && (l.a === M.hotSeat || l.b === M.hotSeat));
      if (l.live && l.n) { c.strokeStyle = l.a.color; c.globalAlpha = coldAlpha(l, sel); c.lineWidth = l.spoke ? 1 : 1.3; c.stroke(l.path); }
      if (l.h < .012 && !hot) continue;
      const dim = sel && !l.sel ? .25 : 1, h = l.h; if (h > .03) { ambient = true; warmNow++; }
      let pop = 1 - (T - l.wallAt) / 1600; pop = pop > 0 ? pop * pop : 0; if (pop > 0) moving = true;   // the moment of arrival stands above the afterglow
      c.strokeStyle = l.a.color; c.globalAlpha = Math.min(1, (.12 + .62 * h + .3 * pop + (hot ? .3 : 0)) * dim); c.lineWidth = l.w * (1 + (.9 * h + .7 * pop) * dens); c.stroke(l.path);
      if (h > .03) {
        c.setLineDash(L.flowDash); c.lineDashOffset = -flow; c.lineWidth = (1.6 + 1.5 * h + pop) * ls; c.globalAlpha = Math.min(1, (.25 + .65 * h + .3 * pop) * dim); c.stroke(l.path); c.setLineDash(NODASH);
        lanePt(l, 1 - Math.min(.4, (l.b.r + 16 * s) / l.len), q);   // arrowhead just short of the receiver
        const z = (3.6 + 2.6 * h + 1.5 * pop) * ls; c.fillStyle = l.a.color; c.globalAlpha = Math.min(1, (.35 + .5 * h + .3 * pop) * dim);
        c.beginPath(); c.moveTo(q.x + Math.cos(q.a) * z * 1.5, q.y + Math.sin(q.a) * z * 1.5); c.lineTo(q.x + Math.cos(q.a + 2.4) * z, q.y + Math.sin(q.a + 2.4) * z); c.lineTo(q.x + Math.cos(q.a - 2.4) * z, q.y + Math.sin(q.a - 2.4) * z); c.fill();
      }
    }
    warmN = warmNow;

    // 3. messages in flight: one comet each, in the sender's colour
    for (let i = M.comets.length - 1; i >= 0; i--) {
      const m = M.comets[i], u = (T - m.t0) / m.dur; if (u < 0) continue;
      if (u >= 1 || still) { M.comets.splice(i, 1); land(m.l, m.e, still); continue; }
      const e = u * u * (3 - 2 * u), l = m.l, g = glowS(l.a.color), step = 6.5 * s / l.len;
      for (let k = 11; k >= 1; k--) { lanePt(l, e - k * step, q); blit(c, g, q.x, q.y, (10 - k * .72) * s, .5 - k * .04); }
      lanePt(l, e, q); blit(c, g, q.x, q.y, 20 * s, .95); blit(c, coreS(l.a.color), q.x, q.y, 6.5 * s, 1);
      if (m.e.ask) { c.strokeStyle = AMBER; c.globalAlpha = .95; c.lineWidth = 1.6 * s; c.beginPath(); c.arc(q.x, q.y, 8.5 * s, 0, TAU); c.stroke(); }
    }

    // 4. fresh asks: an amber light parked on the asker's lane beside the seat that owes the reply, and an amber ring
    //    round that seat which empties as the hub's own follow-up time comes up
    if (M.waits.length) {
      ambient = true; const beat = still ? .85 : .62 + .3 * Math.sin(T / 420), ga = glowS(AMBER);
      for (const l of M.lanes) l._k = 0;
      for (const w of M.waits) {
        const l = M.lane.get(w.from + '>' + w.to); if (!l || !l.pts) continue; const to = l.b, k = l._k++;
        lanePt(l, 1 - Math.min(.45, (to.r + (27 + k * 11) * s) / l.len), q); blit(c, ga, q.x, q.y, 15 * s, beat); blit(c, coreS(AMBER), q.x, q.y, 4.6 * s, 1);
        if (to._amb !== T) { to._amb = T; const rr = to.r + 15 * s, left = w.followUpAt ? (w.followUpAt - clock) / Math.max(1, w.followUpAt - w.since) : 1;
          c.strokeStyle = AMBER; c.lineWidth = 1 * s; c.globalAlpha = .28; c.beginPath(); c.arc(to.x, to.y, rr, 0, TAU); c.stroke();
          c.lineWidth = 2.2 * s; c.globalAlpha = beat;
          if (left > 0) { c.beginPath(); c.arc(to.x, to.y, rr, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, left)); c.stroke(); }
          else { c.setLineDash([3 * s, 4 * s]); c.beginPath(); c.arc(to.x, to.y, rr, 0, TAU); c.stroke(); c.setLineDash(NODASH); } }
      }
    }

    // 5. seats
    const fade = Math.pow(.955, dt / 16.7), fade2 = Math.pow(.94, dt / 16.7), grow = Math.min(1, dt / 260);
    for (const p of M.list) {
      const col = p.color, g = glowS(col); p.flash *= fade; if (p.flash > .02) moving = true; else p.flash = 0;
      p.ping *= fade2; if (p.ping < .02) p.ping = 0;
      if (p.r !== p.rT) { p.r += (p.rT - p.r) * grow; if (Math.abs(p.rT - p.r) < .05) { p.r = p.rT; bgDirty = true; } moving = true; }
      const r = p.r, dimP = sel && !p.selOn ? .45 : 1, f = p.flash, pg = p.ping;
      if (p.state === 'stopped') {
        // stopped: hollow and dark, and the sweep gets nothing back from it
        blit(c, g, p.x, p.y, r * 3 * f, .5 * f);
        c.globalAlpha = .7 * dimP; c.strokeStyle = '#7d8aa6'; c.lineWidth = 1.3 * s; c.beginPath(); c.arc(p.x, p.y, Math.max(3.4 * s, r * .8), 0, TAU); c.stroke();
      } else if (p.state === 'nodata') {
        // not in this feed: a dashed outline, so it cannot be read as quiet
        blit(c, g, p.x, p.y, r * 3 * f, .5 * f);
        c.globalAlpha = .85 * dimP; c.strokeStyle = col; c.lineWidth = 1.3 * s; c.setLineDash([2.5 * s, 2.5 * s]); c.beginPath(); c.arc(p.x, p.y, r + 1.5 * s, 0, TAU); c.stroke(); c.setLineDash(NODASH);
        blit(c, coreS(col), p.x, p.y, r * .5, .5 * dimP);
      } else {
        const run = p.state === 'running', unk = p.state === 'unknown';
        const breathe = still ? 1 : run ? 1 + .09 * Math.sin(T / 520 + p.phase) : unk ? 1 + .05 * Math.sin(T / 1400 + p.phase) : 1;
        blit(c, g, p.x, p.y, r * ((run ? 3.5 : unk ? 3.2 : 2.5) + f * 2.6 + pg * 1.1) * breathe, ((run ? .26 : unk ? .18 : .1) + f * .5 + pg * .24) * dimP);
        if (p.kind === 'flight') blit2(c, streakS(col), p.x, p.y, r * (5.5 + f * 4) * breathe, r * .5, (.5 + f * .4) * dimP);
        blit(c, coreS(col), p.x, p.y, r * 1.42, (run || unk ? 1 : .8) * dimP);
        if (run) {
          // working: a ring that turns. Every working seat's ring turns at the same speed
          ambient = true; const rr = r + 5.5 * s, a = turn + p.phase; c.strokeStyle = col; c.lineWidth = 1.8 * s; c.globalAlpha = .95 * dimP;
          c.beginPath(); c.arc(p.x, p.y, rr, a, a + 1.75); c.stroke(); c.beginPath(); c.arc(p.x, p.y, rr, a + Math.PI, a + Math.PI + 1.75); c.stroke();
        }
        if (p.hold) { const d = r + 6 * s; c.globalAlpha = .95 * dimP; c.strokeStyle = HOLDCOL; c.lineWidth = 1.8 * s; c.strokeRect(p.x - d, p.y - d, d * 2, d * 2); }
        if (p.kind === 'helper') { c.globalAlpha = .7 * dimP; c.strokeStyle = col; c.lineWidth = 1 * s; const d = r + 5 * s; c.beginPath(); c.moveTo(p.x, p.y - d); c.lineTo(p.x + d, p.y); c.lineTo(p.x, p.y + d); c.lineTo(p.x - d, p.y); c.closePath(); c.stroke(); }
        if (p.lim && (active.has(p) || p.r !== p.rT)) gauge(c, p, dimP);   // at rest, the gauge is part of the backdrop
      }
      for (let i = p.rings.length - 1; i >= 0; i--) { const e = (T - p.rings[i].t0) / 1100; if (e >= 1) { p.rings.splice(i, 1); continue; } moving = true; c.strokeStyle = p.rings[i].col; c.globalAlpha = (1 - e) * .85; c.lineWidth = (2.2 - e * 1.4) * s; c.beginPath(); c.arc(p.x, p.y, r + 4 * s + (1 - (1 - e) * (1 - e)) * 34 * s, 0, TAU); c.stroke(); }
      for (let i = p.hubRings.length - 1; i >= 0; i--) { const e = (T - p.hubRings[i]) / 900; if (e >= 1) { p.hubRings.splice(i, 1); continue; } moving = true; c.strokeStyle = HUBCOL; c.globalAlpha = Math.sin(e * Math.PI) * .8; c.lineWidth = 1.2 * s; c.setLineDash([2 * s, 3 * s]); c.beginPath(); c.arc(p.x, p.y, r + 4 * s + (1 - e) * (1 - e) * 30 * s, 0, TAU); c.stroke(); c.setLineDash(NODASH); }
    }

    // 6. focus and selection marks, drawn on the map itself
    c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
    if (M.selSeat) mark(c, M.selSeat, false); if (M.selPair) markPair(c, M.selPair, false);
    if (M.focus) { if (M.focus.lanes) markPair(c, M.focus, true); else mark(c, M.focus, true); }

    housekeeping(clock);   // bookkeeping that does not need a frame of its own
    const cost = performance.now() - c0; perf.cost[perf.n++ % 600] = cost; perf.stamps.push(wall); if (perf.stamps.length > 240) perf.stamps.shift();
    quietFrames = moving ? 0 : quietFrames + 1;
    tier = still ? 'still' : moving || quietFrames < 3 ? 'fast' : sweeping || ambient ? 'slow' : 'still';
    schedule();
  }
  const NODASH = [];
  function gauge(c, p, dimP) {
    // context: a thin white arc from the top that closes as the context fills. The notch at the top is the working
    // limit. Past it the arc is a full, heavier circle
    const s = L.s, over = p.ctx > p.lim, fr = Math.min(1, p.ctx / p.lim), rg = p.r + 9.5 * s, a0 = -Math.PI / 2;
    c.strokeStyle = '#dbe4f5'; c.lineWidth = 1; c.globalAlpha = .2 * dimP; c.beginPath(); c.arc(p.x, p.y, rg, 0, TAU); c.stroke();
    c.lineWidth = (over ? 2.6 : 1.7) * Math.min(s, 1.6); c.globalAlpha = (over ? 1 : .8) * dimP; c.beginPath(); c.arc(p.x, p.y, rg, a0, a0 + TAU * fr); c.stroke();
    c.lineWidth = 1.2; c.globalAlpha = .9 * dimP; c.beginPath(); c.moveTo(p.x, p.y - rg - 3.5 * s); c.lineTo(p.x, p.y - rg + 3 * s); c.stroke();
  }
  function mark(c, p, focus) { const rr = p.r + 20 * L.s; c.strokeStyle = '#fff'; c.lineWidth = focus ? 2 : 1.2; c.setLineDash(focus ? NODASH : [4, 4]); c.beginPath(); c.arc(p.x, p.y, rr, 0, TAU); c.stroke(); c.setLineDash(NODASH);
    if (focus) { c.lineWidth = 2; for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2 + Math.PI / 4; c.beginPath(); c.moveTo(p.x + Math.cos(a) * (rr + 2), p.y + Math.sin(a) * (rr + 2)); c.lineTo(p.x + Math.cos(a) * (rr + 8), p.y + Math.sin(a) * (rr + 8)); c.stroke(); } } }
  function markPair(c, pr, focus) { c.strokeStyle = '#fff'; c.lineWidth = focus ? 2 : 1.2; c.globalAlpha = focus ? .95 : .7; for (const l of pr.lanes) if (l.path) c.stroke(l.path); c.globalAlpha = 1; if (focus) { c.strokeRect(pr.mx - 9, pr.my - 9, 18, 18); mark(c, pr.a, false); mark(c, pr.b, false); } }
  // every frame only while something travels; about 20 a second while only slow things move (the sweep, rings, drifting dots);
  // once a second when nothing does; never when hidden or off screen
  function schedule() {
    if (halted || destroyed || raf || timer) return;
    if (tier === 'fast') raf = requestAnimationFrame(frame);
    else timer = setTimeout(() => { timer = 0; if (!halted && !destroyed && !raf) raf = requestAnimationFrame(frame); }, tier === 'slow' ? SLOW_MS : 1000);
  }
  function wake() { if (halted || destroyed) return; quietFrames = 0; if (timer) { clearTimeout(timer); timer = 0; } if (!raf) raf = requestAnimationFrame(frame); }
  function halt(v) { if (halted === v) return; halted = v; if (v) { if (raf) cancelAnimationFrame(raf); if (timer) clearTimeout(timer); raf = timer = 0; lastWall = 0; } else { lastWall = 0; wake(); } }
  let visible = !document.hidden, onScreen = true;
  on(document, 'visibilitychange', () => { visible = !document.hidden; halt(!(visible && onScreen)); });
  const io = new IntersectionObserver(es => { onScreen = es[es.length - 1].isIntersecting; halt(!(visible && onScreen)); }); io.observe(stage);
  // a slow clock for things that change by the minute or need a tick when no frame is due
  let lastHouse = -1e9, lastStatus = '', lastTag = '', lastChart = -1e9;
  function housekeeping(clock) {
    if (T - lastHouse < 240) return; lastHouse = T;
    let changed = false;
    for (const p of M.list) { let n = 0; if (!E.fast) for (let i = p.sent.length - 1; i >= 0 && clock - p.sent[i] < FLOOD_WIN; i--) if (p.sent[i] <= clock) n++; if ((n >= FLOOD_N) !== (p.flood >= FLOOD_N) || (n >= FLOOD_N && n !== p.flood)) changed = true; p.flood = n; }
    if (E.mode === 'catchup') syncWaits();
    const mn = Math.floor(clock / MIN); if (mn !== lastMin) { lastMin = mn; changed = true; chartDirty = true; listsDirty = true; }   // "working 4 min" moves by the minute
    if (changed) { textDirty = true; tablesDirty = true; }
    if (radiiDirty && T - L.at > 1500) {   // seats grow with the messages they carry; names and links are placed again only when that has drifted far enough
      radiiDirty = false; const nmax = Math.max(12, ...M.list.map(p => p.n)); let drift = 0;
      for (const p of M.list) { const r = radius(p, nmax); drift = Math.max(drift, Math.abs(r - p.rT)); }
      if (drift > 1.6 * L.s && !active.size && !press) layout();
    }
    refreshText(); if (listsDirty) renderLists(); renderStatus();
    if (lanesNew && L.laid && E.mode !== 'catchup') layoutLanes();
    if ((chartDirty && T - lastChart > 900) || (tokDirty && T - lastChart > 5000) || !C.m0) drawChart();   // bars soon after a message; the token line every 5 seconds
    if (tablesDirty && T - lastTables > 10000) buildTables();   // the hidden tables: rebuilt at most every 10 seconds, so a screen reader is not interrupted
    if (O.perf) { const p = perfStats(); D.perf.textContent = `draw ${p.avg.toFixed(2)} ms avg · ${p.p95.toFixed(2)} p95\n${p.fps} frames/s · ${tier} · ${M.lanes.length} links · dpr ${L.dpr.toFixed(2)}`; }
  }
  function perfStats() { const n = Math.min(perf.n, 600), a = Array.from(perf.cost.subarray(0, n)).sort((x, y) => x - y); const now = performance.now();
    return { n, frames: perf.n, avg: a.reduce((s, v) => s + v, 0) / Math.max(1, n), p95: a[Math.floor(n * .95)] || 0, max: a[n - 1] || 0, fps: perf.stamps.filter(t => t > now - 1000).length, tier, lanes: M.lanes.length, seats: M.list.length, dpr: L.dpr, w: L.W, h: L.H, layouts: L.n, layoutMs: L.cost }; }

  /* ---------------------------------------------------------------- the 60-minute strip (full view only) */
  const C = { bars: new Uint16Array(60), tok: new Float32Array(60).fill(-1), m0: 0, samples: new Map(), history: null, sampled0: 0, hasTokens: false, w: 0, h: 72, dpr: 1, hover: -1, rect: null, feed0: 0 };
  const cx2 = D.chartCv.getContext('2d');
  function sampleTokens(snap) {
    const h = snap.history && Array.isArray(snap.history.tokensPerMinute) ? snap.history.tokensPerMinute : null;
    if (h) { C.history = new Map(); for (const [t, v] of h) C.history.set(Math.floor(t / MIN), v); C.hasTokens = true; tokDirty = true; return; }
    C.history = null; let sum = 0, any = false;
    for (const p of M.list) if (p.rate != null) { sum += p.rate; any = true; }
    if (!any) return;
    const m = Math.floor(snap.now / MIN), s = C.samples.get(m); if (s) { s[0] += sum; s[1]++; } else C.samples.set(m, [sum, 1]);
    if (!C.sampled0) C.sampled0 = snap.now; C.hasTokens = true; tokDirty = true;
    if (C.samples.size > 240) for (const k of C.samples.keys()) { if (k < m - 120) C.samples.delete(k); }
  }
  function sizeChart() {
    if (S.view !== 'full' || !O.chart) return;
    const w = D.chartCv.clientWidth; if (!w) return;   // read when the view or the window changes, never per frame
    C.dpr = Math.min(window.devicePixelRatio || 1, 2); C.w = w; D.chartCv.width = Math.round(w * C.dpr); D.chartCv.height = Math.round(C.h * C.dpr); C.rect = null; chartDirty = true;
  }
  function drawChart() {
    lastChart = T; chartDirty = tokDirty = false;
    const clock = dataClock(), m1 = Math.floor(clock / MIN), m0 = m1 - 59; C.m0 = m0; C.bars.fill(0); let total = 0, peak = 0;
    for (let i = M.msgs.length - 1; i >= 0; i--) { const e = M.msgs[i], m = Math.floor(e.at / MIN); if (m < m0) break; if (m > m1 || e.hub || e.at > clock) continue; const v = ++C.bars[m - m0]; total++; if (v > peak) peak = v; }
    M.hourN = total; C.feed0 = M.msgs.length ? M.msgs[0].at : 0;
    let tPeak = 0, tLast = -1, tN = 0; const part = C.history ? 59 : 60;   // a minute total that is still filling is drawn but not quoted
    for (let i = 0; i < 60; i++) { const m = m0 + i; let v = -1; if (C.history) { if (C.history.has(m)) v = C.history.get(m); } else { const s = C.samples.get(m); if (s) v = s[0] / s[1]; } C.tok[i] = v; if (v >= 0) { tN++; if (i < part || tLast < 0) tLast = v; if (v > tPeak) tPeak = v; } }
    // words first: they are the honest label for what each band covers
    const tw = !C.hasTokens ? 'Tokens a minute: this feed does not carry them.' : !tN ? 'Tokens a minute, whole crew: none recorded in this hour.'
      : `Tokens a minute, whole crew: ${fmtRate(tLast)} ${C.history ? 'in the last full minute' : 'now'}, most ${fmtRate(tPeak)}.${C.history ? '' : ' Counted since ' + fmtHM(C.sampled0) + ', when the map opened.'}`;
    const mw = (total ? `Messages a minute: ${total} in the hour, most ${peak} in one minute.` : 'Messages a minute: none in this hour.')
      + (C.feed0 > (m0 + 2) * MIN ? ` The feed starts at ${fmtHM(C.feed0)}.` : !M.msgs.length ? ' The feed holds no messages.' : '');
    if (D.chartT.textContent !== tw) D.chartT.textContent = tw; if (D.chartM.textContent !== mw) D.chartM.textContent = mw;
    if (S.view !== 'full' || !O.chart || !C.w) return;
    const c = cx2, W = C.w, H = C.h, x0 = 2, x1 = W - 2, bw = (x1 - x0) / 60, tT = 5, tB = 27, bT = 34, bB = 56;
    c.setTransform(C.dpr, 0, 0, C.dpr, 0, 0); c.clearRect(0, 0, W, H);
    // the part of the hour before the feed begins is marked, so an empty stretch is not read as a quiet one
    if (C.feed0 > (m0 + 2) * MIN) { const fx = x0 + clamp((C.feed0 / MIN - m0) * bw, 0, x1 - x0); c.fillStyle = 'rgba(131,145,173,.1)'; c.fillRect(x0, bT - 4, fx - x0, bB - bT + 4); }
    if (!C.history && C.sampled0 > m0 * MIN && C.hasTokens) { const fx = x0 + clamp((C.sampled0 / MIN - m0) * bw, 0, x1 - x0); c.fillStyle = 'rgba(131,145,173,.1)'; c.fillRect(x0, tT - 4, fx - x0, tB - tT + 6); }
    c.strokeStyle = 'rgba(131,145,173,.45)'; c.lineWidth = 1; c.beginPath(); c.moveTo(x0, tB + .5); c.lineTo(x1, tB + .5); c.moveTo(x0, bB + .5); c.lineTo(x1, bB + .5); c.stroke();
    c.fillStyle = '#9fb0d2'; const gap = bw > 4 ? 2 : 1;
    for (let i = 0; i < 60; i++) { const v = C.bars[i]; if (!v) continue; const h = Math.max(2, (bB - bT) * v / Math.max(1, peak)); c.fillRect(x0 + i * bw + gap / 2, bB - h, Math.max(1, bw - gap), h); }
    if (tN) { c.strokeStyle = '#fff'; c.lineWidth = 1.6; c.lineJoin = 'round'; c.beginPath(); let pen = false, lone = [];
      for (let i = 0; i < 60; i++) { const v = C.tok[i]; if (v < 0) { pen = false; continue; } const x = x0 + (i + .5) * bw, y = tB - (tB - tT) * v / Math.max(1, tPeak); if (pen) c.lineTo(x, y); else { c.moveTo(x, y); if (!(C.tok[i + 1] >= 0)) lone.push(x, y); } pen = true; }
      c.stroke(); c.fillStyle = '#fff'; for (let i = 0; i < lone.length; i += 2) { c.beginPath(); c.arc(lone[i], lone[i + 1], 2, 0, TAU); c.fill(); } }
    if (C.hover >= 0) { const x = x0 + (C.hover + .5) * bw; c.strokeStyle = 'rgba(219,228,245,.7)'; c.lineWidth = 1; c.beginPath(); c.moveTo(Math.round(x) + .5, tT - 4); c.lineTo(Math.round(x) + .5, bB); c.stroke(); }
    c.fillStyle = '#8391ad'; c.font = '11px "IBM Plex Mono", ui-monospace, monospace'; c.textBaseline = 'alphabetic';
    c.textAlign = 'left'; c.fillText(fmtHM(m0 * MIN), x0, H - 3); c.textAlign = 'center'; c.fillText(fmtHM((m0 + 30) * MIN), x0 + 30.5 * bw, H - 3); c.textAlign = 'right'; c.fillText(E.mode === 'live' && !E.stale ? 'now' : fmtHM(clock), x1, H - 3);
    chartHoverWords();
  }
  function chartHoverWords() {
    const i = C.hover; if (i < 0 || !C.m0) { D.chartAt.textContent = ''; return; }
    const t = C.tok[i]; D.chartAt.textContent = `· ${fmtHM((C.m0 + i) * MIN)} · ${plural(C.bars[i], 'message')} · ${t >= 0 ? fmtRate(t) + ' tokens' : 'tokens not known'}`;
  }
  on(D.chartCv, 'pointermove', e => { if (!C.rect) C.rect = D.chartCv.getBoundingClientRect(); const i = clamp(Math.floor((e.clientX - C.rect.left - 2) / ((C.w - 4) / 60)), 0, 59); if (i !== C.hover) { C.hover = i; drawChart(); } });
  on(D.chartCv, 'pointerleave', () => { C.hover = -1; C.rect = null; drawChart(); });

  /* ---------------------------------------------------------------- lists, status */
  function whoSpan(e) { const s = el('span', 'cm-who'), from = M.parts.get(e.from), to = M.parts.get(e.to); s.textContent = (e.hub ? 'HUB' : from ? from.name : e.from) + ' → ' + (to ? to.name : e.to); if (!e.hub && from) { s.style.color = from.color; s.dataset.c = '1'; } return s; }
  function renderLists() {
    listsDirty = false;
    const full = S.view !== 'panel', clock = dataClock(), wl = D.wait; wl.textContent = '';
    D.waitn.textContent = M.waits.length || '';
    D.waitold.textContent = M.older.n ? `${plural(M.older.n, 'older ask')} not counted` : '';
    D.waitold.title = M.older.n ? `${plural(M.older.n, 'ask')} more than a day old${M.older.oldest ? ' (the oldest ' + fmtAge(clock - M.older.oldest) + ')' : ''}. They are not shown as waiting.` : '';
    if (!M.waits.length) wl.append(el('li', 'cm-quiet', !E.everOk ? 'Nothing yet: no crew data has arrived.' : E.mode === 'catchup' ? 'Catching up on the last hour.' : 'Nobody is waiting on a reply asked in the last day.'));
    const nW = full ? 8 : 2;
    for (const w of M.waits.slice(0, nW)) {
      const li = el('li'), b = el('button'), from = M.parts.get(w.from), to = M.parts.get(w.to); b.type = 'button'; b.dataset.pair = [w.from, w.to].sort().join('~');
      b.append(el('span', 'cm-amb'), el('span', 'cm-who', `${from ? from.name : w.from} waits on ${to ? to.name : w.to}`), el('span', 'cm-age', fmtAge(clock - w.since)), el('span', 'cm-tm', w.followUpAt ? (w.followUpAt > clock ? 'hub follows up ' : 'follow-up was due ') + fmtHM(w.followUpAt) : ''));
      if (full) b.append(el('span', 'cm-tx', w.text));
      li.append(b); wl.append(li);
    }
    if (M.waits.length > nW) wl.append(el('li', 'cm-quiet', `and ${M.waits.length - nW} more`));
    const sl = D.said; sl.textContent = '';
    const said = O.hubNotices ? M.said : M.said.filter(e => !e.hub);
    if (!said.length) sl.append(el('li', 'cm-quiet', !E.everOk ? 'Nothing yet: no crew data has arrived.' : E.mode === 'catchup' ? 'Catching up on the last hour.' : M.msgs.length ? 'Waiting for the next message.' : 'Nothing has been said: the feed holds no messages.'));
    said.slice(0, full ? 6 : 3).forEach((e, i) => {
      const li = el('li', e.hub ? 'cm-hubline' : ''), b = el('button'); b.type = 'button'; if (e.hub) b.dataset.seat = e.to; else b.dataset.pair = [e.from, e.to].sort().join('~');
      b.append(whoSpan(e), el('span', 'cm-tx', e.text.replace(/\s+/g, ' ')), el('span', 'cm-tm', clock - e.at > 20 * HOUR ? fmtDHM(e.at) : fmtHM(e.at))); if (full) b.insertBefore(b.lastChild, b.children[1]);
      li.style.opacity = String(1 - i * (full ? .07 : .12)); li.append(b); sl.append(li);
    });
    const noSeats = !M.list.some(p => p.row), rq = D.roster.querySelector('.cm-quiet');
    if (noSeats && !rq) D.roster.append(el('li', 'cm-quiet', '')); else if (!noSeats && rq) rq.remove();
    if (noSeats) D.roster.querySelector('.cm-quiet').textContent = E.everOk ? 'The source sent no seats.' : 'Nothing yet: no crew data has arrived.';
    const t = said[0], tk = D.ticker; tk.textContent = ''; if (t) { const w = whoSpan(t), b = el('b'); b.textContent = w.textContent; b.style.color = w.style.color; tk.append(b, t.text.replace(/\s+/g, ' ').slice(0, 140)); }
  }
  const KIND_WORD = { live: 'LIVE', demo: 'DEMO', replay: 'REPLAY' };
  function renderStatus() {
    const clock = dataClock(), big = !L.compact;
    let running = 0, idle = 0, stopped = 0, held = 0, seats = 0, known = 0, top = null;
    for (const p of M.list) { if (p.kind !== 'seat' && p.kind !== 'flight') continue; seats++; if (p.hold) held++; if (p.state === 'running') running++; else if (p.state === 'idle') idle++; else if (p.state === 'stopped') stopped++; if (p.state !== 'unknown' && p.state !== 'nodata') known++; if (p.lim && (!top || p.ctx / p.lim > top.ctx / top.lim)) top = p; }
    const word = KIND_WORD[E.kind] || (E.started ? 'LIVE' : 'WAITING');
    const chip = !E.started && !E.stale ? 'WAITING FOR DATA' : E.stale ? word + ' · NOT UPDATING' : E.mode === 'catchup' ? word + ' · CATCHING UP' : word, cls = E.stale || !E.started ? 'cm-is-off' : 'cm-is-' + (E.kind || 'live');
    let l1, l2 = '';
    if (E.stale) { l1 = E.everOk ? `not updating · last picture ${fmtHM(E.frozen)}` : 'not updating · no picture yet'; l2 = E.error; }
    else if (!E.started) { l1 = 'no crew data yet'; }
    else if (E.mode === 'catchup') { l1 = 'catching up on the last hour'; }
    else if (!known) { l1 = `${plural(seats, 'seat')} · this feed does not carry seat state`; l2 = 'Messages only: who wrote to whom, and when.'; }
    else { l1 = `${running} working · ${idle} idle${stopped ? ' · ' + stopped + ' stopped' : ''}${held ? ' · ' + held + ' stuck' : ''} · ${M.waits.length} owe${M.waits.length === 1 ? 's' : ''} a reply` + (big ? ` · ${plural(M.hourN, 'message')} in the last hour` : '');
      l2 = (big ? '' : `${plural(M.hourN, 'message')} last hour`) + (top ? (big ? 'Fullest context: ' : ' · fullest: ') + `${top.name}, ${ctxOver(top) ? ctxShort(top) : fmtK(top.ctx) + ' of ' + fmtK(top.lim)}` : ''); }
    if (E.kind === 'replay' && E.fast && E.progress != null) l1 += ` · ${Math.round(E.progress * 100)}% through`;
    const ck = !E.started ? '' : reduced() || E.fast || E.stale ? (E.fast ? fmtDHM(clock) : fmtHM(clock)) : fmtHMS(clock);
    if (D.clock.textContent !== ck) D.clock.textContent = ck;
    const key = chip + cls + l1 + l2 + (M.readout || press ? 1 : 0);
    if (key !== lastStatus) { lastStatus = key; D.status.className = 'cm-status ' + cls; D.status.textContent = ''; D.status.append(el('i'), chip);
      if (!M.readout && !(press && press.started)) { D.l1.textContent = l1; D.l2.textContent = l2; D.strip.classList.remove('cm-is-detail'); } }
    const tag = word + '|' + E.label;
    if (tag !== lastTag) { lastTag = tag; D.tag.textContent = ''; if (E.started || E.stale) { D.tag.append(el('b', '', word)); if (E.label) D.tag.append(el('i', '', ' · '), E.label); D.tag.title = word + (E.label ? ' · ' + E.label : ''); } }
    const pr = E.progress != null && E.fast; if (D.progress.hidden === pr) D.progress.hidden = !pr; if (pr) D.progress.firstChild.style.width = (100 * E.progress).toFixed(1) + '%';
  }
  function renderChrome() {   // things that change with the view, an option, or the health of the source
    root.classList.toggle('cm-is-full', S.view !== 'panel'); root.classList.toggle('cm-is-ambient', S.view === 'ambient');
    D.key.hidden = !S.key; D.bKey.setAttribute('aria-pressed', String(S.key));
    D.perf.hidden = !O.perf; D.chart.hidden = !O.chart; D.reset.hidden = !Object.keys(pins[S.view] || {}).length;
    stage.classList.toggle('cm-is-stale', E.stale);
    D.alert.hidden = !E.stale; if (E.stale) { D.alert.textContent = ''; const msg = /[.!?]$/.test(E.error) ? E.error : E.error + '.';
      D.alert.append(el('b', '', 'NOT UPDATING'), msg + (E.everOk ? ` This is the last picture, from ${fmtHM(E.frozen)}.` : ' No picture has arrived yet.')); }
    const seats = M.list.filter(p => p.kind === 'seat' || p.kind === 'flight');
    const none = E.started && !M.list.length, dark = E.started && seats.length && seats.every(p => p.state === 'stopped') && !M.msgs.length;
    D.empty.hidden = !(none || dark || (!E.started && !E.stale));
    D.empty.textContent = !E.started ? 'Nothing to show yet: no crew data has arrived.' : none ? 'The source sent no crew: there are no seats to place.' : 'No seat is running and the feed holds no messages. Seats keep their places; the map lights up when one starts or writes.';
  }
  function renderKey() {
    D.key.innerHTML = KEY_ROWS(E.limit).map(k => `<div><svg viewBox="0 0 26 16" aria-hidden="true">${k[0]}</svg><span>${k[1]}</span></div>`).join('')
      + '<p>Drag a seat to move it; it springs back. Hold Alt as you let go to keep it there. Double-click a kept seat to send it home.</p>';
  }
  function renderActions() {
    D.actions.textContent = '';
    for (const a of O.actions || []) { const b = el('button', 'cm-btn' + (a.only === 'full' ? ' cm-only-full' : a.only === 'panel' ? ' cm-only-panel' : ''), a.label); b.type = 'button'; if (a.title) b.title = a.title;
      if (a.pressed != null) b.setAttribute('aria-pressed', String(!!a.pressed)); if (a.disabled) b.disabled = true; b.onclick = ev => { if (a.onClick) a.onClick(ev); }; D.actions.append(b); }
  }

  /* ---------------------------------------------------------------- selection, readout */
  const selObj = () => M.selSeat ? { type: 'seat', id: M.selSeat.id } : M.selPair ? { type: 'link', a: M.selPair.a.id, b: M.selPair.b.id } : null;
  function resolveSel() {
    M.selSeat = M.selPair = null;
    if (S.sel.includes('~')) M.selPair = M.pair.get(S.sel.split('~').sort().join('~')) || null; else if (S.sel) M.selSeat = M.parts.get(S.sel) || null;
    for (const l of M.lanes) l.sel = M.selPair ? l.pair === M.selPair : M.selSeat ? l.a === M.selSeat || l.b === M.selSeat : true;
    for (const p of M.list) p.selOn = !M.selSeat && !M.selPair ? true : p === M.selSeat || (M.selPair && (p === M.selPair.a || p === M.selPair.b)) || (!!M.selSeat && (M.lane.has(p.id + '>' + M.selSeat.id) || M.lane.has(M.selSeat.id + '>' + p.id)));
    for (const b of root.querySelectorAll('[data-seat][aria-pressed]')) b.setAttribute('aria-pressed', String(!!M.selSeat && b.dataset.seat === M.selSeat.id));
    bgDirty = true;
  }
  function applySel(v, user) {
    S.sel = v || ''; resolveSel(); wake(); showTip(M.focus || M.hotSeat || M.hotPair || M.selSeat || M.selPair);
    if (user) { const o = selObj(); if (O.onSelect) O.onSelect(o); if (o && O.onOpenConversation) O.onOpenConversation(o); }
  }
  const userSel = v => applySel(S.sel === v ? '' : v, true);
  function showTip(o) {   // the readout strip shows the facts of whatever is pointed at, focused or selected; nothing floats over the map
    if (press && press.started) return;
    M.readout = o || null; lastStatus = ''; if (!o) { renderStatus(); return; }
    const clock = dataClock(), sclock = clockNow(); let a, b;
    if (o.lanes) { a = `${o.a.name} ↔ ${o.b.name}`; b = o.lanes.map(l => `${l.a.name} → ${l.b.name}: ${plural(l.n, 'message')}${l.lastAt > 0 ? ', last ' + (clock - l.lastAt < MIN ? 'now' : fmtAge(clock - l.lastAt) + ' ago') : ''}`)
      .concat(M.waits.filter(w => o.lanes.some(l => l.a.id === w.from && l.b.id === w.to)).map(w => `${M.parts.get(w.from).name} waits on ${M.parts.get(w.to).name}, ${fmtAge(clock - w.since)}`)).join(' · '); }
    else { a = `${o.name} · ${ROLE_WORD[o.role] || 'seat'} · ${stateWords(o, sclock)}`;
      b = [o.lim ? 'context ' + ctxWords(o) : '', o.title && o.state !== 'stopped' ? o.title : '', plural(o.n, 'message'), o.hubN && O.hubNotices ? plural(o.hubN, 'hub notice') : '', o.rate > 0 && o.state === 'running' ? fmtRate(o.rate) + ' tokens a minute' : '', o.flood >= FLOOD_N ? o.flood + ' sent in 5 minutes' : '',
        (pins[S.view] || {})[o.id] ? 'kept here; double-click sends it home' : ''].filter(Boolean).join(' · '); }
    D.l1.textContent = a; D.l2.textContent = b; D.strip.classList.add('cm-is-detail');
  }
  function hot(seat, pair, focus) { if (M.hotSeat === seat && M.hotPair === pair && focus === undefined) return; M.hotSeat = seat; M.hotPair = pair; if (focus !== undefined) M.focus = focus; showTip(M.focus || seat || pair || M.selSeat || M.selPair); stage.style.cursor = pair && !seat ? 'pointer' : ''; wake(); }
  function nearPair(x, y) {
    let best = null, bd = (L.compact ? 7 : 10) ** 2;
    for (const pr of M.pairs) for (const l of pr.lanes) { const p = l.pts; if (!p) continue; for (let i = 0; i < NPT; i++) { const ax = p[i * 2], ay = p[i * 2 + 1], bx = p[i * 2 + 2], by = p[i * 2 + 3], dx = bx - ax, dy = by - ay, t = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1), d = (x - ax - dx * t) ** 2 + (y - ay - dy * t) ** 2; if (d < bd) { bd = d; best = pr; } } }
    return best;
  }

  /* ---------------------------------------------------------------- pointer: hover, click, drag */
  let mvQueued = 0, mvX = 0, mvY = 0, mvTarget = null, stageRect = null, swallowClick = false;
  const rect = () => stageRect || (stageRect = stage.getBoundingClientRect());   // read on a pointer event after a resize or scroll, never per frame
  on(stage, 'pointerdown', e => {
    swallowClick = false; if (e.button || press) return;
    const sb = e.target.closest && e.target.closest('.cm-seat'), p = sb && M.parts.get(sb.dataset.seat); if (!p) return;
    const r = rect(); press = { p, id: e.pointerId, x0: e.clientX, y0: e.clientY, gx: e.clientX - r.left - p.x, gy: e.clientY - r.top - p.y, started: false, touch: e.pointerType === 'touch', hist: [] };
  });
  on(stage, 'pointermove', e => {
    if (press && e.pointerId === press.id) {
      const p = press.p;
      if (!press.started) {
        if (Math.hypot(e.clientX - press.x0, e.clientY - press.y0) < (press.touch ? DRAG_PX_TOUCH : DRAG_PX)) return;
        press.started = true; swallowClick = true; p.mover = true; p.vx = p.vy = 0; activate(p);
        try { stage.setPointerCapture(e.pointerId); } catch (err) {}
        stage.classList.add('cm-is-dragging'); M.hotPair = null;
        D.l1.textContent = `Moving ${p.name}`; D.l2.textContent = 'It springs back when you let go.' + (press.touch ? '' : ' Hold Alt to keep it here.'); D.strip.classList.add('cm-is-detail');
      }
      const r = rect(), m = p.r + 6;
      p.ox = clamp(e.clientX - r.left - press.gx, m, L.W - m) - p.hx; p.oy = clamp(e.clientY - r.top - press.gy, m, L.H - m) - p.hy; p.x = p.hx + p.ox; p.y = p.hy + p.oy;
      const hst = press.hist; hst.push(e.timeStamp, p.ox, p.oy); if (hst.length > 24) hst.splice(0, 3);
      e.preventDefault(); wake(); return;
    }
    mvX = e.clientX; mvY = e.clientY; mvTarget = e.target; if (mvQueued) return;
    mvQueued = requestAnimationFrame(() => { mvQueued = 0; if (destroyed || (press && press.started)) return; const r = rect();
      const sb = mvTarget.closest && mvTarget.closest('.cm-seat'); if (sb) return hot(M.parts.get(sb.dataset.seat) || null, null);
      hot(null, nearPair(mvX - r.left, mvY - r.top)); });
  });
  function endPress(e, cancelled) {
    if (!press || (e && e.pointerId !== press.id)) return;
    const pr = press, p = pr.p; press = null;
    if (!pr.started) return;   // it never moved far enough: the click that follows selects
    stage.classList.remove('cm-is-dragging'); try { stage.releasePointerCapture(pr.id); } catch (err) {}
    const keep = !cancelled && e && e.altKey;
    if (keep) { p.tx = p.ox; p.ty = p.oy; setPin(p, true); }
    // a flick carries a little momentum: the speed over the last tenth of a second goes into the spring
    const h = pr.hist, n = h.length; let vx = 0, vy = 0;
    if (!keep && n >= 6 && e) { let i = n - 3; while (i >= 3 && h[n - 3] - h[i - 3] < 90) i -= 3; const dt = (e.timeStamp - h[i]) / 1000; if (dt > .01 && e.timeStamp - h[n - 3] < 60) { vx = (h[n - 2] - h[i + 1]) / dt; vy = (h[n - 1] - h[i + 2]) / dt; const v = Math.hypot(vx, vy); if (v > 2400) { vx *= 2400 / v; vy *= 2400 / v; } } }
    p.vx = vx; p.vy = vy; if (L.pending) { L.pending = false; layout(); } M.readout = null; lastStatus = ''; showTip(M.hotSeat || M.selSeat || M.selPair); wake();
  }
  on(stage, 'pointerup', e => endPress(e, false));
  on(stage, 'pointercancel', e => endPress(e, true));
  on(stage, 'lostpointercapture', e => endPress(e, true));
  on(stage, 'pointerleave', () => { if (!(press && press.started)) hot(null, null); });
  on(stage, 'click', e => {
    if (swallowClick) { swallowClick = false; return; }   // the end of a drag is never a click
    if (e.target.closest('.cm-btn')) return;
    const sb = e.target.closest('.cm-seat'), pb = e.target.closest('.cm-pair');
    if (sb) return userSel(sb.dataset.seat); if (pb) return userSel(pb.dataset.pair);
    const r = rect(), pr = nearPair(e.clientX - r.left, e.clientY - r.top); if (pr) userSel(pr.key); else if (S.sel) applySel('', true);
  });
  on(stage, 'dblclick', e => { const sb = e.target.closest('.cm-seat'), p = sb && M.parts.get(sb.dataset.seat); if (!p || !(pins[S.view] || {})[p.id]) return; setPin(p, false); p.tx = p.ty = 0; p.mover = true; activate(p); showTip(p); });
  on(D.roster, 'pointerover', e => { const b = e.target.closest('[data-seat]'); hot(b ? M.parts.get(b.dataset.seat) || null : null, null); });
  on(D.roster, 'pointerleave', () => hot(null, null));
  on(D.side, 'click', e => { const b = e.target.closest('[data-pair], [data-seat]'); if (b) userSel(b.dataset.pair || b.dataset.seat); });
  on(labels, 'focusin', e => { const b = e.target; if (!b.matches(':focus-visible')) return; hot(M.hotSeat, M.hotPair, b.dataset.seat ? M.parts.get(b.dataset.seat) || null : M.pair.get(b.dataset.pair) || null); });
  on(labels, 'focusout', () => hot(M.hotSeat, M.hotPair, null));
  on(labels, 'keydown', e => { const all = [...labels.children], i = all.indexOf(document.activeElement); let j = -1; if (i < 0) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % all.length; else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + all.length) % all.length; else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = all.length - 1;
    if (j >= 0) { e.preventDefault(); all[i].tabIndex = -1; all[j].tabIndex = 0; all[j].focus(); } });
  on(document, 'keydown', e => { if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (S.view === 'ambient') setView('full', true); else if (S.sel && (S.view === 'full' || root.contains(document.activeElement))) applySel('', true); else if (S.view === 'full') setView('panel', true); });
  on($('.cm-b-full'), 'click', () => setView('full', true)); on($('.cm-b-close'), 'click', () => setView('panel', true));
  on($('.cm-b-ambient'), 'click', () => setView('ambient', true)); on($('.cm-exit'), 'click', () => setView('full', true));
  on(D.bKey, 'click', () => { S.key = !S.key; renderChrome(); });
  on(D.reset, 'click', resetPlaces);
  if (mq) on(mq, 'change', () => { lastStatus = ''; wake(); });

  /* ---------------------------------------------------------------- size: read once per resize, never per frame */
  const ro = new ResizeObserver(es => { const r = es[es.length - 1].contentRect; if (Math.abs(r.width - L.W) < .5 && Math.abs(r.height - L.H) < .5) return; L.W = r.width; L.H = r.height; stageRect = null;
    L.dpr = Math.min(window.devicePixelRatio || 1, 2, Math.max(1, Math.sqrt(6e6 / Math.max(1, L.W * L.H))));   // cap the pixel ratio, and the pixel count at about 6 million
    for (const cv of [bgc, fxc]) { cv.width = Math.round(L.W * L.dpr); cv.height = Math.round(L.H * L.dpr); }
    layout(); sizeChart(); });
  ro.observe(stage);
  on(window, 'scroll', () => { stageRect = null; C.rect = null; }, true);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (!destroyed && L.laid) { bgDirty = true; chartDirty = true; wake(); } });
  // ages in the lists move by the minute, also when no frame is being drawn
  const slow = setInterval(() => { if (halted || destroyed) return; listsDirty = true; if (reduced() || tier === 'still') wake(); else renderLists(); }, 20000);

  function setView(v, user) {
    if (!['panel', 'full', 'ambient'].includes(v) || v === S.view) return;
    S.view = v; active.clear(); for (const l of M.lanes) l.live = false; press = null; stage.classList.remove('cm-is-dragging');
    renderChrome(); listsDirty = true; renderLists(); lastStatus = ''; renderStatus();
    if (L.W && L.laid) layout();   // the stage usually changes size too, and then the observer lays it out again
    requestAnimationFrameOnce(sizeChart);
    if (user && O.onViewChange) O.onViewChange(v);
  }
  let onceRaf = 0;
  function requestAnimationFrameOnce(fn) { if (onceRaf) cancelAnimationFrame(onceRaf); onceRaf = requestAnimationFrame(() => { onceRaf = 0; if (!destroyed) fn(); }); }
  function setOptions(o) {
    if (destroyed || !o) return;
    for (const k of ['contextLimit', 'chart', 'sweep', 'hubNotices', 'reducedMotion', 'catchUp', 'perf', 'onSelect', 'onOpenConversation', 'onViewChange', 'onPinsChange']) if (k in o) O[k] = o[k];
    if ('key' in o) S.key = !!o.key;
    if ('pins' in o) { for (const v in pins) pins[v] = { ...((o.pins || {})[v] || {}) }; if (L.laid) layout(); }
    renderChrome(); listsDirty = textDirty = chartDirty = true; lastStatus = ''; renderLists(); renderStatus(); requestAnimationFrameOnce(sizeChart); wake();
  }
  function destroy() {
    if (destroyed) return; destroyed = true;
    if (raf) cancelAnimationFrame(raf); if (timer) clearTimeout(timer); if (mvQueued) cancelAnimationFrame(mvQueued); if (onceRaf) cancelAnimationFrame(onceRaf); clearInterval(slow);
    raf = timer = mvQueued = onceRaf = 0;
    ro.disconnect(); io.disconnect();
    for (const off of offs) off(); offs.length = 0;
    sprites.clear(); sweepCv = null; active.clear(); press = null;
    root.remove(); dropStyle();
  }

  renderKey(); renderActions(); renderChrome(); renderLists(); renderStatus(); pinsChanged0();
  function pinsChanged0() { D.reset.hidden = !Object.keys(pins[S.view] || {}).length; }
  return {
    update, destroy, getPins, resetPlaces, setOptions,
    setView: v => setView(v, false),
    select: id => { if (!destroyed) applySel(id || '', false); },
    colorOf: id => { const p = M.parts.get(id); return p ? p.color : null; },
    setActions: a => { O.actions = a || []; renderActions(); },
    // for measuring and tests, not for the app
    _probe: () => ({
      comets: M.comets.map(c => ({ from: c.l.a.id, to: c.l.b.id, color: c.l.a.color, start: lanePt(c.l, 0, {}), end: lanePt(c.l, 1, {}) })),
      lanes: M.lanes.map(l => ({ from: l.a.id, to: l.b.id, heat: heatOf(l, clockNow()) })),
      waits: M.waits.map(w => ({ id: w.id, from: w.from, to: w.to })),
      older: M.older.n,
      labels: M.list.filter(p => p.lab).map(p => ({ id: p.id, x: p.lab.x, y: p.lab.y, w: p.lab.w, h: p.lab.h })),
      dots: M.list.map(p => ({ id: p.id, x: p.x, y: p.y, r: p.rT })),
      seats: M.list.map(p => ({ id: p.id, name: p.name, state: p.state, hold: p.hold, ctx: p.ctx, lim: p.lim, tool: p.tool, sub: p.sub, x: p.x, y: p.y, color: p.color })),
    }),
    _stats: perfStats, _resetStats: () => { perf.n = 0; perf.stamps.length = 0; },
    _state: () => ({ halted, mode: E.mode, kind: E.kind, clock: dataClock(), tier, view: S.view, sel: S.sel, comets: M.comets.length, waits: M.waits.length, warm: M.lanes.filter(l => l.h > .03).length, lanes: M.lanes.length, active: active.size, dropped: M.dropped, stale: E.stale,
      labBad: M.list.filter(p => p.labBad > 0).map(p => p.name + ':' + Math.round(p.labBad)), seats: M.list.map(p => ({ id: p.id, x: p.x, y: p.y, hx: p.hx, hy: p.hy, r: p.r })) }),
  };
}


export { createCrewMap as createCrewMapImpl };
