// Game sessions: one engine per playing agent, a log of turns for watchers, chat
// between watchers and the player, and a small results ledger.
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Config } from './config.js';
import { Engine, EngineError, type Observation } from './engine.js';
import { Fault } from './auth.js';
import { Recordings } from './recordings.js';

export interface Principal { sub: string; name: string; kind: 'human' | 'agent' | 'service'; issuer: string; admin: boolean }

export interface ChatMessage { id: number; at: number; from: { sub: string; name: string; kind: string }; text: string }

export interface TurnRecord {
  n: number; at: number; by: 'agent' | 'system';
  actions: unknown[]; say?: string; events: string[]; stopped_early?: string | null;
  status: Observation['status']; position?: Observation['position']; took_ms?: number;
}

export type GameStatus = 'running' | 'dead' | 'complete' | 'stopped';

export interface PublicGame {
  id: string; player: { sub: string; name: string; kind: string }; game: string; map: string; skill: number;
  status: GameStatus; turn: number; createdAt: number; lastActiveAt: number; endedAt?: number;
  health?: number; armor?: number; kills?: number; items?: number; secrets?: number; time_s?: number; weapon?: string;
  watchers: number; lastSay?: string; lastEvents?: string[];
}

export interface Catalogue { games: Record<string, { title: string; maps: string[] }>; skills: Record<string, string> }

const E1 = Array.from({ length: 36 }, (_, i) => `E${Math.floor(i / 9) + 1}M${(i % 9) + 1}`);
const MAPS = Array.from({ length: 32 }, (_, i) => `MAP${String(i + 1).padStart(2, '0')}`);
export const SKILLS: Record<string, string> = { 1: "I'm too young to die", 2: 'Hey, not too rough', 3: 'Hurt me plenty', 4: 'Ultra-Violence', 5: 'Nightmare!' };

export function catalogue(wadDir: string | null): Catalogue {
  const games: Catalogue['games'] = {
    freedoom1: { title: 'Freedoom: Phase 1 (free Doom-compatible campaign, 4 episodes × 9 maps)', maps: E1 },
    freedoom2: { title: 'Freedoom: Phase 2 (free Doom II-compatible campaign, 32 maps)', maps: MAPS },
  };
  if (wadDir && existsSync(join(wadDir, 'doom.wad'))) games.doom = { title: 'The Ultimate DOOM (4 episodes × 9 maps)', maps: E1 };
  if (wadDir && existsSync(join(wadDir, 'doom2.wad'))) games.doom2 = { title: 'DOOM II: Hell on Earth (32 maps)', maps: MAPS };
  if (wadDir && existsSync(join(wadDir, 'heretic.wad'))) games.heretic = { title: 'Heretic: Shadow of the Serpent Riders (5 episodes × 9 maps; staff, elven wand, crossbow, dragon claw…; gargoyles, golems, undead warriors)', maps: Array.from({ length: 45 }, (_, i) => `E${Math.floor(i / 9) + 1}M${(i % 9) + 1}`) };
  return { games, skills: SKILLS };
}

export function nextMap(game: string, map: string, cat: Catalogue): string | null {
  const maps = cat.games[game]?.maps ?? [];
  const i = maps.indexOf(map);
  if (i < 0) return null;
  // Doom episodes end on M8 (M9 is the secret level); Doom II runs straight through.
  if (/^E\dM8$/.test(map)) { const e = Number(map[1]); return maps.includes(`E${e + 1}M1`) ? `E${e + 1}M1` : null; }
  if (/^E\dM9$/.test(map)) return `E${map[1]}M2`;
  return maps[i + 1] ?? null;
}

