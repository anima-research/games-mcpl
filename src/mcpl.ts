// Network MCPL 0.5 endpoint (/mcpl). One WebSocket = one authenticated principal.
// Identity: an Archipelago aid1 token (Authorization: Bearer, or ?token= as
// Connectome hosts dial). The socket closes when the token expires.
//
// MCPL RFC-014 revision 2 (tool presence, toolsets and surfaces), for a host that advertises
// experimental.mcpl.toolHints: the game tools form the `game` toolset — toolsets/open starts a
// game or picks up the one this identity has, toolsets/close ends it (unless it was opened with
// `keep`), toolsets/list reports it after a reconnect — and hint changes travel in the result of
// the call that caused them, on a push event that explains them, or as tools/hints. A host that
// does not advertise toolHints sees the server exactly as before; only the tool definitions carry
// extra `_meta` hints, which it ignores. See src/hints.ts for the visibility table.
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { Fault } from './auth.js';
import type { App } from './index.js';
import { describe, ACTION_HELP } from './describe.js';
import type { Observation } from './engine.js';
import { nextMap, type GameSession, type GameStatus, type Principal, type StateChange } from './games.js';
import {
  TOOLSET, closedTold, current, diff, hinted, isGameTool, unavailable,
  type GameView, type HintChanges, type Told, type Tool,
} from './hints.js';
import {
  EMPTY_GRANT, buildReceipt, deriveFeatureSetState, narrowGrant, parsePolicy,
  type FeatureSetDeclaration05, type FeatureSetMap, type FeatureSetWireEntry, type Grant,
} from './mcpl05.js';

const VERSION = '0.1.0';
const FS_NAME = 'games';
const PUSH_TIMEOUT_MS = 30_000;

const featureSetDecl: FeatureSetDeclaration05 = {
  description: 'Play Doom (and more games later) turn by turn; people watch on the web and talk to you. Push events: chat from watchers while you are idle.',
  uses: ['tools', 'pushEvents'],
  rollback: false,
};
const declaredFeatureSets: FeatureSetMap = { [FS_NAME]: featureSetDecl };
const featureSets: FeatureSetWireEntry[] = [{ name: FS_NAME, ...featureSetDecl }];

const imageProp = { type: 'string', enum: ['frame', 'automap', 'both', 'none'], description: 'What picture to return: the rendered view (default), the automap, both, or none (text only).' };
const scaleProp = { type: 'number', description: 'Scale the picture (0.5 = half size, fewer tokens). Default 1 = 320×240.' };

export const TOOLS = [
  { name: 'game_list', description: 'What you can play (games, maps, skills), who is playing right now, and your own game if any.', inputSchema: { type: 'object', properties: {} } },
  { name: 'game_start', description: 'Start a game (or restart on a new map after dying / finishing a level). Ends your previous game. Returns your first look at the level.',
    inputSchema: { type: 'object', properties: {
      game: { type: 'string', description: 'freedoom1 (default; Doom-style E1M1…E4M9), freedoom2 (Doom II-style MAP01…MAP32), and when installed: doom (Ultimate Doom), doom2, heretic (E1M1…E5M9). game_list shows what is here.' },
      map: { type: 'string', description: 'Map name, e.g. E1M1 (default: the first map).' },
      skill: { type: 'number', description: '1 easiest … 5 Nightmare. Default 3.' },
      image: imageProp, image_scale: scaleProp,
    } } },
  { name: 'game_act', description: `Take your turn: run a list of actions, then see the result (status, events, what is in view, clearance, a picture). ${ACTION_HELP}`,
    inputSchema: { type: 'object', properties: {
      actions: { type: 'array', items: { type: 'object' }, description: 'Actions in order, e.g. [{"turn":-30},{"move":"forward","tics":35},{"attack":2}].' },
      say: { type: 'string', description: 'Optional commentary for the people watching (shown next to this turn).' },
      stop_on: { type: 'array', items: { type: 'string', enum: ['damage', 'enemy', 'dead', 'level'] }, description: 'Conditions that end the sequence early. Default all four.' },
      image: imageProp, image_scale: scaleProp,
    }, required: ['actions'] } },
  { name: 'game_look', description: 'Look without acting: the current view and/or automap plus the full text description. The game does not advance.',
    inputSchema: { type: 'object', properties: { image: imageProp, image_scale: scaleProp } } },
  { name: 'game_state', description: 'Text-only status of your game (no picture): health, ammo, position, what is in view, clearance, chat.', inputSchema: { type: 'object', properties: {} } },
  { name: 'game_say', description: 'Say something to the people watching your game (does not advance the game).',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'game_watchers', description: 'Who is watching your game and what they have said recently.', inputSchema: { type: 'object', properties: {} } },
  { name: 'game_stop', description: 'End your game.', inputSchema: { type: 'object', properties: {} } },
  { name: 'game_results', description: 'Recent finished games (who, map, outcome, kills, time).', inputSchema: { type: 'object', properties: {} } },
];

