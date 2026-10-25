// MCPL RFC-014 (tool presence, toolsets and surfaces): which tools are static, which belong to
// the `game` toolset, which are visible in each game state, and the per-connection bookkeeping of
// what a host has been told — per unit: a toolset without instances, or one named instance of a
// toolset with them (src/go/toolset.ts has Go's). Pure — mcpl.ts owns the wire;
// test/hints.test.ts covers it.
//
// The toolset is open for a principal while it has a game that was not closed with `keep`
// (games belong to an identity and survive reconnects and restarts, so toolsets/list after a
// reconnect reports the game and the host adopts it). Visibility inside it follows the game:
//
//   running   game_act game_look game_state game_say game_watchers game_stop
//   dead      game_look game_state game_say game_watchers game_stop game_start game_restart
//   complete  the same as dead, plus game_next while there is a next map
import type { GameStatus } from './games.js';

export const TOOLSET = 'game';

export interface Tool { name: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown>; _meta?: Record<string, unknown> }

/** RFC §6.1. `instance` is present on entries for a toolset with instances. */
export interface HintChanges {
  rev: number;
  tools?: Array<{ name: string; instance?: string; visible?: boolean; definition?: Tool }>;
  toolsets?: Array<{ toolset: string; instance?: string; state: 'open' | 'closed'; title?: string }>;
  suggest?: Array<{ toolset: string; instance?: string; action: 'open' | 'close'; reason: string }>;
}
export type Changes = Omit<HintChanges, 'rev'>;

/** Useful at any time: the catalogue and the results. */
export const STATIC_TOOLS: readonly string[] = ['game_list', 'game_results'];
/** The `game` toolset, in the order hints list them. */
export const GAME_TOOLS: readonly string[] = ['game_act', 'game_look', 'game_state', 'game_say', 'game_watchers', 'game_stop', 'game_start', 'game_restart', 'game_next'];
/** Offered only to a host that advertised toolHints; a plain host keeps game_start for both, as before. */
export const HINTED_ONLY: readonly string[] = ['game_restart', 'game_next'];

const GAME_TOOL_SET = new Set(GAME_TOOLS);
export const isGameTool = (name: string) => GAME_TOOL_SET.has(name);

/** What the hints need to know about a principal's game. */
export interface GameView {
  id: string;
  status: GameStatus;
  /** Closed with `keep`: still on the server, toolset closed until opened again. */
  parked: boolean;
  /** The map game_next goes to (at level complete), or null. */
  next: string | null;
  title: string;
  map: string;
}

/** Tools available right now in this game state (RFC §4.1 `mcpl/visible`). */
export function visibleFor(status: GameStatus, next: string | null): Set<string> {
  const anyState = ['game_look', 'game_state', 'game_say', 'game_watchers', 'game_stop'];
  if (status === 'running') return new Set(['game_act', ...anyState]);
  if (status === 'dead') return new Set([...anyState, 'game_start', 'game_restart']);
  if (status === 'complete') return new Set([...anyState, 'game_start', 'game_restart', ...(next ? ['game_next'] : [])]);
  return new Set();
}

/** Why a toolset tool cannot be called now (for the error a hinted host gets), or null if it can. */
export function unavailable(name: string, g: GameView | null): string | null {
  if (!g) return `${name} belongs to the game toolset, which is not open: you have no game. Opening the game toolset starts one (options game, map, skill).`;
  if (g.parked) return `${name} belongs to the game toolset, which is closed; your game (${g.title}) is kept on the server. Opening the game toolset picks it up.`;
  const now = visibleFor(g.status, g.next);
  if (now.has(name)) return null;
  const why = g.status === 'running' ? `you are playing ${g.map}${name === 'game_start' ? ' (game_stop ends this game; then open the toolset again with other options)' : ''}`
    : g.status === 'dead' ? `you died on ${g.map}`
    : name === 'game_next' ? `${g.map} was the last map` : `${g.map} is complete`;
  return `${name} is not available right now: ${why}. Available: ${[...now].join(', ')}.`;
}

/** What one connection's host has been told (or, from current(), what is true now). */
export interface Told {
  open: boolean;
  title?: string;
  visible: Set<string>;
  /** Visible tools whose definition differs from tools/list, by a key (game_next: its map). */
  defs: Map<string, string>;
}

export const closedTold = (): Told => ({ open: false, visible: new Set(), defs: new Map() });

export function current(g: GameView | null): Told {
  if (!g || g.parked) return closedTold();
  const visible = visibleFor(g.status, g.next);
  const defs = new Map<string, string>();
  if (visible.has('game_next') && g.next) defs.set('game_next', g.next);
  return { open: true, title: g.title, visible, defs };
}

