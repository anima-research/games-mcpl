// Go as the `go` toolset (MCPL RFC-014): each open is one game, a named instance belonging to the
// principal that opened it. Which tools are visible follows the game, per instance:
//
//   waiting for an opponent   go_cancel
//   your turn                 go_play go_pass go_resign (+ go_undo against the bot)
//   their turn                go_resign
//   scoring                   go_mark_dead go_accept go_resume   (no go_accept once you accepted)
//   over                      go_rematch go_sgf
//
// Against the bot its reply happens inside your call (searched on a worker thread, bots.ts).
// Against another identity (joined by code), each move reaches the other player as an event that
// carries their visibility change. Matches are saved after every change under <data>/go/ and come
// back after a restart. Rules and bot: board.ts and bot.ts (ported from the earlier Go server).
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Fault } from '../auth.js';
import type { Principal } from '../games.js';
import type { Tool } from '../hints.js';
import { BLACK, WHITE, GoGame, areaScore, colorName, groupAt, other, parsePoint, pointName, renderBoard, type Color } from './board.js';
import type { Level } from './bot.js';
import type { BotPool } from './bots.js';

export const GO = 'go';
export type Phase = 'waiting' | 'playing' | 'scoring' | 'over';
/** `opponent: 'agent'` (its name on the wire) is an open seat: an agent joins by code, or a person on the web page. */
export interface GoSettings { size: number; komi: number; level: Level; opponent: 'bot' | 'agent' }
/**
 * Who sits in a seat: the bot; an agent playing through an instance of the go toolset (`instance`
 * null once it closed it); or someone playing from the web page (`left` once they withdrew or moved
 * on to a rematch). A web seat has no instance: the page is its surface, and it hears of moves by
 * watching the match.
 */
type Seat = { kind: 'bot' } | { kind: 'agent'; sub: string; name: string; instance: string | null } | WebSeat;
type WebSeat = { kind: 'web'; sub: string; name: string; left?: boolean };
type PlayerSeat = Exclude<Seat, { kind: 'bot' }>;
/** At most this many unfinished games per person on the web (each bot game runs searches). */
export const WEB_SEATS_MAX = 6;

const obj = (props: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const POINT = { type: 'string', pattern: '^[A-HJ-Ta-hj-t](1[0-9]|[1-9])$' };

/** The toolset's tools. Prefixed `go_`: the names are unique across the server, and bare verbs (pass, accept, resume) would be ambiguous beside the Doom tools in any flat list. */
export const GO_TOOLS: Tool[] = [
  { name: 'go_play', description: 'Place a stone: column letter (A–T, no I) then row number counted from the bottom, e.g. "D4". Against the bot, its reply comes in the same result.', inputSchema: obj({ point: POINT }, ['point']) },
  { name: 'go_pass', description: 'Pass. Two passes in a row end play and start scoring.', inputSchema: obj() },
  { name: 'go_resign', description: 'Resign the game.', inputSchema: obj(), annotations: { destructiveHint: true } },
  { name: 'go_undo', description: 'Take back your last move and the bot\'s reply.', inputSchema: obj() },
  { name: 'go_cancel', description: 'Withdraw the game before anyone joins.', inputSchema: obj() },
  { name: 'go_mark_dead', description: 'Toggle the groups at these points between dead and alive for scoring; clears both acceptances.', inputSchema: obj({ points: { type: 'array', items: POINT, minItems: 1, maxItems: 40 } }, ['points']) },
  { name: 'go_accept', description: 'Accept the score as marked. The game ends when both players accept.', inputSchema: obj() },
  { name: 'go_resume', description: 'Go back to play to settle a disputed area.', inputSchema: obj() },
  { name: 'go_rematch', description: 'Play again with the same settings and colours swapped (against another agent: offer it, or accept their offer).', inputSchema: obj() },
  { name: 'go_sgf', description: 'The game record in SGF.', inputSchema: obj(), annotations: { readOnlyHint: true } },
];
export const GO_TOOL_NAMES = GO_TOOLS.map((t) => t.name);
const GO_TOOL_SET = new Set(GO_TOOL_NAMES);
export const isGoTool = (name: string) => GO_TOOL_SET.has(name);

/** RFC-014 §5.2: proposed instance names are used as given or refused. */
export const INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const OPTION_KEYS = ['size', 'color', 'opponent', 'level', 'komi', 'join'];

export function goDeclaration() {
  return {
    title: 'Go',
    summary: 'A game of Go (9×9, 13×13, 19×19) against a Monte Carlo bot, or another agent who joins by code. Each open is one game, a named instance; closing a live game against an agent forfeits it.',
    default: 'closed',
    instances: true,
    options: obj({
      size: { enum: [9, 13, 19], default: 9 },
      color: { enum: ['black', 'white', 'random'], default: 'black' },
      opponent: { enum: ['bot', 'agent'], default: 'bot', description: 'agent: the game waits for an opponent — another agent opens go with {join: <its code>}, or a person joins on the web page.' },
      level: { enum: ['easy', 'medium', 'hard'], default: 'medium', description: 'The bot\'s strength (about 0.4 s, 1.5 s or 5 s a move on 9×9).' },
      komi: { type: 'number', minimum: 0, maximum: 15, default: 7.5 },
      join: { type: 'string', description: 'Join another agent\'s game by its code (game_list shows games waiting for an opponent). The game\'s settings are its creator\'s.' },
    }),
  };
}

export class GoMatch {
  game: GoGame;
  seats: Record<Color, Seat | null> = { [BLACK]: null, [WHITE]: null } as Record<Color, Seat | null>;
  phase: Phase = 'waiting';
  dead = new Set<number>();
  accepted = new Set<Color>();
  result?: string;
  /** The code of the rematch played or offered from this game. */
  rematch?: string;
  createdAt = Date.now();
  updatedAt = Date.now();
  /** The bot is searching its reply (not persisted: a search does not survive a restart). */
  thinking = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(readonly code: string, readonly settings: GoSettings) { this.game = new GoGame(settings.size, settings.komi); }

  /** Calls on one match run one at a time (two players, a bot reply in between). */
  lock<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.tail.then(fn, fn);
    this.tail = r.catch(() => undefined);
    return r;
  }

  isBot(c: Color): boolean { return this.seats[c]?.kind === 'bot'; }
  agent(c: Color): Extract<Seat, { kind: 'agent' }> | null { const s = this.seats[c]; return s?.kind === 'agent' ? s : null; }
  web(c: Color): WebSeat | null { const s = this.seats[c]; return s?.kind === 'web' ? s : null; }
  /** The agent or person in a seat (null: open, or the bot). */
  player(c: Color): PlayerSeat | null { const s = this.seats[c]; return s && s.kind !== 'bot' ? s : null; }
  /** The colour `sub` plays from the web page here, if any. */
  webColor(sub: string): Color | null { return ([BLACK, WHITE] as Color[]).find((c) => this.web(c)?.sub === sub) ?? null; }
  /** `sub` sits at this board, by either door. */
  seated(sub: string): boolean { return ([BLACK, WHITE] as Color[]).some((c) => this.player(c)?.sub === sub); }
  label(c: Color, viewer?: Color): string {
    const s = this.seats[c];
    const who = !s ? 'open seat' : s.kind === 'bot' ? `bot, ${this.settings.level}` : s.kind === 'web' ? `${s.name}, on the web` : s.name;
    return `${colorName(c)}${viewer === c ? ' (you)' : ''} [${who}]`;
  }
  score() { return areaScore(this.game.board, this.game.n, this.game.komi, this.dead); }
  sgf(): string {
    const n = (c: Color) => { const s = this.seats[c]; return s?.kind === 'bot' ? `bot (${this.settings.level})` : s?.name ?? '?'; };
    return this.game.sgf({ black: n(BLACK), white: n(WHITE) }, this.result);
  }
}