/** For a host that advertised toolHints: the moves after dying or finishing a map, which a plain host makes with game_start. */
const RESTART: Tool = { name: 'game_restart', description: 'Play the map again from the start, after dying or finishing it. Same game; same skill unless you give one.',
  inputSchema: { type: 'object', properties: { skill: { type: 'number', description: '1 easiest … 5 Nightmare. Default: the skill you played.' }, image: imageProp, image_scale: scaleProp } } };
const NEXT: Tool = { name: 'game_next', description: 'Go on to the next map after finishing a level (same game and skill).',
  inputSchema: { type: 'object', properties: { image: imageProp, image_scale: scaleProp } } };
/** While visible, game_next names the map it goes to: a `definition` hint, without tools/list_changed. */
const nextDefinition = (map: string): Tool => ({ ...NEXT, description: `Go on to the next map, ${map} (same game and skill).` });

const SURFACE = { title: 'Archipelago Games', summary: 'Doom, Doom II, Freedoom and Heretic, turn by turn; people watch on the web and talk to you.' };
const STATUS_WORD: Record<GameStatus, string> = { running: 'playing', dead: 'dead', complete: 'level complete', stopped: 'stopped' };
const OPTION_KEYS = ['game', 'map', 'skill', 'image', 'image_scale', 'keep'];
/** How long a game that ended unseen is reported in toolsets/list `ended`. */
const ENDED_WINDOW_MS = 3600_000;

/** The `game` toolset as declared in the manifest (RFC-014 §5.1). */
function toolsetDeclaration(app: App) {
  return {
    title: 'Doom',
    summary: 'Your game, turn by turn: opening starts one (or picks up the one you have); closing ends it unless it was opened with keep.',
    default: 'closed',
    instances: false,
    options: { type: 'object', additionalProperties: false, properties: {
      game: { type: 'string', enum: Object.keys(app.games.catalogue.games), description: 'freedoom1 (default; E1M1…E4M9), freedoom2 (MAP01…MAP32), and doom, doom2, heretic where installed. game_list describes them.' },
      map: { type: 'string', description: 'E1M1 style (Doom, Freedoom 1, Heretic) or MAP01 style (Doom II, Freedoom 2). Default: the first map.' },
      skill: { type: 'integer', minimum: 1, maximum: 5, description: '1 easiest … 5 Nightmare. Default 3.' },
      image: imageProp, image_scale: scaleProp,
      keep: { type: 'boolean', description: `Closing the toolset leaves the game running on the server, and opening it again picks the game up (default false: closing ends the game). A game nobody plays for ${app.config.idleMinutes} minutes ends either way.` },
    } },
  };
}

class RpcError extends Error { constructor(readonly code: number, message: string) { super(message); } }

type Block = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type ToolResult = { content: Block[]; isError?: boolean };

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

export class McplSession {
  readonly id = `m${randomBytes(4).toString('hex')}`;
  private initialized = false;
  private ready = false;
  private mcpl = false;
  private grant: Grant = EMPTY_GRANT;
  private policyReady = false;
  private nextId = 1;
  private pending = new Map<string, { resolve: (v: unknown) => void; timer: NodeJS.Timeout }>();
  private lastPushAt = 0;
  private closed = false;
  /** The host advertised experimental.mcpl.toolHints (RFC-014): it gets hints, toolsets and the two extra tools. */
  private toolHints = false;
  /** One strictly increasing counter per connection for every hint change sent (RFC-014 §6.1). */
  private rev = 0;
  /** What this host has been told about the game toolset (its state on the host, as far as we know). */
  private told: Told = closedTold();
  private peerTimer: NodeJS.Timeout | null = null;
  private peerEnded: { id: string; text: string } | null = null;

  constructor(private app: App, private ws: WebSocket, readonly actor: Principal, private log: (m: string) => void) {}

  // ---------------------------------------------------------------- pushes

  pushReady(): boolean {
    if (this.closed || !this.ready || !this.mcpl || !this.policyReady) return false;
    return deriveFeatureSetState(FS_NAME, featureSetDecl, this.grant).active;
  }

