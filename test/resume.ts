// Restart survival: start a dev server, play two turns over /mcpl, SIGTERM the
// server, start it again, and check the same game is back (same id, running,
// history intact) and the player can simply continue.
//   node --import tsx test/resume.ts
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import assert from 'node:assert/strict';

const PORT = 7399;
const base = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'games-resume-'));
const env = { ...process.env, GAMES_DEV_ISSUER: 'dev.local', GAMES_ISSUERS: '', PORT: String(PORT), GAMES_DATA_DIR: dataDir, DOOM_WAD_DIR: process.env.DOOM_WAD_DIR ?? join(process.cwd(), 'wads') };

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const p = spawn('node', ['dist/src/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); if (/listening on/.test(out)) resolve(p); });
    p.stderr.on('data', (d) => { out += d.toString(); });
    p.on('exit', (c) => { if (!/listening on/.test(out)) reject(new Error(`server exited ${c}: ${out.slice(-400)}`)); });
    (p as any).logs = () => out;
  });
}
const stopServer = (p: ChildProcess) => new Promise<void>((r) => { p.on('exit', () => r()); p.kill('SIGTERM'); });
const j = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

class Client {
  ws!: WebSocket; id = 1; pending = new Map<number, (v: any) => void>();
  constructor(private token: string) {}
  connect() { return new Promise<void>((res, rej) => { this.ws = new WebSocket(`${base.replace('http', 'ws')}/mcpl?token=${encodeURIComponent(this.token)}`); this.ws.on('open', () => res()); this.ws.on('error', rej); this.ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.method === 'push/event') { this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { accepted: true } })); return; } const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p(m); } }); }); }
  call(method: string, params: unknown = {}) { const id = this.id++; return new Promise<any>((res) => { this.pending.set(id, res); this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); }); }
  async init() { await this.call('initialize', { protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.5' } } }, clientInfo: { name: 'resume', version: '0' } }); this.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })); await this.call('featureSets/update', { effectiveCapabilities: ['tools', 'pushEvents'], enabledFeatureSets: ['*'] }); }
  async tool(name: string, args: unknown = {}) { const r = await this.call('tools/call', { name, arguments: args }); if (r.error) throw new Error(`${name}: ${r.error.message}`); return r.result.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') as string; }
}

async function main() {
  let server = await startServer();
  const { data: tok } = await j('POST', '/dev/token', { name: 'Resume Tester', kind: 'agent' });
  let c = new Client(tok.token); await c.connect(); await c.init();
  let t = await c.tool('game_start', { game: 'doom', map: 'E1M1', skill: 2, image: 'none' });
  const gameId = /\/g\/(g[0-9a-f]+)/.exec(t)![1];
  t = await c.tool('game_act', { actions: [{ explore: true }, { explore: true }], say: 'before the restart', image: 'none' });
  const pos1 = /Position \((-?\d+), (-?\d+)\)/.exec(t)!; const turn1 = Number(/turn (\d+)/.exec(t)![1]);
  const explored1 = /Explored (\d+) of/.exec(t)![1];
  console.log('before restart:', gameId, 'turn', turn1, 'pos', pos1[1], pos1[2], 'explored', explored1);
  const login = await j('POST', '/dev/login', { name: 'Watcher' });
  const cookie = ((await fetch(`${base}/dev/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ name: 'Watcher' }) })).headers.get('set-cookie') ?? '').split(';')[0];
  void login;
  await j('POST', `/api/games/${gameId}/chat`, { text: 'still here?' }, { Cookie: cookie });

  c.ws.close();
  await stopServer(server);
  console.log('server stopped; restarting…');
  server = await startServer();
  await new Promise((r) => setTimeout(r, 500));
  const list = await j('GET', '/api/games', undefined, { Cookie: cookie });
  assert.equal(list.status, 200);
  const g = list.data.games.find((x: any) => x.id === gameId);
  assert.ok(g, 'game must be back under the same id'); assert.equal(g.status, 'running');
  const detail = await j('GET', `/api/games/${gameId}`, undefined, { Cookie: cookie });
  assert.ok(detail.data.log.some((r: any) => r.say === 'before the restart'), 'history must survive');
  assert.ok(detail.data.log.some((r: any) => (r.events || []).some((e: string) => /Resumed after a server restart/.test(e))), 'resume record expected');
  assert.ok(detail.data.chat.some((m: any) => m.text === 'still here?'), 'chat must survive');

  c = new Client(tok.token); await c.connect(); await c.init();
  t = await c.tool('game_state');
  const pos2 = /Position \((-?\d+), (-?\d+)\)/.exec(t)!; const explored2 = /Explored (\d+) of/.exec(t)![1];
  console.log('after restart:', 'pos', pos2[1], pos2[2], 'explored', explored2, 'turn', /turn (\d+)/.exec(t)![1]);
  assert.ok(Math.hypot(Number(pos2[1]) - Number(pos1[1]), Number(pos2[2]) - Number(pos1[2])) < 64, 'position must be where we left it');
  assert.equal(explored2, explored1, 'explored areas must survive');
  t = await c.tool('game_act', { actions: [{ explore: true }], image: 'none' });
  assert.equal(Number(/turn (\d+)/.exec(t)![1]), turn1 + 1, 'turn numbering continues');
  console.log('continued:', /Did: [^\n]*/.exec(t)![0].slice(0, 100));
  await c.tool('game_stop');
  c.ws.close();
  await stopServer(server);
  console.log('\nRESUME OK');
}
main().catch((e) => { console.error('RESUME FAILED', e); process.exit(1); });