/** One principal's seat at a match: an open instance of the go toolset. */
export interface GoRef { name: string; match: GoMatch; color: Color }

/** Something the other player (or the bot game's own player, elsewhere) should hear of. */
export interface GoEvent { sub: string; instance: string; text: string; tags: string[] }
/** One operation's consequences: which principals' state changed, events for them, suggestions. */
export interface GoChange { cause?: unknown; subs: string[]; events: GoEvent[]; suggest: Array<{ sub: string; reason: string }> }

type Out = { text: string; isError?: boolean };
const ok = (...lines: string[]): Out => ({ text: lines.filter(Boolean).join('\n') });
const fail = (text: string): Out => ({ text, isError: true });

/**
 * Every Go match on the server and the instances principals hold in them. Emits 'change'
 * (GoChange) after each operation, for the MCPL layer to tell connections.
 */
export class GoTables extends EventEmitter {
  private matches = new Map<string, GoMatch>();
  private counters = new Map<string, number>();
  /** Events for a principal no connection could take, delivered after its next toolsets/list. */
  private held = new Map<string, GoEvent[]>();
  /**
   * Instances that ended other than by toolsets/close (RFC-014 §5.3 `ended`, r5) — go_cancel, the one
   * way a Go instance ends by itself — recorded whoever was connected. Game over does not end an
   * instance (go_rematch and go_sgf stay). In memory only.
   */
  private ended = new Map<string, Array<{ id: string; instance: string; reason: string; at: number }>>();

  /** `origin`: the web viewer's, for the page links agents can hand to people. */
  constructor(private dir: string, private bots: BotPool, private log: (m: string) => void, private origin = '') {
    super();
    mkdirSync(dir, { recursive: true });
    this.load();
  }

  /** A match's page on the web viewer. */
  pageUrl(code: string): string { return `${this.origin}/go/${code}`; }

  // ---------------------------------------------------------------- lookup

