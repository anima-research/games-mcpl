// HTTP: sign-in (Archipelago redirect → session cookie), the viewer API, the
// viewer WebSocket stream (/ws), static files, health.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { Fault, JtiCache, opaque, tokenHash, type Identity } from './auth.js';
import type { App } from './index.js';
import type { GameSession, Principal, TurnRecord, ChatMessage } from './games.js';

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const cookies = (req: IncomingMessage): Record<string, string> => Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => {
  const i = c.indexOf('='); return i < 0 ? [c.trim(), ''] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
}).filter(([k]) => k));

async function json(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > 64 * 1024) throw new Fault(413, 'Body too large.'); chunks.push(c as Buffer); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Fault(400, 'Body must be JSON.'); }
}

interface Session { identity: Identity; expires: number; created: number }

export function createHttp(app: App, log: (m: string) => void): { server: Server } {
  const production = app.config.origin.startsWith('https:');
  const cookie = (name: string, value: string, maxAge: number) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge))}${production ? '; Secure' : ''}`;
  const SESSION_MS = app.config.sessionDays * 86400_000;
  // Browser sessions persist on disk so a redeploy does not sign everyone out.
  const sessionsFile = join(app.config.dataDir, 'sessions.json');
  const sessions = new Map<string, Session>();
  try {
    if (existsSync(sessionsFile)) for (const [k, v] of Object.entries(JSON.parse(readFileSync(sessionsFile, 'utf8')) as Record<string, Session>)) if (v.expires > Date.now()) sessions.set(k, v);
  } catch (e) { log(`sessions load failed: ${(e as Error).message}`); }
  const saveSessions = () => { try { mkdirSync(app.config.dataDir, { recursive: true }); writeFileSync(sessionsFile, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 }); } catch (e) { log(`sessions save failed: ${(e as Error).message}`); } };
  const jti = new JtiCache();
  const publicDir = join(app.root, 'public');
  // Chat: at most 12 messages a minute per person.
  const chatStamps = new Map<string, number[]>();
  const chatAllowed = (sub: string) => {
    const now = Date.now();
    const arr = (chatStamps.get(sub) ?? []).filter((t) => now - t < 60_000);
    if (arr.length >= 12) { chatStamps.set(sub, arr); return false; }
    arr.push(now); chatStamps.set(sub, arr); return true;
  };

  const createSession = (identity: Identity) => {
    const token = opaque();
    sessions.set(tokenHash(token), { identity, expires: Date.now() + SESSION_MS, created: Date.now() });
    for (const [k, s] of sessions) if (s.expires < Date.now()) sessions.delete(k);
    saveSessions();
    return { token, maxAge: SESSION_MS / 1000 };
  };
  const sessionActor = (req: IncomingMessage): Principal | null => {
    const t = cookies(req).games_session;
    if (!t) return null;
    const s = sessions.get(tokenHash(t));
    if (!s || s.expires < Date.now()) return null;
    try { return app.admit(s.identity, true); } catch { return null; }
  };
  const bearerActor = (req: IncomingMessage): Principal | null => {
    const h = req.headers.authorization;
    if (!h) return null;
    if (!/^Bearer\s+/i.test(h)) throw new Fault(401, 'Use Authorization: Bearer <aid1 token>.');
    return app.admit(app.verify(h.replace(/^Bearer\s+/i, '')));
  };
  const sameOrigin = (req: IncomingMessage) => {
    const o = req.headers.origin;
    if (o && o !== app.config.origin) throw new Fault(403, 'Cross-origin requests are not allowed.');
  };

  // ---------------------------------------------------------------- viewer stream
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const lobby = new Set<WebSocket>();
  const watchers = new Map<WebSocket, { session: GameSession; who: Principal }>();
  const send = (ws: WebSocket, msg: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
  const turnMessage = (s: GameSession, rec: TurnRecord) => ({ type: 'turn', game: s.public(), record: rec, frame: s.frame ? s.frame.toString('base64') : null, automap: s.automap ? s.automap.toString('base64') : null, last: s.last });
  app.games.on('list', () => { const games = app.games.list(); const recent = app.games.recent.slice(0, 12); for (const ws of lobby) send(ws, { type: 'list', games, recent }); });
  app.games.on('turn', (s: GameSession, rec: TurnRecord) => { const msg = turnMessage(s, rec); for (const [ws, w] of watchers) if (w.session === s) send(ws, msg); });
  app.games.on('chat', (s: GameSession, m: ChatMessage) => { for (const [ws, w] of watchers) if (w.session === s) send(ws, { type: 'chat', message: m }); });
  app.games.on('ended', (s: GameSession) => { for (const [ws, w] of watchers) if (w.session === s) send(ws, { type: 'ended', game: s.public() }); });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', app.config.origin);
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const sendJson = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      if (path === '/health') { sendJson(200, { ok: true, games: app.games.sessions.size, maxGames: app.config.maxGames, engine: app.engineOk, catalogue: Object.keys(app.games.catalogue.games), wads: app.wads }); return; }

      // ------------------------------------------------ sign-in
      if (path === '/auth/login' && method === 'GET') {
        const state = opaque(16);
        const issuer = app.config.issuers[0]?.domain;
        if (!issuer) throw new Fault(500, 'No issuer configured.');
        res.setHeader('Set-Cookie', cookie('games_login', state, 600));
        res.writeHead(302, { Location: `https://${issuer}/login?audience=${encodeURIComponent(app.config.audience)}&state=${state}` });
        res.end();
        return;
      }
      if (path === '/auth/exchange' && method === 'POST') {
        sameOrigin(req);
        const body = await json(req);
        const pending = cookies(req).games_login;
        if (!pending) throw new Fault(401, 'Start from the Sign in button.');
        if (body.state !== undefined && body.state !== pending) throw new Fault(401, 'This sign-in did not start here. Start from the Sign in button.');
        const who = app.verify(String(body.token ?? ''));
        if (who.kind !== 'human') throw new Fault(403, 'Browser sign-in is for people; agents connect over MCPL with their token.');
        if (!who.jti || !jti.use(who.jti, who.exp)) throw new Fault(401, 'This sign-in link was already used.');
        const actor = app.admit(who);
        const previous = cookies(req).games_session;
        if (previous) { sessions.delete(tokenHash(previous)); saveSessions(); }
        const s = createSession(who);
        res.setHeader('Set-Cookie', [cookie('games_session', s.token, s.maxAge), cookie('games_login', '', 0)]);
        sendJson(200, { you: publicActor(actor) });
        return;
      }
      if (path === '/auth/logout' && method === 'POST') {
        sameOrigin(req);
        const t = cookies(req).games_session;
        if (t) { sessions.delete(tokenHash(t)); saveSessions(); }
        res.setHeader('Set-Cookie', cookie('games_session', '', 0));
        sendJson(200, { ok: true });
        return;
      }
      if (path.startsWith('/dev/')) {
        if (!app.devIssuer) throw new Fault(404, 'Not found.');
        sameOrigin(req);
        const body = method === 'POST' ? await json(req) : {};
        if (path === '/dev/login' && method === 'POST') {
          const name = String(body.name ?? '').trim() || 'Dev Human';
          const token = app.devIssuer.mint({ name, kind: 'human', audience: app.config.audience, scopes: app.config.requiredScopes });
          const who = app.verify(token);
          const actor = app.admit(who);
          const s = createSession(who);
          res.setHeader('Set-Cookie', cookie('games_session', s.token, s.maxAge));
          sendJson(200, { you: publicActor(actor) });
          return;
        }
        if (path === '/dev/token' && method === 'POST') {
          const name = String(body.name ?? '').trim() || 'Dev Agent';
          const kind = body.kind === 'human' ? 'human' : 'agent';
          sendJson(200, { token: app.devIssuer.mint({ name, kind, audience: app.config.audience, scopes: app.config.requiredScopes }) });
          return;
        }
        throw new Fault(404, 'Not found.');
      }

      // ------------------------------------------------ API (signed in)
      if (path.startsWith('/api/')) {
        const actor = bearerActor(req) ?? sessionActor(req);
        if (path === '/api/me') { sendJson(200, { you: actor ? publicActor(actor) : null, origin: app.config.origin, dev: !!app.devIssuer }); return; }
        if (!actor) throw new Fault(401, 'Sign in to watch.');
        if (path === '/api/games' && method === 'GET') { sendJson(200, { games: app.games.list(), recent: app.games.recent.slice(0, 12), catalogue: app.games.catalogue }); return; }
        if (path === '/api/recordings' && method === 'GET') { sendJson(200, { recordings: app.games.recordings.list().slice(0, 60) }); return; }
        const rm = /^\/api\/recordings\/([a-z0-9]+)(?:\/(f|m)\/(\d+)\.jpg)?$/.exec(path);
        if (rm && method === 'GET') {
          const meta = app.games.recordings.meta(rm[1]);
          if (!meta) throw new Fault(404, 'No recording of that game.');
          if (!rm[2]) { sendJson(200, { meta, live: !!app.games.get(rm[1]), events: app.games.recordings.events(rm[1]) }); return; }
          const buf = app.games.recordings.frame(rm[1], rm[2] as 'f' | 'm', Number(rm[3]));
          if (!buf) throw new Fault(404, 'No such frame.');
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400', 'Content-Length': buf.length });
          res.end(buf);
          return;
        }
        const m = /^\/api\/games\/([a-z0-9]+)(?:\/(frame\.jpg|automap\.jpg|chat|stop))?$/.exec(path);
        if (m) {
          const s = app.games.get(m[1]);
          if (!s) throw new Fault(404, 'That game is over or never existed.');
          const sub = m[2];
          if (!sub && method === 'GET') { sendJson(200, { game: s.public(), last: s.last, log: s.log.slice(-120), chat: s.chat.slice(-60), hasFrame: !!s.frame }); return; }
          if ((sub === 'frame.jpg' || sub === 'automap.jpg') && method === 'GET') {
            const buf = sub === 'frame.jpg' ? s.frame : s.automap;
            if (!buf) throw new Fault(404, 'No picture yet.');
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': buf.length });
            res.end(buf);
            return;
          }
          if (sub === 'chat' && method === 'POST') {
            sameOrigin(req);
            const body = await json(req);
            const t = String(body.text ?? '').trim().slice(0, 500);
            if (!t) throw new Fault(400, 'Say something.');
            if (!chatAllowed(actor.sub)) throw new Fault(429, 'Slow down — a dozen messages a minute is plenty.');
            const msg = app.games.chat(s, { sub: actor.sub, name: actor.name, kind: actor.kind }, t);
            sendJson(200, { message: msg });
            return;
          }
          if (sub === 'stop' && method === 'POST') {
            sameOrigin(req);
            if (!actor.admin && actor.sub !== s.owner.sub) throw new Fault(403, 'Only the player or an admin can stop a game.');
            await app.games.end(s, 'stopped', `stopped by ${actor.name}`);
            sendJson(200, { ok: true });
            return;
          }
        }
        throw new Fault(404, 'Not found.');
      }

      // ------------------------------------------------ static / SPA
      if (method !== 'GET' && method !== 'HEAD') throw new Fault(405, 'Method not allowed.');
      let file = path === '/' || path === '/auth/callback' || /^\/(g|r)\/[a-z0-9]+$/.test(path) ? 'index.html' : normalize(path).replace(/^\/+/, '');
      if (file.includes('..')) throw new Fault(404, 'Not found.');
      const full = join(publicDir, file);
      if (!existsSync(full) || !statSync(full).isFile()) throw new Fault(404, 'Not found.');
      res.writeHead(200, { 'Content-Type': MIME[extname(full)] ?? 'application/octet-stream', 'Cache-Control': file === 'index.html' ? 'no-cache' : 'public, max-age=300' });
      if (method === 'HEAD') { res.end(); return; }
      createReadStream(full).pipe(res);
    } catch (e) {
      const status = e instanceof Fault ? e.status : 500;
      if (status >= 500) log(`${method} ${path}: ${(e as Error).stack ?? e}`);
      if (!res.headersSent) sendJson(status, { error: e instanceof Fault ? e.message : 'Something went wrong.' });
      else res.end();
    }
  });

  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try { url = new URL(req.url ?? '/', app.config.origin); } catch { socket.destroy(); return; }
    if (url.pathname === '/mcpl') return; // the MCPL door takes it
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    let who: Principal | null = null;
    try {
      const o = req.headers.origin;
      if (o && o !== app.config.origin) throw new Fault(403, 'origin');
      who = sessionActor(req);
    } catch { who = null; }
    if (!who) { try { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); } catch { /* ignore */ } socket.destroy(); return; }
    const gameId = url.searchParams.get('game');
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (gameId) {
        const s = app.games.get(gameId);
        if (!s) { send(ws, { type: 'ended', game: null }); ws.close(4004, 'No such game'); return; }
        watchers.set(ws, { session: s, who: who! });
        s.watchers.add(ws);
        app.games.emit('list');
        send(ws, { type: 'hello', you: publicActor(who!), game: s.public(), last: s.last, log: s.log.slice(-120), chat: s.chat.slice(-60), frame: s.frame ? s.frame.toString('base64') : null, automap: s.automap ? s.automap.toString('base64') : null });
        ws.on('close', () => { watchers.delete(ws); s.watchers.delete(ws); app.games.emit('list'); });
      } else {
        lobby.add(ws);
        send(ws, { type: 'list', games: app.games.list(), recent: app.games.recent.slice(0, 12) });
        ws.on('close', () => lobby.delete(ws));
      }
      ws.on('error', () => { /* close follows */ });
      ws.on('message', () => { /* viewers talk over HTTP */ });
    });
  });

  return { server };
}

export const publicActor = (a: Principal) => ({ sub: a.sub, name: a.name, kind: a.kind, admin: a.admin });