  /** Chat from watchers reaches an idle player as a push; a busy one reads it with the next turn. */
  maybePushChat(session: GameSession) {
    if (!this.pushReady()) return;
    if (session.owner.sub !== this.actor.sub) return;
    // RFC-014 §7: when a toolset closes, its events stop.
    if (this.toolHints && !this.told.open) return;
    const now = Date.now();
    if (now - session.lastActiveAt < 20_000 || now - this.lastPushAt < 20_000) return;
    const unread = session.unread;
    if (!unread.length) return;
    this.lastPushAt = now;
    const lines = unread.slice(-6).map((m) => `${m.from.name}: ${m.text}`);
    this.request('push/event', {
      featureSet: FS_NAME,
      eventId: `chat_${session.id}_${unread[unread.length - 1].id}`,
      timestamp: new Date().toISOString(),
      origin: { server: 'games', game: session.id, map: session.map },
      tags: ['games:chat', 'chat:from-human', 'chat:addressed'],
      ...(this.toolHints ? { toolset: TOOLSET } : {}),
      payload: { content: [{ type: 'text', text: `[games] ${unread.length === 1 ? 'A watcher of your Doom game says' : `${unread.length} messages from watchers of your Doom game`}:\n${lines.join('\n')}\n(game_act with a say field, or game_say, answers them.)` }] },
    }).then((r) => this.log(`${this.actor.name}: chat push ${(r as { accepted?: unknown } | null)?.accepted === false ? 'NOT accepted' : 'sent'}`)).catch(() => undefined);
  }