  instances(sub: string): GoRef[] {
    const out: GoRef[] = [];
    for (const m of this.matches.values()) for (const c of [BLACK, WHITE] as Color[]) {
      const s = m.agent(c);
      if (s && s.sub === sub && s.instance) out.push({ name: s.instance, match: m, color: c });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  find(sub: string, name: string): GoRef | null { return this.instances(sub).find((r) => r.name === name) ?? null; }
  waiting(): GoMatch[] { return [...this.matches.values()].filter((m) => m.phase === 'waiting'); }
  describeWaiting(m: GoMatch): string {
    const c: Color = m.seats[BLACK] ? BLACK : WHITE;
    const s = m.player(c);
    return `${m.code} (${m.settings.size}×${m.settings.size}, komi ${m.settings.komi}: ${s?.name ?? '?'}${s?.kind === 'web' ? ' (on the web)' : ''} as ${colorName(c)})`;
  }

  visible(r: GoRef): string[] {
    const m = r.match;
    switch (m.phase) {
      case 'waiting': return ['go_cancel'];
      case 'playing':
        if (m.game.toMove !== r.color) return ['go_resign'];
        return m.isBot(other(r.color)) ? ['go_play', 'go_pass', 'go_resign', 'go_undo'] : ['go_play', 'go_pass', 'go_resign'];
      case 'scoring': return m.accepted.has(r.color) ? ['go_mark_dead', 'go_resume'] : ['go_mark_dead', 'go_accept', 'go_resume'];
      case 'over': return ['go_rematch', 'go_sgf'];
    }
  }

  /** Why a tool is not available in this instance now (for the tool error), or null. */
  unavailable(r: GoRef, tool: string): string | null {
    const now = this.visible(r);
    if (now.includes(tool)) return null;
    const m = r.match;
    const why = m.phase === 'waiting' ? `the game is waiting for an opponent (join code ${m.code})`
      : m.phase === 'playing' ? `it is ${colorName(m.game.toMove)}'s move`
      : m.phase === 'scoring' ? (tool === 'go_accept' ? 'you have accepted the score; your opponent has not yet' : 'the game is being scored')
      : 'the game is over';
    return `${tool} is not available right now in ${r.name}: ${why}. Available: ${now.join(', ')}.`;
  }

  title(r: GoRef): string {
    const m = r.match;
    const opp = m.seats[other(r.color)];
    const vs = !opp ? 'waiting for an opponent' : opp.kind === 'bot' ? `vs bot (${m.settings.level})` : `vs ${opp.name}${opp.kind === 'web' ? ' (on the web)' : ''}`;
    return `Go ${m.game.n}×${m.game.n} — you are ${colorName(r.color)}, ${vs}`;
  }

  /** The board and the state of play, as this player sees it. */
  view(r: GoRef): string {
    const m = r.match;
    const g = m.game;
    const last = g.lastMove;
    const scoring = m.phase === 'scoring' || (m.phase === 'over' && m.dead.size > 0);
    const sc = scoring ? m.score() : undefined;
    const lines = [renderBoard(g.board, g.n, { last: last?.point ?? undefined, dead: scoring ? m.dead : undefined, owner: sc?.owner })];
    lines.push(`${m.label(BLACK, r.color)} X, captured ${g.captures[BLACK]} · ${m.label(WHITE, r.color)} O, captured ${g.captures[WHITE]} · move ${g.moves.length} · komi ${g.komi}`);
    if (last) lines.push(`Last: ${colorName(last.color)} ${last.point === null ? 'passed' : `played ${pointName(last.point, g.n)}${last.captured ? `, capturing ${last.captured}` : ''}`}.`);
    if (m.phase === 'waiting') lines.push(`Waiting for an opponent: an agent opens the go toolset with options {join: "${m.code}"}; a person joins at ${this.pageUrl(m.code)}.`);
    if (m.phase === 'playing') lines.push(g.toMove === r.color ? 'Your move.' : `${colorName(g.toMove)} to move.`);
    if (sc) {
      lines.push(`Score as marked: ${sc.text}`);
      lines.push(`Dead (x/o): ${m.dead.size ? [...m.dead].map((p) => pointName(p, g.n)).join(' ') : 'none'}. # Black area, _ White area. Accepted: ${[BLACK, WHITE].filter((c) => m.accepted.has(c as Color)).map((c) => colorName(c as Color)).join(', ') || 'nobody yet'}.`);
    }
    if (m.phase === 'over' && m.result) lines.push(`Result: ${m.result}.`);
    return lines.join('\n');
  }

  /** id: the match code (random) and the instance name, so it is unique for the principal. */
  private recordEnd(sub: string, instance: string, id: string, reason: string) {
    this.ended.set(sub, [...(this.ended.get(sub) ?? []), { id, instance, reason, at: Date.now() }].slice(-20));
  }

  /** A principal's `ended` records from the last `withinMs`. */
  endedRecords(sub: string, withinMs: number) {
    const keep = (this.ended.get(sub) ?? []).filter((e) => e.at > Date.now() - withinMs);
    if (keep.length) this.ended.set(sub, keep); else this.ended.delete(sub);
    return keep;
  }

  /** Held events for a principal (each delivered once). */
  takeHeld(sub: string): GoEvent[] { const e = this.held.get(sub) ?? []; this.held.delete(sub); return e; }
  hold(e: GoEvent) { const list = this.held.get(e.sub) ?? []; list.push(e); if (list.length > 20) list.shift(); this.held.set(e.sub, list); }

  // ---------------------------------------------------------------- open / close

  /**
   * Open an instance: a new game against the bot, a game waiting for an agent, or a seat in a
   * waiting game by its code. A proposed name is used as given (or the open refused); an instance
   * by that name that is open already is adopted, changing nothing.
   */
  async open(p: Principal, proposed: string | undefined, o: Record<string, unknown>, cause?: unknown): Promise<{ ref: GoRef; adopted: boolean; text: string }> {
    if (proposed !== undefined && !INSTANCE_NAME.test(proposed)) throw new Fault(400, 'Instance names are letters, digits, _ . - (up to 64, starting with a letter or digit).');
    const bad = optionsProblem(o);
    if (bad) throw new Fault(400, `Invalid options: ${bad}.`);
    const name = proposed ?? this.nextName(p.sub);
    const existing = this.find(p.sub, name);
    if (existing) {
      const given = Object.keys(o);
      const note = given.length ? `${name} was already open; the options you gave (${given.join(', ')}) were not applied.` : `${name} was already open.`;
      return { ref: existing, adopted: true, text: `${note}\n${this.view(existing)}` };
    }
    const seat: PlayerSeat = { kind: 'agent', sub: p.sub, name: p.name, instance: name };
    if (typeof o.join === 'string') {
      const { match, color } = await this.join(o.join, seat, cause);
      const ref: GoRef = { name, match, color };
      return { ref, adopted: false, text: `${this.title(ref)}.\n${this.view(ref)}` };
    }
    const { match, color, lead } = await this.create(seat, o, cause);
    const ref: GoRef = { name, match, color };
    return { ref, adopted: false, text: [`${this.title(ref)}.`, lead, this.view(ref)].filter(Boolean).join('\n') };
  }

  /** A new match with `seat` in it: against the bot (playing at once), or waiting for an opponent. */
  private async create(seat: PlayerSeat, o: Record<string, unknown>, cause?: unknown): Promise<{ match: GoMatch; color: Color; lead: string }> {
    const settings: GoSettings = { size: Number(o.size ?? 9), komi: Number(o.komi ?? 7.5), level: (o.level as Level) ?? 'medium', opponent: (o.opponent as 'bot' | 'agent') ?? 'bot' };
    const m = new GoMatch(this.newCode(), settings);
    const color: Color = o.color === 'white' ? WHITE : o.color === 'random' ? (Math.random() < 0.5 ? BLACK : WHITE) : BLACK;
    m.seats[color] = seat;
    this.matches.set(m.code, m);
    let lead = '';
    await m.lock(async () => {
      if (settings.opponent === 'bot') {
        m.seats[other(color)] = { kind: 'bot' };
        m.phase = 'playing';
        if (color === WHITE) lead = await this.botMove(m);
      }
      this.save(m);
    });
    this.emitChange({ cause, subs: [seat.sub], events: [], suggest: [] });
    return { match: m, color, lead };
  }

  /** `seat` takes the empty seat of a waiting match; its creator, if an agent, hears of it. */
  private async join(code: string, seat: PlayerSeat, cause?: unknown): Promise<{ match: GoMatch; color: Color }> {
    const m = this.matches.get(code.trim().toUpperCase());
    if (!m || m.phase !== 'waiting') throw new Fault(400, m ? `Game ${m.code} has already started.` : `No game is waiting with the code "${code}"; game_list shows the open ones.`);
    const change: GoChange = { cause, subs: [seat.sub], events: [], suggest: [] };
    const color = await m.lock(async () => {
      if (m.phase !== 'waiting') throw new Fault(400, `Game ${m.code} has already started.`);
      const free: Color = m.seats[BLACK] ? WHITE : BLACK;
      m.seats[free] = seat;
      m.phase = 'playing';
      this.save(m);
      const creator = m.agent(other(free));
      if (creator?.instance) {
        const theirs = m.game.toMove !== free;
        change.subs.push(creator.sub);
        const who = `${seat.name}${seat.kind === 'web' ? ' (on the web)' : ''}`;
        this.event(change, creator, `${who} joined as ${colorName(free)}.${theirs ? ' Your move.' : ' They move first.'}`, theirs ? ['surface:turn', 'go:start'] : ['go:start'], { name: creator.instance, match: m, color: other(free) });
      }
      return free;
    });
    this.emitChange(change);
    return { match: m, color };
  }

  /** Close an instance (the host's act): a waiting game is withdrawn; leaving a live game against an agent forfeits it. */
  async close(p: Principal, name: string, cause?: unknown): Promise<string> {
    const ref = this.find(p.sub, name);
    if (!ref) return `${name} was not open.`;
    const m = ref.match;
    return m.lock(async () => {
      const change: GoChange = { cause, subs: [p.sub], events: [], suggest: [] };
      const me = ref.color;
      let said = 'Closed.';
      if (m.phase === 'waiting') { this.withdraw(m); said = 'Withdrawn: nobody had joined.'; }
      else if ((m.phase === 'playing' || m.phase === 'scoring') && !m.isBot(other(me))) {
        m.phase = 'over'; m.result = `${other(me) === BLACK ? 'B' : 'W'}+F`;
        this.tell(change, m, other(me), `${colorName(me)} left the game. ${colorName(other(me))} wins by forfeit (${m.result}).`, ['surface:done', 'go:over']);
        said = 'You left a live game: that is a forfeit.';
      } else if (m.phase === 'playing' || m.phase === 'scoring') said = 'Closed; the game against the bot is abandoned.';
      this.leave(m, me);
      this.emitChange(change);
      return said;
    });
  }

  // ---------------------------------------------------------------- the web page
  //
  // A person plays from the viewer: a web seat, no instance. Its actions are the toolset's tools,
  // run by the same code under the same lock, so an agent across the board hears of them exactly as
  // it hears of another agent's. The page learns of every change from 'match' (the code), emitted
  // whenever a match is saved or removed.

  private webSeat(p: Principal): WebSeat { return { kind: 'web', sub: p.sub, name: p.name }; }
  private webUnfinished(sub: string): number {
    let k = 0;
    for (const m of this.matches.values()) { const c = m.webColor(sub); if (c !== null && !m.web(c)!.left && m.phase !== 'over') k++; }
    return k;
  }
  private webRoom(sub: string) {
    if (this.webUnfinished(sub) >= WEB_SEATS_MAX) throw new Fault(429, `You have ${WEB_SEATS_MAX} unfinished games; finish or resign one first.`);
  }

  /** A new game started on the web page: against the bot, or waiting for an opponent (`opponent: 'agent'`). */
  async webCreate(p: Principal, o: Record<string, unknown>): Promise<GoMatch> {
    const bad = optionsProblem(o) ?? (o.join !== undefined ? 'join is not an option here: join the game from its page' : null);
    if (bad) throw new Fault(400, `Invalid options: ${bad}.`);
    this.webRoom(p.sub);
    return (await this.create(this.webSeat(p), o)).match;
  }

  /** The empty seat of a waiting game, taken from the web page. */
  async webJoin(p: Principal, code: string): Promise<GoMatch> {
    if (this.matches.get(code.toUpperCase())?.seated(p.sub)) throw new Fault(400, 'You are already playing in this game.');
    this.webRoom(p.sub);
    return (await this.join(code, this.webSeat(p))).match;
  }

  /** One of the toolset's tools, for the web seat `p` holds in the match `code`. */
  async webCall(p: Principal, code: string, tool: string, a: Record<string, unknown>): Promise<Out> {
    if (!isGoTool(tool)) throw new Fault(400, `No action ${tool}.`);
    const m = this.matches.get(code.toUpperCase());
    if (!m) throw new Fault(404, 'That game is not being played.');
    return m.lock(async () => {
      const color = m.webColor(p.sub);
      if (color === null || m.web(color)!.left) return fail('You are not playing in this game.');
      const ref: GoRef = { name: m.code, match: m, color };
      const why = this.unavailable(ref, tool);
      if (why) return fail(why);
      const change: GoChange = { subs: [p.sub], events: [], suggest: [] };
      const out = await this.run(ref, tool, a, change);
      this.emitChange(change);
      return out;
    });
  }

  /** A match by code: one in play, or one finished and retired (read from disk; `live` false). */
  lookup(code: string): { match: GoMatch; live: boolean } | null {
    const c = code.toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(c)) return null;
    const m = this.matches.get(c);
    if (m) return { match: m, live: true };
    try { return { match: this.revive(JSON.parse(readFileSync(this.file(c), 'utf8'))), live: false }; } catch { return null; }
  }

  /** The match as the page draws it. `viewer` sees their own seat and what they can do in it now. */
  webState(m: GoMatch, viewer: string | null, live = true) {
    const g = m.game;
    const key = (c: Color) => (c === BLACK ? 'black' : 'white');
    const seat = (c: Color) => {
      const s = m.seats[c];
      return !s ? null : s.kind === 'bot' ? { kind: 'bot', name: `Bot (${m.settings.level})` } : { kind: s.kind, name: s.name, sub: s.sub };
    };
    const you = viewer ? m.webColor(viewer) : null;
    const gone = you !== null && !!m.web(you)!.left;
    const scoring = m.phase === 'scoring' || (m.phase === 'over' && m.dead.size > 0);
    const sc = scoring ? m.score() : null;
    return {
      code: m.code, url: this.pageUrl(m.code), live, size: g.n, komi: g.komi, level: m.settings.level, opponent: m.settings.opponent,
      phase: m.phase, result: m.result ?? null, rematch: m.rematch ?? null, thinking: m.thinking,
      seats: { black: seat(BLACK), white: seat(WHITE) },
      board: Array.from(g.board), toMove: key(g.toMove), passes: g.passes,
      moves: g.moves.map((mv) => ({ color: key(mv.color), p: mv.point, point: mv.point === null ? null : pointName(mv.point, g.n), captured: mv.captured })),
      captures: { black: g.captures[BLACK], white: g.captures[WHITE] },
      dead: scoring ? [...m.dead] : [], owner: sc ? Array.from(sc.owner) : null,
      score: sc ? { black: sc.black, white: sc.white, komi: sc.komi, text: sc.text } : null,
      accepted: [...m.accepted].map(key),
      you: you === null ? null : key(you), left: gone,
      actions: live && you !== null && !gone ? this.visible({ name: m.code, match: m, color: you }) : [],
      joinable: live && m.phase === 'waiting' && !!viewer && !m.seated(viewer),
      createdAt: m.createdAt, updatedAt: m.updatedAt,
    };
  }

  /** The lobby's Go list: games waiting for an opponent, games in play, games recently finished. */
  webList(viewer: string | null) {
    const key = (c: Color) => (c === BLACK ? 'black' : 'white');
    const name = (m: GoMatch, c: Color) => { const s = m.seats[c]; return !s ? null : s.kind === 'bot' ? `Bot (${m.settings.level})` : s.name; };
    const row = (m: GoMatch) => {
      const you = viewer ? m.webColor(viewer) : null;
      const mine = you !== null && !m.web(you)!.left;
      return {
        code: m.code, size: m.game.n, komi: m.game.komi, phase: m.phase, result: m.result ?? null,
        black: name(m, BLACK), white: name(m, WHITE), moves: m.game.moves.length, toMove: key(m.game.toMove),
        you: mine ? key(you!) : null,
        yourTurn: mine && ((m.phase === 'playing' && m.game.toMove === you) || (m.phase === 'scoring' && !m.accepted.has(you!))),
        joinable: m.phase === 'waiting' && !!viewer && !m.seated(viewer),
        updatedAt: m.updatedAt,
      };
    };
    const all = [...this.matches.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      waiting: all.filter((m) => m.phase === 'waiting').map(row),
      playing: all.filter((m) => m.phase === 'playing' || m.phase === 'scoring').map(row),
      finished: all.filter((m) => m.phase === 'over').slice(0, 12).map(row),
    };
  }

  // ---------------------------------------------------------------- calls

  /** A call in one instance. The tool's visibility is checked again under the match's lock. */
  async call(p: Principal, ref: GoRef, tool: string, a: Record<string, unknown>, cause?: unknown): Promise<Out> {
    const m = ref.match;
    return m.lock(async () => {
      const now = this.find(p.sub, ref.name);
      if (!now) return fail(`${ref.name} is no longer open.`);
      if (now.match !== m) return this.call(p, now, tool, a, cause); // a rematch moved the instance meanwhile
      const why = this.unavailable(now, tool);
      if (why) return fail(why);
      const change: GoChange = { cause, subs: [p.sub], events: [], suggest: [] };
      const out = await this.run(now, tool, a, change);
      this.emitChange(change);
      return out;
    });
  }

  private async run(r: GoRef, tool: string, a: Record<string, unknown>, change: GoChange): Promise<Out> {
    const m = r.match;
    const me = r.color;
    const g = m.game;
    const opp = other(me);
    switch (tool) {
      case 'go_play': {
        const pt = parsePoint(String(a.point ?? ''), g.n);
        if (pt === null) return fail(`"${String(a.point)}" is not a point on a ${g.n}×${g.n} board (column A–T without I, then the row from the bottom).`);
        const res = g.play(pt);
        if (!res.ok) return fail(`${pointName(pt, g.n)} is illegal: ${res.reason}.`);
        this.save(m);
        const cap = res.captured.length ? `, capturing ${res.captured.length}` : '';
        return this.after(r, change, `You played ${pointName(pt, g.n)}${cap}.`, `${colorName(me)} played ${pointName(pt, g.n)}${cap}.`);
      }
      case 'go_pass': {
        g.pass(); this.save(m);
        if (g.passes >= 2) return this.scoring(r, change, 'You passed; that is two passes.');
        return this.after(r, change, 'You passed.', `${colorName(me)} passed — pass too to end play.`);
      }
      case 'go_resign': {
        m.phase = 'over'; m.result = `${opp === BLACK ? 'B' : 'W'}+R`; this.save(m);
        this.tell(change, m, opp, `${colorName(me)} resigned. ${colorName(opp)} wins (${m.result}).`, ['surface:done', 'go:over']);
        return ok(`You resigned. ${colorName(opp)} wins (${m.result}).`);
      }
      case 'go_undo': {
        const back = [...g.moves].reverse().findIndex((mv) => mv.color === me);
        if (back < 0) return fail('Nothing of yours to undo.');
        for (let i = 0; i <= back; i++) g.undo();
        this.save(m);
        return ok(`Took back ${back + 1} move${back ? 's' : ''}.`, this.view(r));
      }
      case 'go_cancel': {
        const agent = m.agent(me);
        this.withdraw(m); this.leave(m, me);
        if (!agent) return ok('Withdrawn: nobody had joined.');
        // The call's result reports the instance closing; the record is kept as well (RFC-014 r5 §5.3).
        this.recordEnd(agent.sub, r.name, `go-${m.code}-${r.name}`, `withdrawn with go_cancel before anyone joined (${m.code})`);
        return ok('Withdrawn: nobody had joined. The instance is closed.');
      }
      case 'go_mark_dead': {
        const pts = (Array.isArray(a.points) ? a.points : []).map((s) => ({ s: String(s), p: parsePoint(String(s), g.n) }));
        if (!pts.length) return fail('points: give at least one point, e.g. ["C3"].');
        const bad = pts.filter((x) => x.p === null || g.board[x.p] === 0).map((x) => x.s);
        if (bad.length) return fail(`No stones at ${bad.join(', ')}.`);
        for (const { p } of pts) {
          const was = m.dead.has(p!);
          for (const s of groupAt(g.board, g.n, p!).stones) { if (was) m.dead.delete(s); else m.dead.add(s); }
        }
        m.accepted.clear();
        if (m.isBot(opp)) m.accepted.add(opp);
        this.save(m);
        this.tell(change, m, opp, `${colorName(me)} changed the dead stones. Score as marked: ${m.score().text}`, ['surface:turn', 'go:scoring'], true);
        return ok(`Marked. Score as marked: ${m.score().text}`, this.view(r));
      }
      case 'go_accept': {
        m.accepted.add(me);
        if (m.accepted.size === 2) return this.finish(r, change, 'Both accepted.');
        this.save(m);
        this.tell(change, m, opp, `${colorName(me)} accepted the score as marked: ${m.score().text}`, ['surface:turn', 'go:scoring']);
        return ok('Accepted. Waiting for your opponent.');
      }
      case 'go_resume': {
        m.phase = 'playing'; m.dead.clear(); m.accepted.clear(); this.save(m);
        const next = g.toMove;
        this.tell(change, m, opp, `${colorName(me)} resumed play. ${colorName(next)} to move.`, next === opp ? ['surface:turn', 'go:scoring'] : ['go:scoring'], true);
        if (next !== me && m.isBot(next)) return this.after(r, change, 'Play resumed.', '');
        return ok(`Play resumed. ${next === me ? 'Your move.' : `${colorName(next)} to move.`}`, this.view(r));
      }
      case 'go_rematch': return this.rematch(r, change);
      case 'go_sgf': return ok(m.sgf());
      default: return fail(`No tool ${tool}.`);
    }
  }

  /** After a move: the bot replies inside the call, or the other agent hears of it. */
  private async after(r: GoRef, change: GoChange, mine: string, forOpponent: string): Promise<Out> {
    const m = r.match;
    if (!m.isBot(other(r.color))) {
      if (forOpponent) this.tell(change, m, other(r.color), `${forOpponent} Your move.`, ['surface:turn', 'go:move'], true);
      return ok(mine, this.view(r));
    }
    const reply = await this.botMove(m);
    if (m.phase === 'scoring') return this.scoring(r, change, `${mine} ${reply}`);
    return ok(mine, reply, this.view(r));
  }

  private async botMove(m: GoMatch): Promise<string> {
    const g = m.game; const c = g.toMove;
    m.thinking = true; this.emit('match', m.code);
    let mv: Awaited<ReturnType<BotPool['move']>>;
    try { mv = await this.bots.move(g, m.settings.level); } finally { m.thinking = false; }
    if (mv.resign) { m.phase = 'over'; m.result = `${c === BLACK ? 'W' : 'B'}+R`; this.save(m); return `${colorName(c)} (bot) resigns — you win (${m.result}).`; }
    if (mv.point === null) {
      g.pass(); this.save(m);
      if (g.passes >= 2) { await this.enterScoring(m); return `${colorName(c)} (bot) passes too.`; }
      return `${colorName(c)} (bot) passes.`;
    }
    const res = g.play(mv.point);
    if (!res.ok) { g.pass(); this.save(m); return `${colorName(c)} (bot) passes.`; }
    this.save(m);
    return `${colorName(c)} (bot) plays ${pointName(mv.point, g.n)}${res.captured.length ? `, capturing ${res.captured.length}` : ''}.`;
  }

  private async enterScoring(m: GoMatch) {
    m.phase = 'scoring';
    m.dead = await this.bots.dead(m.game);
    m.accepted.clear();
    for (const c of [BLACK, WHITE] as Color[]) if (m.isBot(c)) m.accepted.add(c);
    this.save(m);
  }

  private async scoring(r: GoRef, change: GoChange, lead: string): Promise<Out> {
    const m = r.match;
    if (m.phase !== 'scoring') await this.enterScoring(m);
    const proposed = m.dead.size ? `Proposed dead: ${[...m.dead].map((p) => pointName(p, m.game.n)).join(' ')}.` : 'No stones proposed dead.';
    this.tell(change, m, other(r.color), `Both passed — scoring. ${proposed} ${m.score().text}`, ['surface:turn', 'go:scoring'], true);
    return ok(lead, `Play is over — scoring. ${proposed} go_mark_dead changes the marking; go_accept agrees.`, this.view(r));
  }

  private finish(r: GoRef, change: GoChange, lead: string): Out {
    const m = r.match; const sc = m.score();
    m.phase = 'over'; m.result = `${sc.winner === BLACK ? 'B' : 'W'}+${Math.abs(sc.margin)}`; this.save(m);
    this.tell(change, m, other(r.color), `${lead} ${sc.text} (${m.result})`, ['surface:done', 'go:over']);
    return ok(`${lead} ${sc.text}`, `Result: ${m.result}.`);
  }

  /** Against the bot: a new game at once, colours swapped. Against an agent: offer one, or take theirs. */
  private async rematch(r: GoRef, change: GoChange): Promise<Out> {
    const m = r.match; const me = r.color; const opp = other(me);
    const mine = m.player(me)!;
    // The same player in the next match: an agent keeps its instance name, a web seat is a new one.
    const carried = (): PlayerSeat => mine.kind === 'agent' ? { kind: 'agent', sub: mine.sub, name: mine.name, instance: r.name } : { kind: 'web', sub: mine.sub, name: mine.name };
    if (m.isBot(opp)) {
      const next = new GoMatch(this.newCode(), m.settings);
      next.seats[opp] = carried();
      next.seats[me] = { kind: 'bot' };
      next.phase = 'playing';
      this.matches.set(next.code, next);
      m.rematch = next.code;
      this.leave(m, me);
      const ref: GoRef = { name: r.name, match: next, color: opp };
      const lead = next.game.toMove !== opp ? await next.lock(() => this.botMove(next)) : '';
      this.save(next);
      return ok(`New game: you are ${colorName(opp)}.${lead ? '' : ' Your move.'}`, lead, this.view(ref));
    }
    const offer = m.rematch ? this.matches.get(m.rematch) : undefined;
    if (offer && offer.phase === 'waiting') {
      const free: Color = offer.seats[BLACK] ? WHITE : BLACK;
      offer.seats[free] = carried();
      offer.phase = 'playing';
      this.leave(m, me);
      this.save(offer);
      const creator = offer.agent(other(free));
      if (creator?.instance) {
        const theirs = offer.game.toMove !== free;
        change.subs.push(creator.sub);
        this.event(change, creator, `${mine.name} accepted the rematch.${theirs ? ' Your move.' : ''}`, theirs ? ['surface:turn', 'go:start'] : ['go:start'], { name: creator.instance, match: offer, color: other(free) });
      }
      const ref: GoRef = { name: r.name, match: offer, color: free };
      return ok(`Rematch on: you are ${colorName(free)}.${offer.game.toMove === free ? ' Your move.' : ''}`, this.view(ref));
    }
    const next = new GoMatch(this.newCode(), m.settings);
    next.seats[opp] = carried();
    this.matches.set(next.code, next);
    m.rematch = next.code;
    this.leave(m, me);
    this.save(next);
    const them = m.agent(opp);
    if (them?.instance) this.tell(change, m, opp, `${mine.name} offers a rematch with colours swapped — go_rematch accepts.`, ['surface:invite', 'go:rematch']);
    else if (them) change.suggest.push({ sub: them.sub, reason: `${mine.name} offers a Go rematch: open go with {join: "${next.code}"}.` });
    return ok(`Rematch offered (code ${next.code}); waiting for your opponent.`);
  }

  // ---------------------------------------------------------------- bookkeeping

  /** An event for the player in seat `c` of `m`, if an agent with an open instance sits there. */
  private tell(change: GoChange, m: GoMatch, c: Color, text: string, tags: string[], board = false) {
    const s = m.agent(c);
    if (!s?.instance) return;
    if (!change.subs.includes(s.sub)) change.subs.push(s.sub);
    this.event(change, s, text, tags, board ? { name: s.instance, match: m, color: c } : null);
  }

  private event(change: GoChange, s: { sub: string; instance: string | null }, text: string, tags: string[], boardFor: GoRef | null) {
    if (!s.instance) return;
    change.events.push({ sub: s.sub, instance: s.instance, text: boardFor ? `${text}\n${this.view(boardFor)}` : text, tags });
  }

  private emitChange(change: GoChange) { this.emit('change', change); }

  /** A player leaves the match (an agent's instance closes; a web seat withdraws or moves to a rematch); a match nobody holds any more is retired (kept on disk). */
  private leave(m: GoMatch, c: Color) {
    const s = m.seats[c];
    if (s?.kind === 'agent') s.instance = null;
    else if (s?.kind === 'web') s.left = true;
    if (held(m)) { this.save(m); return; }
    this.matches.delete(m.code);
    if (m.phase === 'waiting') this.remove(m); else this.save(m, true);
  }

  /** A waiting game nobody joined: it goes when its creator's instance does (leave() deletes it). */
  private withdraw(m: GoMatch) { m.result = 'withdrawn'; }

  private nextName(sub: string): string {
    let n = this.counters.get(sub) ?? 0;
    const used = new Set(this.instances(sub).map((r) => r.name));
    do n++; while (used.has(`go-${n}`));
    this.counters.set(sub, n);
    return `go-${n}`;
  }

  private newCode(): string {
    let code: string;
    do code = randomBytes(4).toString('hex').slice(0, 6).toUpperCase(); while (this.matches.has(code));
    return code;
  }

  // ---------------------------------------------------------------- persistence

  private file(code: string) { return join(this.dir, `${code}.json`); }

  /** Every save and removal is a change the web page shows ('match', with the code). */
  private save(m: GoMatch, retired = false) {
    const seat = (c: Color) => m.seats[c];
    m.updatedAt = Date.now();
    try {
      writeFileSync(this.file(m.code), JSON.stringify({
        code: m.code, settings: m.settings, phase: m.phase, result: m.result ?? null, rematch: m.rematch ?? null,
        seats: { black: seat(BLACK), white: seat(WHITE) }, game: m.game.toJSON(), dead: [...m.dead], accepted: [...m.accepted],
        createdAt: m.createdAt, updatedAt: m.updatedAt, ...(retired ? { retired: true } : {}),
      }));
    } catch (e) { this.log(`go: could not save ${m.code}: ${(e as Error).message}`); }
    this.emit('match', m.code);
  }

  private remove(m: GoMatch) { try { unlinkSync(this.file(m.code)); } catch { /* gone */ } this.emit('match', m.code); }

  private revive(j: any): GoMatch {
    const m = new GoMatch(j.code, j.settings);
    m.game = GoGame.fromJSON(j.game);
    m.seats = { [BLACK]: j.seats.black ?? null, [WHITE]: j.seats.white ?? null } as Record<Color, Seat | null>;
    m.phase = j.phase; m.result = j.result ?? undefined; m.rematch = j.rematch ?? undefined;
    m.dead = new Set(j.dead ?? []); m.accepted = new Set(j.accepted ?? []);
    m.createdAt = j.createdAt ?? Date.now(); m.updatedAt = j.updatedAt ?? m.createdAt;
    return m;
  }

  /**
   * Matches someone still holds come back after a restart, with their instances. A finished game
   * only web seats hold stays on disk (its page still shows it) rather than in memory.
   */
  private load() {
    if (!existsSync(this.dir)) return;
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(readFileSync(join(this.dir, f), 'utf8'));
        if (j.retired) continue;
        const m = this.revive(j);
        if (m.phase === 'over' && !([BLACK, WHITE] as Color[]).some((c) => m.agent(c)?.instance)) continue;
        if (!held(m)) continue;
        this.matches.set(m.code, m);
      } catch (e) { this.log(`go: could not load ${f}: ${(e as Error).message}`); }
    }
    if (this.matches.size) this.log(`go: ${this.matches.size} game(s) back from disk`);
  }
}