/**
 * The changes that take a host from `told` to `cur`, and what it has been told afterwards.
 * - `full`: report every toolset tool, visible or not (an open or a list: the host starts over).
 * - `mayOpen`: this exchange may report the toolset opening — an open, a list, a call of one of
 *   its tools, or a change made on another connection of the principal (RFC §5.6). A static
 *   tool's result does not, so an open made elsewhere goes out on its own, not in that result.
 * A close reports the tools that were visible as invisible, and the toolset closed.
 */
export function diff(told: Told, cur: Told, define: (tool: string) => Tool, opts: { full?: boolean; mayOpen: boolean }): { changes: Changes | null; told: Told } {
  return diffUnit(told, cur, { toolset: TOOLSET, tools: GAME_TOOLS }, define, opts);
}

/** One unit: a toolset without instances, or one instance of a toolset with them. */
export interface Unit { toolset: string; instance?: string; tools: readonly string[] }

export function diffUnit(told: Told, cur: Told, unit: Unit, define: (tool: string) => Tool, opts: { full?: boolean; mayOpen: boolean }): { changes: Changes | null; told: Told } {
  const tools: NonNullable<Changes['tools']> = [];
  const toolsets: NonNullable<Changes['toolsets']> = [];
  const inst = unit.instance !== undefined ? { instance: unit.instance } : {};
  if (!cur.open) {
    if (!told.open) return { changes: null, told };
    for (const name of unit.tools) if (told.visible.has(name)) tools.push({ name, ...inst, visible: false });
    toolsets.push({ toolset: unit.toolset, ...inst, state: 'closed' });
    return { changes: { tools, toolsets }, told: closedTold() };
  }
  if (!told.open && !opts.mayOpen) return { changes: null, told };
  const fresh = opts.full || !told.open;
  for (const name of unit.tools) {
    const v = cur.visible.has(name);
    const key = cur.defs.get(name);
    const defChanged = v && key !== undefined && (fresh || told.defs.get(name) !== key);
    if (fresh || v !== told.visible.has(name) || defChanged) tools.push({ name, ...inst, visible: v, ...(defChanged ? { definition: define(name) } : {}) });
  }
  if (fresh || cur.title !== told.title) toolsets.push({ toolset: unit.toolset, ...inst, state: 'open', title: cur.title });
  const changes = tools.length || toolsets.length ? { ...(tools.length ? { tools } : {}), ...(toolsets.length ? { toolsets } : {}) } : null;
  return { changes, told: { open: true, title: cur.title, visible: new Set(cur.visible), defs: new Map(cur.defs) } };
}

/** Units by key; a unit absent from the map is closed. */
export type Units = Map<string, Told>;
export const unitKey = (toolset: string, instance?: string) => `${toolset}\u0000${instance ?? ''}`;
export function unitOf(key: string): { toolset: string; instance?: string } {
  const [toolset, instance] = key.split('\u0000');
  return { toolset: toolset!, ...(instance ? { instance } : {}) };
}

/**
 * diffUnit over every unit the host was told of or that is open now. `full`: true for all units,
 * or the keys to restate in full (an open restates the unit it opened).
 */
export function diffUnits(told: Units, cur: Units, toolsOf: (toolset: string) => readonly string[], define: (key: string, tool: string) => Tool,
  opts: { full?: boolean | ReadonlySet<string>; mayOpen: boolean }): { changes: Changes | null; told: Units } {
  const tools: NonNullable<Changes['tools']> = [];
  const toolsets: NonNullable<Changes['toolsets']> = [];
  const next: Units = new Map();
  for (const key of new Set([...told.keys(), ...cur.keys()])) {
    const u = unitOf(key);
    const full = opts.full === true || (opts.full instanceof Set && opts.full.has(key));
    const r = diffUnit(told.get(key) ?? closedTold(), cur.get(key) ?? closedTold(), { ...u, tools: toolsOf(u.toolset) }, (t) => define(key, t), { full, mayOpen: opts.mayOpen });
    if (r.told.open) next.set(key, r.told);
    if (r.changes?.tools) tools.push(...r.changes.tools);
    if (r.changes?.toolsets) toolsets.push(...r.changes.toolsets);
  }
  const changes = tools.length || toolsets.length ? { ...(tools.length ? { tools } : {}), ...(toolsets.length ? { toolsets } : {}) } : null;
  return { changes, told: next };
}

/**
 * A tool definition with its hints (`mcpl/visible` only on toolset tools: a static tool is always
 * visible). `toolset`: the toolset it belongs to, if any (default: `game` for the game tools).
 */
export function hinted(tool: Tool, visible: boolean, toolset: string | null = isGameTool(tool.name) ? TOOLSET : null): Tool {
  const meta = toolset
    ? { 'mcpl/presence': 'dynamic', 'mcpl/toolset': toolset, 'mcpl/visible': visible }
    : { 'mcpl/presence': 'static' };
  return { ...tool, _meta: { ...tool._meta, ...meta } };
}