  private send(msg: unknown) { if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg)); }
  private result(id: unknown, result: unknown) { this.send({ jsonrpc: '2.0', id, result }); }
  private error(id: unknown, code: number, message: string, data?: unknown) { this.send({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } }); }
  private request(method: string, params: unknown): Promise<unknown> {
    const id = `s${this.nextId++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(null); }, PUSH_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  // ---------------------------------------------------------------- hints (RFC-014)

  private gameView(): GameView | null {
    const s = this.app.games.mine(this.actor);
    if (!s) return null;
    return { id: s.id, status: s.status, parked: s.parked, map: s.map, title: titleOf(s), next: s.status === 'complete' ? nextMap(s.game, s.map, this.app.games.catalogue) : null };
  }

  private toolDefs(): Tool[] { return this.toolHints ? [...TOOLS, RESTART, NEXT] : TOOLS; }

  /** Every tool, visible or not, with its hints; `mcpl/visible` on a toolset tool is "visible in the open toolset". */
  private toolList(): Tool[] {
    const now = current(this.gameView());
    return this.toolDefs().map((t) => hinted(t, now.visible.has(t.name)));
  }

  /**
   * A definition as a hint carries it (RFC-014 §6.1): only the description, schema and annotations
   * may differ from the listed one — the name and `_meta` (with any RFC-008 class) are the listed ones.
   */
  private definition(name: string): Tool {
    const g = this.gameView();
    const listed = this.toolDefs().find((t) => t.name === name)!;
    const now = name === 'game_next' && g?.next ? nextDefinition(g.next) : listed;
    const { 'mcpl/visible': _v, ...meta } = hinted(listed, true)._meta ?? {};
    return { name: listed.name, description: now.description, inputSchema: now.inputSchema, ...(now.annotations ? { annotations: now.annotations } : {}), _meta: meta };
  }

  /**
   * What changed since this host was last told, as a HintChanges with the next rev, or null.
   * RFC-014 §6.1: the messages carrying hint changes on a connection are numbered consecutively
   * (1, 2, 3…) in the order they are written — so a rev is allocated only for changes that exist,
   * and every caller writes the message in the same synchronous step (no await in between).
   */
  private changes(opts: { full?: boolean; mayOpen: boolean }): HintChanges | null {
    const r = diff(this.told, current(this.gameView()), (t) => this.definition(t), opts);
    this.told = r.told;
    return r.changes ? { rev: ++this.rev, ...r.changes } : null;
  }

  private notifyHints(h: HintChanges) { this.send({ jsonrpc: '2.0', method: 'tools/hints', params: h }); }

  /**
   * A change with an event that explains it rides that event; without pushes, it goes standalone.
   * RFC-014 §6.1: a host applies a push's hints when it reads the push, whatever it decides about
   * the event — so a refused or unanswered push needs nothing restated; the next change takes the
   * next rev. A push carrying hints is never coalesced (§7).
   */
  private deliverHints(h: HintChanges, explain: { id: string; text: string; tags: string[] } | null) {
    if (!explain || !this.pushReady()) { this.notifyHints(h); return; }
    this.request('push/event', {
      featureSet: FS_NAME, eventId: explain.id, timestamp: new Date().toISOString(), origin: { server: 'games' },
      tags: explain.tags, toolset: TOOLSET, hints: h, payload: { content: [{ type: 'text', text: explain.text }] },
    }).catch(() => undefined);
  }

  /**
   * A player's game changed (Games 'state'). This connection's own calls report what they caused in
   * their results (RFC-014 §6.2), so only changes from elsewhere are handled here: another
   * connection under the same identity, the web viewer's stop, the idle sweep, an engine that died.
   */
  onGameState(change: StateChange) {
    if (!this.toolHints || !this.ready || this.closed) return;
    if (change.cause === this) return;
    if (change.ended && this.told.open) {
      const s = change.ended.session;
      const byPeer = change.cause instanceof McplSession;
      const why = byPeer && change.ended.why === 'stopped by the player' ? 'it was stopped from another connection under your identity'
        : byPeer && change.ended.why === 'the game toolset was closed' ? 'it was closed from another connection under your identity'
        : byPeer && change.ended.why === 'replaced by a new game' ? 'a new game was started from another connection under your identity'
        : change.ended.why;
      this.peerEnded = { id: `ended_${s.id}`, text: `[games] Your game ended (${why}): ${s.game} ${s.map}, turn ${s.turn}${s.status === 'stopped' ? '' : `, ${STATUS_WORD[s.status]}`}. game_results lists it; opening the game toolset starts a new one.` };
    }
    // Debounced: a burst (a game replaced: ended, then started) is reported as where it lands.
    if (!this.peerTimer) this.peerTimer = setTimeout(() => { this.peerTimer = null; this.flushPeer(); }, 25);
  }

  private flushPeer() {
    if (this.closed) return;
    const ended = this.peerEnded;
    this.peerEnded = null;
    // RFC-014 §5.6: toolsets belong to the principal. An open, close or visibility change made on
    // another connection reaches this one as ordinary hint changes, toolset state included.
    const h = this.changes({ mayOpen: true });
    if (!h) return;
    const closing = h.toolsets?.some((t) => t.state === 'closed') ?? false;
    this.deliverHints(h, closing && ended ? { ...ended, tags: ['games:ended', 'surface:done'] } : null);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.peerTimer) { clearTimeout(this.peerTimer); this.peerTimer = null; }
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve(null); }
    this.pending.clear();
  }

  // ---------------------------------------------------------------- dispatch

  async handle(raw: string) {
    let m: any;
    try { m = JSON.parse(raw); } catch { this.error(null, -32700, 'Parse error'); return; }
    if (Array.isArray(m)) { this.error(null, -32600, 'Batches are not supported.'); return; }
    if (m?.jsonrpc !== '2.0') { this.error(m?.id ?? null, -32600, 'Invalid request'); return; }
    if (typeof m.method !== 'string') {
      const p = this.pending.get(String(m.id));
      if (p) { this.pending.delete(String(m.id)); clearTimeout(p.timer); p.resolve(m.error ? null : m.result); }
      return;
    }
    const hasId = m.id !== undefined && m.id !== null;
    const params = m.params ?? {};
    try {
      switch (m.method) {
        case 'initialize': {
          if (this.initialized) { if (hasId) this.error(m.id, -32600, 'Already initialized.'); return; }
          this.initialized = true;
          this.mcpl = !!params?.capabilities?.experimental?.mcpl;
          this.toolHints = this.mcpl && params.capabilities.experimental.mcpl.toolHints === true;
          if (!this.mcpl) { this.grant = { ...EMPTY_GRANT, patterns: ['tools'], paths: new Set(['tools' as const]) }; this.policyReady = true; }
          // RFC-014 §5.1/§6.3: toolHints, the toolset and the surface hint — declared to a host that advertised toolHints.
          const hints = this.toolHints ? { toolHints: true, toolsets: { [TOOLSET]: toolsetDeclaration(this.app) }, surface: SURFACE } : {};
          this.result(m.id, {
            protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
            serverInfo: { name: 'archipelago-games', version: VERSION },
            capabilities: { tools: {}, ...(this.mcpl ? { experimental: { mcpl: { version: '0.5', pushEvents: true, featureSets, ...hints } } } : {}) },
            instructions: this.instructions(),
          });
          if (this.toolHints) this.log(`${this.actor.name}: host advertises toolHints`);
          return;
        }
        case 'notifications/initialized': if (this.initialized) this.ready = true; return;
        case 'ping': if (hasId) this.result(m.id, {}); return;
      }
      if (!this.ready) { if (hasId) this.error(m.id, -32002, 'Initialize first.'); return; }
      switch (m.method) {
        case 'featureSets/update': {
          const parsed = parsePolicy(params);
          if (!hasId) { if (parsed.ok) this.grant = narrowGrant(this.grant, parsed.grant, parsed.hadEffectiveCapabilities); return; }
          if (!parsed.ok) { this.grant = EMPTY_GRANT; this.policyReady = false; this.error(m.id, -32602, `Invalid featureSets/update: ${parsed.error}`); return; }
          this.grant = parsed.grant; this.policyReady = true;
          const receipt = buildReceipt(declaredFeatureSets, this.grant);
          this.log(`${this.actor.name}: policy grant=[${this.grant.patterns.join(', ')}] mode=${receipt.mode}`);
          this.result(m.id, receipt);
          return;
        }
        case 'tools/list': {
          if (!hasId) return;
          if (!this.toolHints) { this.result(m.id, { tools: this.toolList() }); return; }
          // RFC-014 §4.1: the list carries the rev it reflects; send what is pending first, so it is exact.
          if (this.peerTimer) { clearTimeout(this.peerTimer); this.peerTimer = null; this.flushPeer(); }
          this.result(m.id, { tools: this.toolList(), _meta: { 'mcpl/rev': this.rev } });
          return;
        }
        case 'tools/call': {
          if (!hasId) return;
          const name = String(params.name ?? '');
          const args = (params.arguments ?? {}) as Record<string, unknown>;
          // RFC-014 §4.1: a tool of a toolset that is not open, or not visible now, is an ordinary
          // tool error that says why. Only for a hinted host: a plain host keeps today's behaviour.
          const refused = this.toolHints && isGameTool(name) ? unavailable(name, this.gameView()) : null;
          const r = refused !== null ? text(refused, true) : await this.tool(name, args).catch((e): ToolResult => {
            if (e instanceof Fault) return text(e.message, true);
            this.log(`${this.actor.name}: ${name} failed: ${(e as Error).stack ?? e}`);
            return text(`${name} failed: ${(e as Error).message}`, true);
          });
          // What this call caused rides in its result, and is not pushed (RFC-014 §6.2). Calling a
          // toolset tool also confirms the toolset to a host that had not been told it was open.
          const h = this.toolHints ? this.changes({ mayOpen: isGameTool(name) }) : null;
          this.result(m.id, h ? { ...r, _meta: { 'mcpl/hints': h } } : r);
          return;
        }
        case 'toolsets/open':
        case 'toolsets/close':
        case 'toolsets/list': {
          // Unknown to a host that did not advertise toolHints, as before.
          if (!this.toolHints) { if (hasId) this.error(m.id, -32601, `Method not found: ${m.method}`); return; }
          if (!hasId) return;
          try {
            const body = m.method === 'toolsets/open' ? await this.openGame(params) : m.method === 'toolsets/close' ? await this.closeGame(params) : {};
            if (m.method === 'toolsets/list') {
              // RFC-014 §5.3: what this identity holds open, and its hint state in full as of this
              // result's rev (a tool not stated visible is invisible); the host replaces its state with it.
              // And every end the host did not ask for with toolsets/close (game_stop, the web stop, the
              // idle sweep, a dead engine), whoever was connected: `ended` records, each with an id, on
              // every list until they expire; hosts tell their agent once per id.
              const g = this.gameView();
              const b = body as Record<string, unknown>;
              b.open = g && !g.parked ? [{ toolset: TOOLSET, title: g.title }] : [];
              const ended = this.app.games.endedRecords(this.actor.sub, ENDED_WINDOW_MS);
              if (ended.length) b.ended = ended.map((e) => ({ id: e.id, toolset: TOOLSET, reason: `${e.why} (${e.summary})` }));
              this.told = closedTold();
            }
            const h = this.changes(m.method === 'toolsets/close' ? { mayOpen: false } : { full: true, mayOpen: true });
            this.result(m.id, { ...body, ...(h ? { _meta: { 'mcpl/hints': h } } : {}) });
          } catch (e) {
            if (e instanceof RpcError) this.error(m.id, e.code, e.message);
            else if (e instanceof Fault) this.error(m.id, e.status === 400 ? -32602 : -32000, e.message);
            else throw e;
          }
          return;
        }
        default: if (hasId) this.error(m.id, -32601, `Method not found: ${m.method}`);
      }
    } catch (e) {
      if (hasId) this.error(m.id, -32000, (e as Error).message);
    }
  }

  private instructions(): string {
    if (this.toolHints) return [
      'Archipelago Games: play Doom turn by turn. The world only moves while game_act runs, so take your time between turns.',
      'Your game is the `game` toolset. Opening it starts a game (options: game — freedoom1 by default — map, skill; keep: true leaves the game running when you close the toolset) or picks up the one you already have; closing it ends the game. game_list (what you can play, who is playing) and game_results work at any time.',
      'Each turn: read the text (status, events, what is in view with bearings and distances, the ways out of your area and which are unexplored, clearance to walls), look at the picture, then game_act with a short list of actions. Bearings are degrees, + = right of where you face.',
      'Finding your way: {"explore": true} walks to the nearest area you have not visited (it routes around corners and opens doors); {"goto": id | [x, y]} does the same toward a thing or a map point. You rarely need raw turn/move for navigation — use them for aiming and small adjustments. Doors are listed under "Ways out"; {"use": true} walks to the nearest door in front of you and opens it, and tells you if there is nothing to use.',
      'People can watch your game on the web and talk to you; their words appear under "Watchers say" and, when you are idle, as a games:chat push. Answer with the say field of game_act or game_say.',
      'Dying or finishing a level ends the episode: game_restart plays the map again, game_next goes on to the next map, game_start picks any map. Progress carries nothing over: you start each map with a pistol.',
      ACTION_HELP,
    ].join('\n');
    return [
      'Archipelago Games: play Doom turn by turn. The world only moves while game_act runs, so take your time between turns.',
      'Start with game_start (freedoom1 E1M1 by default). Each turn: read the text (status, events, what is in view with bearings and distances, the ways out of your area and which are unexplored, clearance to walls), look at the picture, then game_act with a short list of actions. Bearings are degrees, + = right of where you face.',
      'Finding your way: {"explore": true} walks to the nearest area you have not visited (it routes around corners and opens doors); {"goto": id | [x, y]} does the same toward a thing or a map point. You rarely need raw turn/move for navigation — use them for aiming and small adjustments. Doors are listed under "Ways out"; {"use": true} walks to the nearest door in front of you and opens it, and tells you if there is nothing to use.',
      'People can watch your game on the web and talk to you; their words appear under "Watchers say" and, when you are idle, as a games:chat push. Answer with the say field of game_act or game_say.',
      'Dying or finishing a level ends the episode: game_start again (same map to retry, the next map to continue). Progress carries nothing over: you start each map with a pistol.',
      ACTION_HELP,
    ].join('\n');
  }

  // ---------------------------------------------------------------- toolsets (RFC-014 §5.2)

  /**
   * toolsets/open: start a game, or pick up the one this identity has. Opening what is already
   * open adopts it and changes nothing (RFC-014 §5.2), so options that differ from the game are
   * reported, not applied. A game kept on close (`keep`) is picked up the same way; that open is a
   * real one, so its `keep` applies.
   */
  private async openGame(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.checkToolset(params);
    const o = (params.options ?? {}) as Record<string, unknown>;
    if (typeof o !== 'object' || Array.isArray(o)) throw new RpcError(-32602, 'options must be an object.');
    const bad = optionsProblem(o);
    if (bad) throw new RpcError(-32602, `Invalid options: ${bad}.`);
    const games = this.app.games;
    const image = str(o.image) ?? 'frame';
    const image_scale = num(o.image_scale) ?? 1;
    let session = games.mine(this.actor);
    let obs: Observation | null = null;
    if (session) {
      try { obs = (await games.look(this.actor, image, image_scale, this)).obs; } catch (e) {
        if (games.mine(this.actor) !== session) session = null;             // its engine had died: start afresh
        else if (session.last) obs = { ...session.last, events: [] };       // busy with a turn: the last view
        else throw e;
      }
    }
    let lead: string;
    let adopted = false;
    if (session && obs) {
      const parked = session.parked;
      adopted = !parked; // a kept (parked) game's toolset was closed: picking it up is a real open
      if (parked) games.setToolset(session, { parked: false, ...(typeof o.keep === 'boolean' ? { keep: o.keep } : {}) }, this);
      const differs = [
        typeof o.game === 'string' && o.game.toLowerCase() !== session.game ? 'game' : '',
        typeof o.map === 'string' && o.map.toUpperCase() !== session.map ? 'map' : '',
        typeof o.skill === 'number' && o.skill !== session.skill ? 'skill' : '',
        !parked && typeof o.keep === 'boolean' && o.keep !== session.keep ? 'keep' : '',
      ].filter(Boolean);
      lead = `${parked ? 'Picked up the game you kept on the server' : 'You already have a game; this is it'}: ${titleOf(session)}, turn ${session.turn}${session.status === 'running' ? '' : `, ${STATUS_WORD[session.status]}`}. Watch page: ${this.app.config.origin}/g/${session.id}`;
      if (differs.length) lead += `\nNot applied (${differs.join(', ')}): you have a game. ${session.status === 'running' ? 'game_stop ends it; then open the game toolset again with those options.' : 'game_start {game, map, skill} starts another.'}`;
    } else {
      const r = await games.start(this.actor, { game: str(o.game), map: str(o.map), skill: num(o.skill), image, image_scale }, this);
      session = r.session; obs = r.obs;
      if (o.keep === true) games.setToolset(session, { keep: true }, this);
      lead = `Your game is live; people can watch at ${this.app.config.origin}/g/${session.id}`;
    }
    // RFC-014 §5.2: an open that finds the game already open adopts it, and says so.
    return { toolset: TOOLSET, title: titleOf(session), content: this.observation(session, obs, lead).content, ...(adopted ? { adopted: true } : {}) };
  }

  /** toolsets/close: end the game — or, if it was opened with keep, leave it running and closed. */
  private async closeGame(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.checkToolset(params);
    const games = this.app.games;
    const s = games.mine(this.actor);
    let said: string;
    if (!s) said = 'You had no game running.';
    else if (s.keep) {
      games.setToolset(s, { parked: true }, this);
      said = `Your game stays on the server: ${titleOf(s)}, turn ${s.turn}${s.status === 'running' ? '' : `, ${STATUS_WORD[s.status]}`}. Opening the game toolset picks it up; a game nobody plays for ${this.app.config.idleMinutes} minutes ends.`;
    } else {
      await games.stop(this.actor, this, true);
      said = `Stopped your game (${s.game} ${s.map}, turn ${s.turn}${s.status === 'stopped' ? '' : `, ${STATUS_WORD[s.status]}`}). game_results lists it.`;
    }
    return { content: [{ type: 'text', text: said }] };
  }

  private checkToolset(params: Record<string, unknown>) {
    if (params.toolset !== TOOLSET) throw new RpcError(-32602, `No toolset "${String(params.toolset ?? '')}" here; there is "${TOOLSET}".`);
    if (params.instance !== undefined) throw new RpcError(-32602, `The ${TOOLSET} toolset has no instances: one game per identity.`);
  }

  // ---------------------------------------------------------------- tools

  /** For a hinted host the end-of-episode lines name the moves it has (game_restart, game_next). */
  private hintedEvents(session: GameSession, events: string[]): string[] {
    const next = nextMap(session.game, session.map, this.app.games.catalogue);
    return events.map((e) => e === 'YOU DIED. Call game_start to try the level again.'
      ? 'YOU DIED. game_restart tries the map again; game_start picks another; game_stop ends the game.'
      : e.startsWith('LEVEL COMPLETE') ? e.replace(/ Call game_start with the next map\.$/, next ? ` game_next goes on to ${next}; game_restart replays this map.` : ' That was the last map: game_start picks another; game_restart replays this one.')
      : e);
  }

  private observation(session: GameSession, obs: Observation, extraTop?: string): ToolResult {
    if (this.toolHints && obs.events?.length) obs = { ...obs, events: this.hintedEvents(session, obs.events) };
    const chat = session.takeUnread();
    const body = describe(obs, session, chat, session.watchers.size);
    const content: Block[] = [{ type: 'text', text: (extraTop ? extraTop + '\n' : '') + body }];
    if (obs.frame_jpeg) content.push({ type: 'image', data: obs.frame_jpeg, mimeType: 'image/jpeg' });
    if (obs.automap_jpeg) content.push({ type: 'image', data: obs.automap_jpeg, mimeType: 'image/jpeg' });
    return { content };
  }

  private async tool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const games = this.app.games;
    const me = this.actor;
    switch (name) {
      case 'game_list': {
        const cat = games.catalogue;
        const lines = ['Games:'];
        for (const [k, v] of Object.entries(cat.games)) lines.push(`  ${k} — ${v.title}; maps ${v.maps[0]}…${v.maps[v.maps.length - 1]}`);
        lines.push(`Skills: ${Object.entries(cat.skills).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
        const live = games.list();
        lines.push(live.length ? `Playing now: ${live.map((g) => `${g.player.name} — ${g.game} ${g.map}, turn ${g.turn}, health ${g.health ?? '?'}, ${g.watchers} watching`).join(' · ')}` : 'Nobody is playing right now.');
        const mine = games.mine(me);
        const kept = this.toolHints && mine?.parked ? ' Kept on the server; opening the game toolset picks it up.' : '';
        const begin = this.toolHints ? 'opening the game toolset starts one' : 'game_start begins one';
        lines.push(mine ? `Your game: ${mine.game} ${mine.map}, turn ${mine.turn}, ${mine.status}. Watch page: ${this.app.config.origin}/g/${mine.id}${kept}` : `You have no game running; ${begin}.`);
        return text(lines.join('\n'));
      }
      case 'game_start': {
        const { session, obs } = await games.start(me, { game: str(args.game), map: str(args.map), skill: num(args.skill), image: str(args.image), image_scale: num(args.image_scale) }, this);
        return this.observation(session, obs, `Your game is live; people can watch at ${this.app.config.origin}/g/${session.id}`);
      }
      case 'game_restart':
      case 'game_next': {
        if (!this.toolHints) throw new Fault(404, `Unknown tool ${name}.`);
        const s = games.mine(me);
        if (!s) throw new Fault(409, 'You have no game running.');
        const map = name === 'game_next' ? nextMap(s.game, s.map, games.catalogue) : s.map;
        if (!map) throw new Fault(409, `${s.map} was the last map; game_start picks another.`);
        const skill = name === 'game_restart' ? num(args.skill) ?? s.skill : s.skill;
        const { session, obs } = await games.start(me, { game: s.game, map, skill, image: str(args.image), image_scale: num(args.image_scale) }, this);
        return this.observation(session, obs, name === 'game_next' ? `On to ${map}.` : `${map} again, from the start.`);
      }
      case 'game_act': {
        const actions = Array.isArray(args.actions) ? args.actions : null;
        if (!actions || !actions.length) throw new Fault(400, 'actions must be a non-empty list, e.g. [{"move":"forward","tics":35}].');
        if (actions.length > 12) throw new Fault(400, 'At most 12 actions per turn.');
        const stop_on = Array.isArray(args.stop_on) ? args.stop_on.map(String) : undefined;
        const { session, obs } = await games.act(me, actions, { say: str(args.say), stop_on, image: str(args.image), image_scale: num(args.image_scale) }, this);
        return this.observation(session, obs);
      }
      case 'game_look': {
        const { session, obs } = await games.look(me, str(args.image) ?? 'frame', num(args.image_scale) ?? 1, this);
        return this.observation(session, obs);
      }
      case 'game_state': {
        const { session, obs } = await games.look(me, 'none', 1, this);
        return this.observation(session, obs);
      }
      case 'game_say': {
        const t = str(args.text);
        if (!t) throw new Fault(400, 'text is required.');
        const session = games.say(me, t.slice(0, 2000), this);
        return text(`Said to ${session.watchers.size} watcher(s): ${t}`);
      }
      case 'game_watchers': {
        const session = games.mine(me);
        if (!session) return text('You have no game running.');
        const chat = session.chat.slice(-20).map((m) => `${new Date(m.at).toISOString().slice(11, 16)} ${m.from.name}: ${m.text}`);
        session.takeUnread();
        return text(`${session.watchers.size} watching. ${chat.length ? `Recent chat:\n${chat.join('\n')}` : 'No chat yet.'}`);
      }
      case 'game_stop': {
        const s = await games.stop(me, this);
        return text(s ? `Stopped your game (${s.game} ${s.map}, turn ${s.turn}).` : 'You had no game running.');
      }
      case 'game_results': {
        const r = games.recent.slice(0, 15);
        if (!r.length) return text('No finished games yet.');
        return text(r.map((g) => `${new Date(g.endedAt ?? g.lastActiveAt).toISOString().slice(0, 16)} ${g.player.name} — ${g.game} ${g.map} skill ${g.skill}: ${g.status}, ${g.kills ?? 0} kills, ${g.items ?? 0} items, ${g.turn} turns, ${Math.round(g.time_s ?? 0)}s`).join('\n'));
      }
      default: throw new Fault(404, `Unknown tool ${name}.`);
    }
  }
}