export class GameSession {
  readonly id: string;
  readonly createdAt: number;
  lastActiveAt = Date.now();
  endedAt?: number;
  status: GameStatus = 'running';
  turn = 0;
  log: TurnRecord[] = [];
  chat: ChatMessage[] = [];
  /** Chat the player has not been shown yet. */
  unread: ChatMessage[] = [];
  frame: Buffer | null = null;
  automap: Buffer | null = null;
  last: Observation | null = null;
  lastSay?: string;
  watchers = new Set<unknown>();
  private chatId = 1;
  /** Serializes the player's own calls so two hosts can't interleave turns. */
  busy = false;
  /** MCPL RFC-014: closing the game toolset leaves this game running (the `keep` open option). */
  keep = false;
  /** Closed with `keep`: still running, but its toolset stays closed until it is opened again. */
  parked = false;

  constructor(readonly owner: Principal, readonly game: string, public map: string, readonly skill: number, readonly engine: Engine, id?: string, createdAt?: number) {
    this.id = id ?? `g${randomBytes(4).toString('hex')}`;
    this.createdAt = createdAt ?? Date.now();
  }

  record(obs: Observation, actions: unknown[], say: string | undefined, by: TurnRecord['by'] = 'agent'): TurnRecord {
    this.lastActiveAt = Date.now();
    this.turn = obs.turn ?? this.turn;
    this.takeView(obs);
    const { frame_jpeg: _f, automap_jpeg: _a, ...rest } = obs;
    this.last = rest;
    if (say) this.lastSay = say;
    const rec: TurnRecord = { n: this.turn, at: Date.now(), by, actions, ...(say ? { say } : {}), events: obs.events ?? [], stopped_early: obs.stopped_early ?? null, status: obs.status, position: obs.position, took_ms: obs.took_ms };
    this.log.push(rec);
    if (this.log.length > 600) this.log.splice(0, this.log.length - 600);
    if (obs.dead) this.status = 'dead';
    else if (obs.finished) this.status = 'complete';
    return rec;
  }

  /** Keep the viewer's full-size pictures and strip them from what the player sees. */
  takeView(obs: Observation) {
    if (obs.view?.frame) this.frame = Buffer.from(obs.view.frame, 'base64');
    if (obs.view?.automap) this.automap = Buffer.from(obs.view.automap, 'base64');
    delete obs.view;
  }

  addChat(from: ChatMessage['from'], text: string): ChatMessage {
    const msg: ChatMessage = { id: this.chatId++, at: Date.now(), from, text };
    this.chat.push(msg);
    if (this.chat.length > 300) this.chat.splice(0, this.chat.length - 300);
    this.unread.push(msg);
    if (this.unread.length > 50) this.unread.splice(0, this.unread.length - 50);
    return msg;
  }

  takeUnread(): ChatMessage[] { const u = this.unread; this.unread = []; return u; }

  public(): PublicGame {
    const s = this.last?.status ?? {};
    const lastTurn = this.log[this.log.length - 1];
    return {
      id: this.id, player: { sub: this.owner.sub, name: this.owner.name, kind: this.owner.kind }, game: this.game, map: this.map, skill: this.skill,
      status: this.status, turn: this.turn, createdAt: this.createdAt, lastActiveAt: this.lastActiveAt, ...(this.endedAt ? { endedAt: this.endedAt } : {}),
      health: s.health, armor: s.armor, kills: s.kills, items: s.items, secrets: s.secrets, time_s: s.time_s, weapon: s.weapon,
      watchers: this.watchers.size, ...(this.lastSay ? { lastSay: this.lastSay } : {}), lastEvents: lastTurn?.events?.slice(-3),
    };
  }
}

export interface ActOptions { say?: string; stop_on?: string[]; image?: string; image_scale?: number }

/**
 * A change to what a player's game is (started, a new episode, died, finished, ended), for the
 * MCPL hints. `cause` is whatever the caller passed in (an MCPL connection), so the connection
 * whose call caused it can report it in that call's result and the others are told separately.
 */
export interface StateChange { cause?: unknown; started?: GameSession; ended?: { session: GameSession; why: string } }

