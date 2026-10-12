// End-to-end against a running dev server (GAMES_DEV_ISSUER=dev.local):
//   node --import tsx test/e2e.ts http://127.0.0.1:7372
// Mints an agent token, plays a few turns over /mcpl, checks the viewer API and chat flow.
import WebSocket from 'ws';
import assert from 'node:assert/strict';

const base = process.argv[2] ?? 'http://127.0.0.1:7372';
const wsBase = base.replace(/^http/, 'ws');
const j = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, headers: r.headers };
};

class Client {
  ws!: WebSocket; id = 1; pending = new Map<number, (v: any) => void>(); pushes: any[] = [];
  constructor(private token: string) {}
  connect(): Promise<void> {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(`${wsBase}/mcpl?token=${encodeURIComponent(this.token)}`);
      this.ws.on('open', () => res()); this.ws.on('error', rej);
      this.ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.method === 'push/event') { this.pushes.push(m.params); this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { accepted: true } })); return; }
        const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p(m); }
      });
    });
  }
  call(method: string, params: unknown = {}): Promise<any> {
    const id = this.id++;
    return new Promise((res) => { this.pending.set(id, res); this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
  }
  notify(method: string, params: unknown = {}) { this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params })); }
  async tool(name: string, args: unknown = {}) { const r = await this.call('tools/call', { name, arguments: args }); if (r.error) throw new Error(`${name}: ${r.error.message}`); return r.result; }
}

const textOf = (r: any) => r.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
const imagesOf = (r: any) => r.content.filter((b: any) => b.type === 'image');

async function main() {
  const health = await j('GET', '/health');
  console.log('health', health.data);
  assert.equal(health.data.engine, true, 'engine probe must pass');

  // agent token + unauthenticated refusal
  const bad = await new Promise<number>((res) => { const w = new WebSocket(`${wsBase}/mcpl?token=nope`); w.on('error', () => res(401)); w.on('unexpected-response', (_r, r2) => res(r2.statusCode ?? 0)); w.on('open', () => res(0)); });
  assert.equal(bad, 401, 'bad token must be refused');
  const { data: tok } = await j('POST', '/dev/token', { name: 'Mica (test)', kind: 'agent' });
  const c = new Client(tok.token);
  await c.connect();
  const init = await c.call('initialize', { protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.5', eventCoalescing: true } } }, clientInfo: { name: 'e2e', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'archipelago-games');
  assert.ok(init.result.instructions.includes('game_act'));
  c.notify('notifications/initialized');
  const pol = await c.call('featureSets/update', { effectiveCapabilities: ['tools', 'pushEvents'], enabledFeatureSets: ['*'] });
  console.log('policy receipt', JSON.stringify(pol.result ?? pol.error));
  const tools = await c.call('tools/list');
  assert.ok(tools.result.tools.some((t: any) => t.name === 'game_act'));

  let r = await c.tool('game_list');
  console.log('--- game_list\n' + textOf(r));
  r = await c.tool('game_start', { game: 'freedoom1', map: 'E1M1', skill: 3 });
  const startText = textOf(r);
  console.log('--- game_start\n' + startText.slice(0, 600));
  assert.ok(/health 100/.test(startText)); assert.equal(imagesOf(r).length, 1);
  const gameId = /\/g\/(g[0-9a-f]+)/.exec(startText)![1];

  // human viewer: dev login cookie
  const login = await j('POST', '/dev/login', { name: 'Antra (test)' });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  assert.ok(cookie.startsWith('games_session='));
  const list = await j('GET', '/api/games', undefined, { Cookie: cookie });
  assert.equal(list.data.games.length, 1); assert.equal(list.data.games[0].id, gameId);
  const frame = await fetch(`${base}/api/games/${gameId}/frame.jpg`, { headers: { Cookie: cookie } });
  assert.equal(frame.status, 200); assert.equal(frame.headers.get('content-type'), 'image/jpeg');
  const noauth = await j('GET', '/api/games');
  assert.equal(noauth.status, 401);

  // watcher socket receives turns + chat
  const viewer = new WebSocket(`${wsBase}/ws?game=${gameId}`, { headers: { Cookie: cookie, Origin: base } });
  const got: any[] = [];
  await new Promise<void>((res) => viewer.on('open', () => res()));
  viewer.on('message', (d) => got.push(JSON.parse(d.toString())));
  await new Promise((r2) => setTimeout(r2, 200));
  assert.equal(got[0]?.type, 'hello'); assert.ok(got[0].frame);

  r = await c.tool('game_act', { actions: [{ turn: 90 }, { move: 'forward', tics: 35 }, { attack: 1 }], say: 'Trying the pistol.' });
  const actText = textOf(r);
  console.log('--- game_act\n' + actText.slice(0, 700));
  assert.ok(/turn 1 /.test(actText));
  await new Promise((r2) => setTimeout(r2, 200));
  const turnMsg = got.find((m) => m.type === 'turn');
  assert.ok(turnMsg, 'viewer must get the turn'); assert.equal(turnMsg.record.say, 'Trying the pistol.'); assert.ok(turnMsg.frame);

  const chat = await j('POST', `/api/games/${gameId}/chat`, { text: 'go left!' }, { Cookie: cookie });
  assert.equal(chat.status, 200);
  r = await c.tool('game_state');
  assert.ok(/Watchers say: .*go left!/.test(textOf(r)), 'chat must reach the player');
  r = await c.tool('game_look', { image: 'both', image_scale: 0.5 });
  assert.equal(imagesOf(r).length, 2);
  r = await c.tool('game_act', { actions: [{ goto: [600, 256], max_tics: 140 }], stop_on: [] });
  console.log('--- goto\n' + textOf(r).split('\n').slice(0, 4).join('\n'));
  r = await c.tool('game_watchers'); console.log('--- watchers\n' + textOf(r));
  r = await c.tool('game_stop'); console.log('--- stop\n' + textOf(r));
  await new Promise((r2) => setTimeout(r2, 300));
  assert.ok(got.some((m) => m.type === 'ended'), 'viewer must see the end');
  const after = await j('GET', '/api/games', undefined, { Cookie: cookie });
  assert.equal(after.data.games.length, 0); assert.equal(after.data.recent[0].id, gameId);
  viewer.close(); c.ws.close();
  console.log('\nE2E OK');
}
main().catch((e) => { console.error('E2E FAILED', e); process.exit(1); });