const titleOf = (s: GameSession) => `${s.game} ${s.map}, skill ${s.skill}`;

/** toolsets/open options against the declared schema; game and map are checked by Games.start. */
function optionsProblem(o: Record<string, unknown>): string | null {
  for (const k of Object.keys(o)) if (!OPTION_KEYS.includes(k)) return `unknown option "${k}" (options: ${OPTION_KEYS.join(', ')})`;
  if (o.game !== undefined && typeof o.game !== 'string') return 'game must be a string';
  if (o.map !== undefined && typeof o.map !== 'string') return 'map must be a string';
  if (o.skill !== undefined && !(Number.isInteger(o.skill) && (o.skill as number) >= 1 && (o.skill as number) <= 5)) return 'skill must be an integer from 1 to 5';
  if (o.image !== undefined && !['frame', 'automap', 'both', 'none'].includes(o.image as string)) return 'image must be frame, automap, both or none';
  if (o.image_scale !== undefined && (typeof o.image_scale !== 'number' || !(o.image_scale > 0))) return 'image_scale must be a positive number';
  if (o.keep !== undefined && typeof o.keep !== 'boolean') return 'keep must be true or false';
  return null;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);

export function attachMcpl(server: Server, app: App, log: (m: string) => void) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const open = new Map<WebSocket, McplSession>();
  app.games.on('chat', (session: GameSession) => { for (const s of open.values()) s.maybePushChat(session); });
  app.games.on('state', (sub: string, change: StateChange) => { for (const s of open.values()) if (s.actor.sub === sub) s.onGameState(change); });
  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://games'); } catch { return; }
    if (url.pathname !== '/mcpl') return;
    let actor: Principal;
    let exp = 0;
    try {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? url.searchParams.get('token') ?? '';
      const who = app.verify(token);
      exp = who.exp;
      actor = app.admit(who);
    } catch (e) {
      const status = e instanceof Fault ? e.status : 401;
      if (e instanceof Fault && e.code) log(`refused /mcpl: ${e.code.slice(0, 160)}`);
      try { socket.write(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Unauthorized'}\r\nConnection: close\r\n\r\n`); } catch { /* ignore */ }
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const session = new McplSession(app, ws, actor, log);
      open.set(ws, session);
      log(`${actor.name} (${actor.sub}) connected`);
      const expiry = setTimeout(() => ws.close(4001, 'Identity expired; reconnect with a fresh token.'), Math.min(2 ** 31 - 1, Math.max(1, exp * 1000 - Date.now())));
      ws.on('message', (data) => { session.handle(data.toString()).catch((e) => log(`message failed: ${(e as Error).message}`)); });
      ws.on('close', () => { clearTimeout(expiry); open.delete(ws); session.close(); log(`${actor.name} disconnected`); });
      ws.on('error', () => { /* close follows */ });
    });
  });
  return wss;
}