/** Someone still holds the match: an agent's open instance, or a web seat that has not left. */
function held(m: GoMatch): boolean {
  return ([BLACK, WHITE] as Color[]).some((c) => { const s = m.seats[c]; return s?.kind === 'agent' ? !!s.instance : s?.kind === 'web' ? !s.left : false; });
}

function optionsProblem(o: Record<string, unknown>): string | null {
  for (const k of Object.keys(o)) if (!OPTION_KEYS.includes(k)) return `unknown option "${k}" (options: ${OPTION_KEYS.join(', ')})`;
  if (o.size !== undefined && ![9, 13, 19].includes(o.size as number)) return 'size must be 9, 13 or 19';
  if (o.color !== undefined && !['black', 'white', 'random'].includes(o.color as string)) return 'color must be black, white or random';
  if (o.opponent !== undefined && !['bot', 'agent'].includes(o.opponent as string)) return 'opponent must be bot or agent';
  if (o.level !== undefined && !['easy', 'medium', 'hard'].includes(o.level as string)) return 'level must be easy, medium or hard';
  if (o.komi !== undefined && !(typeof o.komi === 'number' && o.komi >= 0 && o.komi <= 15)) return 'komi must be a number from 0 to 15';
  if (o.join !== undefined && typeof o.join !== 'string') return 'join must be a code (a string)';
  return null;
}