/**
 * Events: 'list' (lobby changed) · 'turn' (session, record) · 'chat' (session, msg) · 'ended' (session) ·
 * 'state' (owner sub, StateChange).
 */
export class Games extends EventEmitter {
  readonly sessions = new Map<string, GameSession>();
  /** Finished games kept for the lobby. */
  readonly recent: PublicGame[] = [];
  private byOwner = new Map<string, GameSession>();
  /**
   * Each player's ended games, for MCPL toolsets/list `ended` (RFC-014 §5.3): every end the host did
   * not ask for with toolsets/close — the player's own game_stop, the web viewer's stop, the idle
   * sweep, an engine that died — whoever was connected. In memory only: after a restart there is
   * nothing to report.
   */
  readonly ended = new Map<string, Array<{ id: string; why: string; summary: string; at: number }>>();

  /** A player's `ended` records from the last `withinMs` (older ones are dropped). */
  endedRecords(sub: string, withinMs: number) {
    const keep = (this.ended.get(sub) ?? []).filter((e) => e.at > Date.now() - withinMs);
    if (keep.length) this.ended.set(sub, keep); else this.ended.delete(sub);
    return keep;
  }

  readonly catalogue: Catalogue;
  readonly recordings: Recordings;
  private sweeper: NodeJS.Timeout;

