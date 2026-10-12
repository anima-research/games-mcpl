// Network MCPL 0.5 endpoint (/mcpl). One WebSocket = one authenticated principal.
// Identity: an Archipelago aid1 token (Authorization: Bearer, or ?token= as
// Connectome hosts dial). The socket closes when the token expires.
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { Fault } from './auth.js';
import type { App } from './index.js';
import { describe, ACTION_HELP } from './describe.js';
import type { Observation } from './engine.js';
import type { GameSession, Principal } from './games.js';
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

  close() {
    if (this.closed) return;
    this.closed = true;
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
          if (!this.mcpl) { this.grant = { ...EMPTY_GRANT, patterns: ['tools'], paths: new Set(['tools' as const]) }; this.policyReady = true; }
          this.result(m.id, {
            protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
            serverInfo: { name: 'archipelago-games', version: VERSION },
            capabilities: { tools: {}, ...(this.mcpl ? { experimental: { mcpl: { version: '0.5', pushEvents: true, featureSets } } } : {}) },
            instructions: this.instructions(),
          });
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
        case 'tools/list': if (hasId) this.result(m.id, { tools: TOOLS }); return;
        case 'tools/call': {
          if (!hasId) return;
          const name = String(params.name ?? '');
          const args = (params.arguments ?? {}) as Record<string, unknown>;
          const r = await this.tool(name, args).catch((e): ToolResult => {
            if (e instanceof Fault) return text(e.message, true);
            this.log(`${this.actor.name}: ${name} failed: ${(e as Error).stack ?? e}`);
            return text(`${name} failed: ${(e as Error).message}`, true);
          });
          this.result(m.id, r);
          return;
        }
        default: if (hasId) this.error(m.id, -32601, `Method not found: ${m.method}`);
      }
    } catch (e) {
      if (hasId) this.error(m.id, -32000, (e as Error).message);
    }
  }

  private instructions(): string {
    return [
      'Archipelago Games: play Doom turn by turn. The world only moves while game_act runs, so take your time between turns.',
      'Start with game_start (freedoom1 E1M1 by default). Each turn: read the text (status, events, what is in view with bearings and distances, the ways out of your area and which are unexplored, clearance to walls), look at the picture, then game_act with a short list of actions. Bearings are degrees, + = right of where you face.',
      'Finding your way: {"explore": true} walks to the nearest area you have not visited (it routes around corners and opens doors); {"goto": id | [x, y]} does the same toward a thing or a map point. You rarely need raw turn/move for navigation — use them for aiming and small adjustments. Doors are listed under "Ways out"; {"use": true} walks to the nearest door in front of you and opens it, and tells you if there is nothing to use.',
      'People can watch your game on the web and talk to you; their words appear under "Watchers say" and, when you are idle, as a games:chat push. Answer with the say field of game_act or game_say.',
      'Dying or finishing a level ends the episode: game_start again (same map to retry, the next map to continue). Progress carries nothing over: you start each map with a pistol.',
      ACTION_HELP,
    ].join('\n');
  }

  // ---------------------------------------------------------------- tools

  private observation(session: GameSession, obs: Observation, extraTop?: string): ToolResult {
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
        lines.push(mine ? `Your game: ${mine.game} ${mine.map}, turn ${mine.turn}, ${mine.status}. Watch page: ${this.app.config.origin}/g/${mine.id}` : 'You have no game running; game_start begins one.');
        return text(lines.join('\n'));
      }
      case 'game_start': {
        const { session, obs } = await games.start(me, { game: str(args.game), map: str(args.map), skill: num(args.skill), image: str(args.image), image_scale: num(args.image_scale) });
        return this.observation(session, obs, `Your game is live; people can watch at ${this.app.config.origin}/g/${session.id}`);
      }
      case 'game_act': {
        const actions = Array.isArray(args.actions) ? args.actions : null;
        if (!actions || !actions.length) throw new Fault(400, 'actions must be a non-empty list, e.g. [{"move":"forward","tics":35}].');
        if (actions.length > 12) throw new Fault(400, 'At most 12 actions per turn.');
        const stop_on = Array.isArray(args.stop_on) ? args.stop_on.map(String) : undefined;
        const { session, obs } = await games.act(me, actions, { say: str(args.say), stop_on, image: str(args.image), image_scale: num(args.image_scale) });
        return this.observation(session, obs);
      }
      case 'game_look': {
        const { session, obs } = await games.look(me, str(args.image) ?? 'frame', num(args.image_scale) ?? 1);
        return this.observation(session, obs);
      }
      case 'game_state': {
        const { session, obs } = await games.look(me, 'none');
        return this.observation(session, obs);
      }
      case 'game_say': {
        const t = str(args.text);
        if (!t) throw new Fault(400, 'text is required.');
        const session = games.say(me, t.slice(0, 2000));
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
        const s = await games.stop(me);
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

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);

export function attachMcpl(server: Server, app: App, log: (m: string) => void) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const open = new Map<WebSocket, McplSession>();
  app.games.on('chat', (session: GameSession) => { for (const s of open.values()) s.maybePushChat(session); });
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