  constructor(private config: Config, private log: (m: string) => void) {
    super();
    this.setMaxListeners(200);
    this.catalogue = catalogue(config.wadDir);
    mkdirSync(config.dataDir, { recursive: true });
    this.recordings = new Recordings(config.dataDir, config.keepRecordings, log);
    this.on('turn', (s: GameSession, r: TurnRecord) => this.recordings.turn(s, r));
    this.on('chat', (s: GameSession, m: ChatMessage) => this.recordings.chat(s, m));
    this.on('ended', (s: GameSession) => this.recordings.ended(s));
    this.loadRecent();
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  // ---------------------------------------------------------------- lookup

  mine(owner: Principal): GameSession | null { return this.byOwner.get(owner.sub) ?? null; }
  get(id: string): GameSession | null { return this.sessions.get(id) ?? null; }
  list(): PublicGame[] { return [...this.sessions.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt).map((s) => s.public()); }

  // ---------------------------------------------------------------- play

  async start(owner: Principal, opts: { game?: string; map?: string; skill?: number; image?: string; image_scale?: number }, cause?: unknown): Promise<{ session: GameSession; obs: Observation }> {
    const game = (opts.game ?? 'freedoom1').toLowerCase();
    const entry = this.catalogue.games[game];
    if (!entry) throw new Fault(400, `Unknown game "${game}". Available: ${Object.keys(this.catalogue.games).join(', ')}.`);
    const map = (opts.map ?? entry.maps[0]).toUpperCase();
    if (!entry.maps.includes(map)) throw new Fault(400, `Unknown map "${map}" for ${game}; maps run ${entry.maps[0]}…${entry.maps[entry.maps.length - 1]}.`);
    const skill = Math.min(5, Math.max(1, Math.round(Number(opts.skill ?? 3) || 3)));

    const existing = this.byOwner.get(owner.sub);
    if (existing && existing.game === game && existing.skill === skill && existing.status !== 'stopped' && !existing.engine.closed) {
      // Same engine, new episode: keeps the viewer's page and log continuity.
      return this.withLock(existing, async () => {
        const obs = await existing.engine.call<Observation>('start', { game, map, skill, image: opts.image ?? 'frame', image_scale: opts.image_scale ?? 1 });
        existing.map = map;
        existing.status = 'running';
        existing.record(obs, [{ start: `${game} ${map} skill ${skill}` }], undefined, 'system');
        this.emit('turn', existing, existing.log[existing.log.length - 1]);
        this.emit('list');
        this.emit('state', owner.sub, { cause, started: existing } satisfies StateChange);
        await this.autosave(existing);
        return { session: existing, obs };
      });
    }
    if (existing) await this.end(existing, 'stopped', 'replaced by a new game', cause, false);
    if (this.sessions.size >= this.config.maxGames) throw new Fault(503, `All ${this.config.maxGames} game slots are busy right now; try again in a little while.`);

    const id = `g${randomBytes(4).toString('hex')}`;
    const cwd = this.recordings.prepare(id);
    const engine = new Engine(this.config.python, this.config.sidecar, { ...(this.config.wadDir ? { DOOM_WAD_DIR: this.config.wadDir } : {}) }, (m) => this.log(`[${owner.name}] ${m}`), cwd);
    const session = new GameSession(owner, game, map, skill, engine, id);
    session.keep = existing?.keep ?? false;
    this.sessions.set(session.id, session);
    this.byOwner.set(owner.sub, session);
    this.emit('list');
    try {
      const obs = await engine.call<Observation>('start', { game, map, skill, image: opts.image ?? 'frame', image_scale: opts.image_scale ?? 1 }, 90_000);
      session.record(obs, [{ start: `${game} ${map} skill ${skill}` }], undefined, 'system');
      this.emit('turn', session, session.log[session.log.length - 1]);
      this.emit('list');
      this.emit('state', owner.sub, { cause, started: session } satisfies StateChange);
      await this.autosave(session);
      this.log(`${owner.name} started ${game} ${map} (skill ${skill}) as ${session.id}`);
      return { session, obs };
    } catch (e) {
      await this.end(session, 'stopped', `engine failed: ${(e as Error).message}`, cause);
      throw e instanceof Fault ? e : new Fault(500, `The game engine could not start: ${(e as Error).message}`);
    }
  }

  async act(owner: Principal, actions: unknown[], opts: ActOptions, cause?: unknown): Promise<{ session: GameSession; obs: Observation }> {
    const session = this.requireMine(owner, cause);
    return this.withLock(session, async () => {
      const obs = await session.engine.call<Observation>('act', { actions, stop_on: opts.stop_on, image: opts.image ?? 'frame', image_scale: opts.image_scale ?? 1 });
      const before = session.status;
      const rec = session.record(obs, actions, opts.say);
      this.emit('turn', session, rec);
      this.emit('list');
      if (session.status !== before) this.emit('state', owner.sub, { cause } satisfies StateChange);
      await this.autosave(session);
      return { session, obs };
    });
  }

  async look(owner: Principal, image = 'frame', image_scale = 1, cause?: unknown): Promise<{ session: GameSession; obs: Observation }> {
    const session = this.requireMine(owner, cause);
    return this.withLock(session, async () => {
      const obs = await session.engine.call<Observation>('look', { image, image_scale });
      session.lastActiveAt = Date.now();
      session.takeView(obs);
      const { frame_jpeg: _f, automap_jpeg: _a, ...rest } = obs;
      session.last = rest;
      return { session, obs };
    });
  }

  say(owner: Principal, text: string, cause?: unknown): GameSession {
    const session = this.requireMine(owner, cause);
    session.lastSay = text;
    session.lastActiveAt = Date.now();
    const rec: TurnRecord = { n: session.turn, at: Date.now(), by: 'agent', actions: [], say: text, events: [], status: session.last?.status ?? {} };
    session.log.push(rec);
    this.emit('turn', session, rec);
    this.emit('list');
    return session;
  }

  /** End the player's game. `byClose`: the MCPL host closed its toolset, an end it asked for (not an `ended` record). */
  async stop(owner: Principal, cause?: unknown, byClose = false): Promise<GameSession | null> {
    const session = this.byOwner.get(owner.sub);
    if (!session) return null;
    await this.end(session, 'stopped', byClose ? 'the game toolset was closed' : 'stopped by the player', cause, !byClose);
    return session;
  }

  /** Toolset flags (MCPL RFC-014) — kept in state.json so they survive a restart like the game. */
  setToolset(session: GameSession, flags: { keep?: boolean; parked?: boolean }, cause?: unknown) {
    const was = session.parked;
    if (flags.keep !== undefined) session.keep = flags.keep;
    if (flags.parked !== undefined) session.parked = flags.parked;
    if (this.sessions.has(session.id)) this.recordings.writeState(session.id, { ...(this.recordings.readState(session.id) ?? {}), ...this.stateOf(session) });
    if (session.parked !== was) this.emit('state', session.owner.sub, { cause } satisfies StateChange);
  }

  chat(session: GameSession, from: ChatMessage['from'], text: string): ChatMessage {
    const msg = session.addChat(from, text);
    this.emit('chat', session, msg);
    return msg;
  }

  // ---------------------------------------------------------------- persistence

  /** After every turn: ZDoom savegame + state.json, so a server restart can pick the game back up. */
  private async autosave(session: GameSession) {
    if (session.status !== 'running') { this.recordings.writeState(session.id, { ...this.stateOf(session), resumable: false }); return; }
    try {
      const r = await session.engine.call<{ saved: boolean; visited?: number[]; gave_up?: Record<string, number>; turn?: number; reason?: string }>('save', { name: 'autosave' }, 20_000);
      this.recordings.writeState(session.id, { ...this.stateOf(session), resumable: !!r.saved, visited: r.visited ?? [], gave_up: r.gave_up ?? {}, savedAt: Date.now() });
    } catch (e) { this.log(`autosave ${session.id} failed: ${(e as Error).message}`); }
  }

  private stateOf(session: GameSession) {
    return { id: session.id, owner: session.owner, game: session.game, map: session.map, skill: session.skill, createdAt: session.createdAt, turn: session.turn, lastSay: session.lastSay ?? null, status: session.status, keep: session.keep, parked: session.parked };
  }

  /** Bring back the games that were running when the server last stopped. */
  async resumeAll() {
    for (const id of this.recordings.resumable()) {
      const st = this.recordings.readState(id);
      if (!st || !st.owner || this.sessions.size >= this.config.maxGames) continue;
      const owner: Principal = st.owner;
      const engine = new Engine(this.config.python, this.config.sidecar, { ...(this.config.wadDir ? { DOOM_WAD_DIR: this.config.wadDir } : {}) }, (m) => this.log(`[${owner.name}] ${m}`), this.recordings.path(id));
      const session = new GameSession(owner, st.game, st.map, st.skill, engine, id, st.createdAt);
      session.turn = st.turn ?? 0;
      session.lastSay = st.lastSay ?? undefined;
      session.keep = st.keep === true;
      session.parked = st.parked === true;
      // replay the recorded log and chat so watchers and the player see history
      for (const e of this.recordings.events(id) as any[]) {
        if (e?.type === 'turn' && e.record) session.log.push(e.record);
        else if (e?.type === 'chat' && e.message) session.chat.push(e.message);
      }
      if (session.log.length > 600) session.log.splice(0, session.log.length - 600);
      this.sessions.set(id, session);
      this.byOwner.set(owner.sub, session);
      try {
        const obs = await engine.call<Observation>('start', { game: st.game, map: st.map, skill: st.skill, image: 'none', load: 'autosave', visited: st.visited ?? [], gave_up: st.gave_up ?? {}, turn: st.turn ?? 0 }, 90_000);
        session.turn = obs.turn ?? session.turn;
        const rec = session.record(obs, [], undefined, 'system');
        rec.events = [`Resumed after a server restart (turn ${session.turn}).`];
        this.emit('turn', session, rec);
        this.log(`resumed ${owner.name}'s ${st.game} ${st.map} (${id}) at turn ${session.turn}`);
        await this.autosave(session);
      } catch (e) {
        this.log(`could not resume ${id}: ${(e as Error).message}`);
        await this.end(session, 'stopped', `could not resume after restart: ${(e as Error).message}`);
      }
    }
    this.emit('list');
  }

  // ---------------------------------------------------------------- lifecycle

  /** `record`: keep an `ended` record (not for a toolsets/close, nor a game replaced by a new one: the toolset goes on). */
  async end(session: GameSession, status: GameStatus, why: string, cause?: unknown, record = true): Promise<void> {
    if (!this.sessions.has(session.id)) return;
    this.sessions.delete(session.id);
    if (this.byOwner.get(session.owner.sub) === session) this.byOwner.delete(session.owner.sub);
    if (session.status === 'running') session.status = status;
    session.endedAt = Date.now();
    session.engine.kill();
    this.recordings.writeState(session.id, { ...this.stateOf(session), resumable: false });
    const pub = session.public();
    this.recent.unshift(pub);
    this.recent.splice(30);
    try { appendFileSync(join(this.config.dataDir, 'results.jsonl'), JSON.stringify({ ...pub, why }) + '\n'); } catch (e) { this.log(`results write failed: ${(e as Error).message}`); }
    this.log(`${session.owner.name}'s game ${session.id} ended: ${session.status} (${why})`);
    // id: the game's own (random, never reused for this player), so a host can dedupe across reconnects.
    if (record) {
      const records = this.ended.get(session.owner.sub) ?? [];
      records.push({ id: `game-${session.id}`, why, summary: `${session.game} ${session.map}, turn ${session.turn}`, at: session.endedAt });
      this.ended.set(session.owner.sub, records.slice(-20));
    }
    this.emit('ended', session);
    this.emit('list');
    this.emit('state', session.owner.sub, { cause, ended: { session, why } } satisfies StateChange);
  }

  private sweep() {
    const cutoff = Date.now() - this.config.idleMinutes * 60_000;
    for (const s of [...this.sessions.values()]) {
      if (s.lastActiveAt < cutoff) void this.end(s, 'stopped', `idle for ${this.config.idleMinutes} minutes`);
      else if (s.engine.closed) void this.end(s, 'stopped', 'engine exited');
    }
  }

  /** Stop without ending: every running game stays resumable (autosaved after its last turn). */
  async shutdown() {
    clearInterval(this.sweeper);
    for (const s of [...this.sessions.values()]) {
      if (s.status === 'running') { this.recordings.writeState(s.id, { ...(this.recordings.readState(s.id) ?? {}), ...this.stateOf(s), resumable: this.recordings.hasSave(s.id) }); s.engine.kill(); }
      else await this.end(s, s.status, 'server shutting down');
    }
  }

  private loadRecent() {
    try {
      const file = join(this.config.dataDir, 'results.jsonl');
      if (!existsSync(file)) return;
      const lines = readFileSync(file, 'utf8').trim().split('\n').slice(-30).reverse();
      for (const l of lines) { try { const { why: _w, ...pub } = JSON.parse(l); this.recent.push(pub as PublicGame); } catch { /* skip */ } }
    } catch { /* fresh start */ }
  }

  private requireMine(owner: Principal, cause?: unknown): GameSession {
    const s = this.byOwner.get(owner.sub);
    if (!s) throw new Fault(409, 'You have no game running. Call game_start first.');
    if (s.engine.closed) { void this.end(s, 'stopped', 'engine exited', cause); throw new Fault(500, 'Your game engine has exited; call game_start to begin a new game.'); }
    return s;
  }

  private async withLock<T>(session: GameSession, fn: () => Promise<T>): Promise<T> {
    if (session.busy) throw new Fault(409, 'Your previous game call is still running; wait for it to return.');
    session.busy = true;
    try { return await fn(); }
    catch (e) {
      if (e instanceof EngineError) throw new Fault(500, `Game engine error: ${e.message}`);
      throw e;
    } finally { session.busy = false; }
  }
}
