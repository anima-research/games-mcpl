// MCPL RFC-014 (tool presence, toolsets and surfaces) against the real engine: a scripted host
// that advertises toolHints opens the game toolset, plays until it dies, restarts, reconnects and
// adopts its game, sees changes made elsewhere arrive as pushes, closes with and without `keep`;
// a plain host under the same identity sees today's behaviour throughout. Starts its own dev
// server (like test/resume.ts) and checks the conformance vectors of RFC-014 §13 that apply to a
// server: 1 (full list), 2 (call results carry hints, no push for them), 4 (rev order),
// 7 (a definition change without tools/list_changed), 8 (no hints to a host without toolHints),
// 9 (toolsets/list after a reconnect adopts the running game), 11 (a refused push is not
// restated: its hints applied on arrival, and the next change takes the next rev), 12
// (toolsets/list is a full statement, with current definitions), 13 (`ended` records by id), 14 (another
// connection hears of an open as a state change), 16 (close results carry hints), 18 (`adopted`),
// 19 (no `coalesce` on a push carrying hints). A second server, on a scripted
// sidecar (test/fake_sidecar.py) that finishes a level on cue, covers level complete: game_next
// appears with a definition naming its map (vector 7) and goes away after the last map; a game
// ended from outside MCPL (the web viewer's stop, like the idle sweep) is pushed with its reason
// to a connection that has it open, and reported by toolsets/list `ended` to one that did not.
//   npm run build && node --import tsx test/hints.ts
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import assert from 'node:assert/strict';

const PORT = Number(process.env.HINTS_TEST_PORT ?? 7396);
let base = `http://localhost:${PORT}`;

function startServer(port: number, extra: Record<string, string> = {}): Promise<ChildProcess> {
  base = `http://localhost:${port}`;
  const dataDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'games-hints-'));
  const env = { ...process.env, GAMES_DEV_ISSUER: 'dev.local', GAMES_ISSUERS: '', PORT: String(port), GAMES_DATA_DIR: dataDir, ...extra };
  return new Promise((resolve, reject) => {
    const p = spawn('node', ['dist/src/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); if (/listening on/.test(out)) resolve(p); });
    p.stderr.on('data', (d) => { out += d.toString(); });
    p.on('exit', (c) => { if (!/listening on/.test(out)) reject(new Error(`server exited ${c}: ${out.slice(-400)}`)); });
  });
}
const stopServer = (p: ChildProcess) => new Promise<void>((r) => { if (p.exitCode !== null) { r(); return; } p.on('exit', () => r()); p.kill('SIGTERM'); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

type Msg = Record<string, any>;
/** A small host: records everything the server sends, in wire order, and accepts pushes. */
class Host {
  ws!: WebSocket; id = 1; pending = new Map<number, (v: Msg) => void>();
  wire: Msg[] = [];
  /** Answer pushes with accepted:false (a host whose policy refuses them). */
  refuse = false;
  constructor(readonly label: string, private token: string, private toolHints: boolean, private pushes = true) {}
  connect() {
    return new Promise<void>((res, rej) => {
      this.ws = new WebSocket(`${base.replace('http', 'ws')}/mcpl?token=${encodeURIComponent(this.token)}`);
      this.ws.on('open', () => res()); this.ws.on('error', rej);
      this.ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        this.wire.push(m);
        if (m.method === 'push/event') { this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { accepted: !this.refuse } })); return; }
        const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p(m); }
      });
    });
  }
  call(method: string, params: unknown = {}) { const id = this.id++; return new Promise<Msg>((res) => { this.pending.set(id, res); this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); }); }
  async init() {
    const mcpl = { version: '0.5', ...(this.toolHints ? { toolHints: true } : {}) };
    const r = await this.call('initialize', { protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl } }, clientInfo: { name: `hints-${this.label}`, version: '0' } });
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    await this.call('featureSets/update', { effectiveCapabilities: this.pushes ? ['tools', 'pushEvents'] : ['tools'], enabledFeatureSets: ['*'] });
    return r.result;
  }
  async tool(name: string, args: unknown = {}) { const r = await this.call('tools/call', { name, arguments: args }); if (r.error) throw new Error(`${name}: ${r.error.message}`); return r.result; }
  /** Hint changes in the order they arrived: results' _meta, pushes' `hints`, tools/hints. */
  hints(): Array<{ via: string; h: Msg }> {
    const out: Array<{ via: string; h: Msg }> = [];
    for (const m of this.wire) {
      if (m.result?._meta?.['mcpl/hints']) out.push({ via: 'result', h: m.result._meta['mcpl/hints'] });
      else if (m.method === 'push/event' && m.params?.hints) out.push({ via: 'push', h: m.params.hints });
      else if (m.method === 'tools/hints') out.push({ via: 'tools/hints', h: m.params });
    }
    return out;
  }
  /** Unsolicited hint traffic (pushes with hints, tools/hints) after wire index `from`. */
  unsolicited(from: number) { return this.wire.slice(from).filter((m) => m.method === 'tools/hints' || (m.method === 'push/event' && m.params?.hints)); }
  close() { this.ws.close(); }
}

const textOf = (r: Msg) => (r.content ?? []).filter((b: Msg) => b.type === 'text').map((b: Msg) => b.text).join('\n') as string;
const hintsOf = (r: Msg) => r._meta?.['mcpl/hints'] as Msg | undefined;
const vis = (h: Msg | undefined) => Object.fromEntries((h?.tools ?? []).map((t: Msg) => [t.name, t.visible]));
const listVis = (tools: Msg[]) => Object.fromEntries(tools.map((t) => [t.name, t._meta?.['mcpl/visible']]));
async function waitFor<T>(what: string, f: () => T | undefined | false, ms = 3000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) { const v = f(); if (v) return v; if (Date.now() > until) throw new Error(`timed out waiting for ${what}`); await sleep(25); }
}
const show = (label: string, v: unknown) => console.log(`--- ${label}\n${JSON.stringify(v, (k, x) => (k === 'data' && typeof x === 'string' ? `<${x.length} b64>` : x), 1).slice(0, 1600)}`);

async function main() {
  let server = await startServer(PORT);
  try { await run(); } finally { await stopServer(server); }
  server = await startServer(PORT + 1, { GAMES_SIDECAR: join(process.cwd(), 'test', 'fake_sidecar.py') });
  try { await scripted(); } finally { await stopServer(server); }
  console.log('\nHINTS OK');
}

/** On the scripted sidecar: level complete, game_next and its per-map definition (vector 7); an end from outside MCPL. */
async function scripted() {
  const { data: tok } = await post('/dev/token', { name: 'Hints Tester', kind: 'agent' });
  const h = new Host('fake', tok.token, true); await h.connect(); await h.init();
  await h.call('toolsets/open', { toolset: 'game', options: { map: 'E1M8', image: 'none' } });
  let r = await h.tool('game_act', { actions: [{ use: true }], image: 'none' });
  show('level complete: result _meta', r._meta);
  assert.match(textOf(r), /game_next goes on to E2M1/);
  const next = hintsOf(r)!.tools.find((t: Msg) => t.name === 'game_next');
  assert.equal(next.visible, true);
  assert.equal(next.definition.description, 'Go on to the next map, E2M1 (same game and skill).');
  assert.equal(next.definition._meta['mcpl/toolset'], 'game');
  assert.equal(next.definition.name, 'game_next'); assert.equal(next.definition._meta['mcpl/visible'], undefined, 'a definition changes description and schema only');
  // vector 12: toolsets/list (the recovery read) restates the current definition
  const rl = (await h.call('toolsets/list')).result;
  assert.equal(hintsOf(rl)!.tools.find((t: Msg) => t.name === 'game_next').definition.description, 'Go on to the next map, E2M1 (same game and skill).');
  // a full statement: every tool visible in the open toolset is stated visible (anything not stated visible is invisible)
  assert.deepEqual(hintsOf(rl)!.tools.filter((t: Msg) => t.visible).map((t: Msg) => t.name).sort(),
    ['game_look', 'game_next', 'game_restart', 'game_say', 'game_start', 'game_state', 'game_stop', 'game_watchers']);
  assert.deepEqual(hintsOf(rl)!.toolsets, [{ toolset: 'game', state: 'open', title: 'freedoom1 E1M8, skill 3' }]);
  const listed = ((await h.call('tools/list')).result.tools as Msg[]).find((t) => t.name === 'game_next')!;
  assert.equal(listed._meta['mcpl/visible'], true);
  assert.match(listed.description, /after finishing a level/, 'tools/list keeps the declared definition');
  r = await h.tool('game_next', { image: 'none' });
  assert.match(textOf(r), /On to E2M1/);
  assert.deepEqual(hintsOf(r)!.toolsets, [{ toolset: 'game', state: 'open', title: 'freedoom1 E2M1, skill 3' }]);
  assert.deepEqual(vis(hintsOf(r)), { game_act: true, game_start: false, game_restart: false, game_next: false });
  // finishing E2M1 names E2M2: a new definition, not a repeat
  r = await h.tool('game_act', { actions: [{ use: true }], image: 'none' });
  assert.equal(hintsOf(r)!.tools.find((t: Msg) => t.name === 'game_next').definition.description, 'Go on to the next map, E2M2 (same game and skill).');
  // the last map: no game_next
  r = await h.tool('game_start', { map: 'E4M8', image: 'none' });
  assert.equal(vis(hintsOf(r)).game_next, false);
  r = await h.tool('game_act', { actions: [{ use: true }], image: 'none' });
  assert.match(textOf(r), /That was the last map/);
  assert.equal(vis(hintsOf(r)).game_next, undefined, 'game_next stays invisible');
  r = await h.tool('game_next', {});
  assert.ok(r.isError && /E4M8 was the last map/.test(textOf(r)));
  await h.call('toolsets/close', { toolset: 'game' });
  // ended from outside MCPL (the web viewer's stop; the idle sweep takes the same path): pushed with its reason
  const o = (await h.call('toolsets/open', { toolset: 'game', options: { image: 'none' } })).result;
  const id = /\/g\/(g[0-9a-f]+)/.exec(textOf(o))![1];
  const mark = h.wire.length;
  assert.equal((await post(`/api/games/${id}/stop`, {}, { Authorization: `Bearer ${tok.token}` })).status, 200);
  const ev = await waitFor('the web stop pushed', () => h.wire.slice(mark).find((m) => m.method === 'push/event' && m.params?.hints));
  assert.match(ev.params.payload.content[0].text, /Your game ended \(stopped by Hints Tester\)/);
  assert.deepEqual(ev.params.hints.toolsets, [{ toolset: 'game', state: 'closed' }]);
  // vector 11: a host that refuses the push gets the state restated standalone, under a higher rev
  const o2 = (await h.call('toolsets/open', { toolset: 'game', options: { image: 'none' } })).result;
  const id2 = /\/g\/(g[0-9a-f]+)/.exec(textOf(o2))![1];
  h.refuse = true;
  const mark2 = h.wire.length;
  assert.equal((await post(`/api/games/${id2}/stop`, {}, { Authorization: `Bearer ${tok.token}` })).status, 200);
  const refused = await waitFor('the refused push', () => h.wire.slice(mark2).find((m) => m.method === 'push/event' && m.params?.hints));
  await sleep(300);
  assert.ok(!h.wire.slice(mark2).some((m) => m.method === 'tools/hints'), 'RFC-014 r4: nothing is restated after a refused push');
  h.refuse = false;
  const nextChange = (await h.call('toolsets/open', { toolset: 'game', options: { image: 'none' } })).result;
  show('a refused push, then the next change', { refused: refused.params.hints.rev, next: hintsOf(nextChange)!.rev });
  assert.equal(hintsOf(nextChange)!.rev, refused.params.hints.rev + 1, 'the next change takes the next rev');
  await h.call('toolsets/close', { toolset: 'game' });
  // §5.3 `ended` (r5): every end the host did not ask for with toolsets/close is recorded, whoever was
  // connected — the two web stops above ended games while `h` was online and was pushed them, and a
  // later connection still finds both records, by id, on every list until they expire
  const told = new Host('told', tok.token, true); await told.connect(); await told.init();
  const lt = (await told.call('toolsets/list')).result;
  show('toolsets/list on a later connection, after ends another connection saw', lt);
  assert.deepEqual(lt.open, []);
  assert.deepEqual(lt.ended.map((e: Msg) => e.id), [`game-${id}`, `game-${id2}`], 'recorded although h was online; the toolsets/close is not');
  assert.match(lt.ended[0].reason, /^stopped by Hints Tester/);
  const o3 = (await h.call('toolsets/open', { toolset: 'game', options: { image: 'none' } })).result;
  const id3 = /\/g\/(g[0-9a-f]+)/.exec(textOf(o3))![1];
  h.close(); told.close(); await sleep(200);
  assert.equal((await post(`/api/games/${id3}/stop`, {}, { Authorization: `Bearer ${tok.token}` })).status, 200);
  const later = new Host('later', tok.token, true); await later.connect(); await later.init();
  const l1 = (await later.call('toolsets/list')).result;
  show('toolsets/list after a game ended unseen', l1);
  assert.deepEqual(l1.open, []);
  assert.deepEqual(l1.ended.at(-1), { id: `game-${id3}`, toolset: 'game', reason: 'stopped by Hints Tester (freedoom1 E1M1, turn 0)' });
  assert.deepEqual(l1.ended.map((e: Msg) => e.id), [`game-${id}`, `game-${id2}`, `game-${id3}`]);
  assert.deepEqual((await later.call('toolsets/list')).result.ended, l1.ended, 'every list, the same id');
  const other = new Host('other', tok.token, true); await other.connect(); await other.init();
  assert.deepEqual((await other.call('toolsets/list')).result.ended, l1.ended, 'a reconnect: the same record, the same id');
  const o4 = (await later.call('toolsets/open', { toolset: 'game', options: { image: 'none' } })).result;
  const id4 = /\/g\/(g[0-9a-f]+)/.exec(textOf(o4))![1];
  const fresh = new Host('fresh', tok.token, true); await fresh.connect(); await fresh.init();
  const lf = (await fresh.call('toolsets/list')).result;
  assert.deepEqual(lf.ended, l1.ended, 'a second reconnect, with a newer game open: still the same id until it expires');
  assert.equal(lf.open.length, 1);
  // r5 §6.2: a connection that cannot take pushes (no pushEvents grant) gets the change as tools/hints
  const nopush = new Host('nopush', tok.token, true, false); await nopush.connect(); await nopush.init();
  await nopush.call('toolsets/list');
  const mp = nopush.wire.length; const ml = later.wire.length;
  assert.equal((await post(`/api/games/${id4}/stop`, {}, { Authorization: `Bearer ${tok.token}` })).status, 200);
  const standalone = await waitFor('tools/hints on the no-push connection', () => nopush.wire.slice(mp).find((m) => m.method === 'tools/hints'));
  assert.deepEqual(standalone.params.toolsets, [{ toolset: 'game', state: 'closed' }]);
  assert.ok(!nopush.wire.some((m) => m.method === 'push/event'));
  await waitFor('the push on the connection that can take it', () => later.wire.slice(ml).find((m) => m.method === 'push/event' && m.params?.hints));
  for (const host of [h, told, later, other, fresh, nopush]) {
    assert.ok(!host.wire.some((m) => m.method === 'push/event' && m.params?.hints && m.params?.coalesce), 'vector 19');
    // RFC-014 r4: consecutive revs on each connection, across results, pushes and tools/hints
    const revs = host.hints().map((x) => x.h.rev);
    revs.forEach((rev, i) => assert.equal(rev, i + 1, `${host.label}: revs ${revs.join(' ')} (${host.hints().map((x) => x.via).join(', ')})`));
  }
  for (const host of [later, other, fresh, nopush]) host.close();
}

async function run() {
  const { data: tok } = await post('/dev/token', { name: 'Hints Tester', kind: 'agent' });

  // ── a host that advertises toolHints ──
  const h1 = new Host('h1', tok.token, true); await h1.connect();
  const init = await h1.init();
  const caps = init.capabilities.experimental.mcpl;
  assert.equal(caps.toolHints, true);
  assert.equal(caps.toolsets.game.default, 'closed');
  assert.equal(caps.toolsets.game.instances, false);
  assert.ok(caps.toolsets.game.options.properties.keep && caps.surface.title);
  show('toolset declaration (initialize result)', { toolHints: caps.toolHints, toolsets: caps.toolsets, surface: caps.surface });

  // vector 1: every tool, visible or not; static vs the toolset
  let tools = (await h1.call('tools/list')).result.tools as Msg[];
  assert.equal(tools.length, 11);
  assert.ok(tools.every((t) => t._meta?.['mcpl/presence']));
  assert.deepEqual(tools.filter((t) => t._meta['mcpl/presence'] === 'static').map((t) => t.name).sort(), ['game_list', 'game_results']);
  assert.ok(tools.filter((t) => t._meta['mcpl/toolset'] === 'game').every((t) => t._meta['mcpl/visible'] === false), 'lobby: nothing in the toolset is visible');
  // RFC-014 r6 §5.3: a toolsets/list result always carries its hints and takes a rev, empty or not
  assert.deepEqual((await h1.call('toolsets/list')).result, { open: [], _meta: { 'mcpl/hints': { rev: 1, tools: [] } } });
  let r = await h1.tool('game_act', { actions: [{ wait: 1 }] });
  assert.ok(r.isError && /not open: you have no game/.test(textOf(r)), 'a closed toolset refuses its tools');
  assert.equal((await h1.call('toolsets/open', { toolset: 'chess' })).error?.code, -32602);
  assert.equal((await h1.call('toolsets/open', { toolset: 'game', instance: 'x' })).error?.code, -32602);
  assert.equal((await h1.call('toolsets/open', { toolset: 'game', options: { skill: 9 } })).error?.code, -32602);
  assert.equal((await h1.call('toolsets/open', { toolset: 'game', options: { game: 'tetris' } })).error?.code, -32602);

  // open: starts a game; the result carries content and the full hint state
  const open = (await h1.call('toolsets/open', { toolset: 'game', options: { game: 'freedoom2', map: 'MAP01', skill: 5, image: 'none' } })).result;
  show('toolsets/open result', open);
  assert.equal(open.toolset, 'game'); assert.equal(open.title, 'freedoom2 MAP01, skill 5');
  assert.match(textOf(open), /Your game is live/);
  const gameId = /\/g\/(g[0-9a-f]+)/.exec(textOf(open))![1];
  let h = hintsOf(open)!;
  assert.deepEqual(h.toolsets, [{ toolset: 'game', state: 'open', title: 'freedoom2 MAP01, skill 5' }]);
  assert.equal(h.tools.length, 9, 'every toolset tool, visible or not');
  assert.equal(vis(h).game_act, true); assert.equal(vis(h).game_restart, false);
  tools = (await h1.call('tools/list')).result.tools;
  assert.equal(listVis(tools).game_act, true); assert.equal(listVis(tools).game_restart, false);
  r = await h1.tool('game_restart', {});
  assert.ok(r.isError && /not available right now: you are playing MAP01/.test(textOf(r)));

  // vector 2: play until dead — the death rides in that call's result, and nothing is pushed for it
  let died: Msg | null = null; let mark = 0;
  for (let i = 0; i < 60 && !died; i++) {
    mark = h1.wire.length;
    r = await h1.tool('game_act', { actions: i % 2 ? [{ wait: 350 }] : [{ attack: 1 }, { explore: true }], stop_on: ['dead'], image: 'none' });
    // The engine's autosave after a turn runs a few tics, so a death can land between turns; the
    // next game_act then reads "Episode is over". Either way that call is the one that reports it.
    if (/YOU DIED|Episode is over/.test(textOf(r))) died = r; else assert.equal(hintsOf(r), undefined, `no changes while playing on; got them with:\n${textOf(r)}`);
  }
  assert.ok(died, 'expected to die on Nightmare within 60 turns');
  show('the call that died: result _meta', died._meta);
  if (/YOU DIED/.test(textOf(died))) assert.match(textOf(died), /game_restart tries the map again/);
  assert.deepEqual(vis(hintsOf(died)), { game_act: false, game_start: true, game_restart: true });
  await sleep(400);
  assert.deepEqual(h1.unsolicited(mark), [], 'no push or tools/hints for a call\'s own consequences');
  r = await h1.tool('game_act', { actions: [{ wait: 1 }] });
  assert.ok(r.isError && /you died on MAP01/.test(textOf(r)));

  r = await h1.tool('game_restart', { image: 'none' });
  assert.match(textOf(r), /MAP01 again/);
  assert.deepEqual(vis(hintsOf(r)), { game_act: true, game_start: false, game_restart: false });
  r = await h1.tool('game_act', { actions: [{ turn: 10 }], image: 'none' });
  const turnBefore = Number(/turn (\d+)/.exec(textOf(r))![1]);

  // vector 9: a reconnect adopts the running game through toolsets/list
  h1.close(); await sleep(200);
  const h1b = new Host('h1b', tok.token, true); await h1b.connect(); await h1b.init();
  const list = (await h1b.call('toolsets/list')).result;
  show('toolsets/list after reconnect', list);
  assert.deepEqual(list.open, [{ toolset: 'game', title: 'freedoom2 MAP01, skill 5' }]);
  assert.equal(vis(hintsOf(list)).game_act, true);
  r = await h1b.tool('game_act', { actions: [{ turn: -10 }], image: 'none' });
  assert.equal(Number(/turn (\d+)/.exec(textOf(r))![1]), turnBefore + 1, 'the same game continues');
  // re-opening what is open adopts it and changes nothing
  const again = (await h1b.call('toolsets/open', { toolset: 'game', options: { map: 'MAP07', image: 'none' } })).result;
  assert.match(textOf(again), /You already have a game; this is it/); assert.match(textOf(again), /Not applied \(map\)/);
  assert.equal(again.adopted, true, 'vector 18'); assert.equal(open.adopted, undefined);
  assert.ok(textOf(again).includes(`/g/${gameId}`));

  // vector 8: a plain host under the same identity — today's behaviour, never any hints
  const plain = new Host('plain', tok.token, false); await plain.connect();
  const pInit = await plain.init();
  assert.equal(pInit.capabilities.experimental.mcpl.toolHints, undefined);
  assert.equal(pInit.capabilities.experimental.mcpl.toolsets, undefined);
  const pTools = (await plain.call('tools/list')).result.tools as Msg[];
  assert.deepEqual(pTools.map((t) => t.name), ['game_list', 'game_start', 'game_act', 'game_look', 'game_state', 'game_say', 'game_watchers', 'game_stop', 'game_results']);
  assert.equal((await plain.call('toolsets/list')).error?.code, -32601);
  r = await plain.tool('game_state');
  assert.ok(!r.isError && !r._meta, 'not gated, no hints');
  r = await plain.tool('game_restart');
  assert.ok(r.isError && /Unknown tool/.test(textOf(r)));

  // a second hinted host adopts too; then the plain host stops the game: both hinted hosts are
  // told with a push that explains it (it is not their call), the plain host with nothing
  const h2 = new Host('h2', tok.token, true); await h2.connect(); await h2.init();
  assert.equal((await h2.call('toolsets/list')).result.open.length, 1);
  const m1 = h1b.wire.length; const m2 = h2.wire.length;
  r = await plain.tool('game_stop');
  assert.ok(!r._meta);
  const ended = await waitFor('the end pushed to h1b', () => h1b.wire.slice(m1).find((m) => m.method === 'push/event' && m.params?.hints));
  show('push for a game stopped elsewhere', ended.params);
  assert.match(ended.params.payload.content[0].text, /stopped from another connection/);
  assert.deepEqual(ended.params.hints.toolsets, [{ toolset: 'game', state: 'closed' }]);
  assert.equal(ended.params.toolset, 'game'); assert.ok(ended.params.tags.includes('surface:done'));
  await waitFor('the end pushed to h2', () => h2.wire.slice(m2).find((m) => m.method === 'push/event' && m.params?.hints));

  // RFC-014 §5.6: the toolset belongs to the identity — an open on h1b reaches h2 (closed now) as
  // an ordinary hint change, standalone: the toolset's state and its tools' visibility, no suggestion
  const m3 = h2.wire.length;
  const o2 = (await h1b.call('toolsets/open', { toolset: 'game', options: { image: 'none' } })).result;
  assert.equal(o2.title, 'freedoom1 E1M1, skill 3');
  const opened = await waitFor('the open on h2', () => h2.wire.slice(m3).find((m) => m.method === 'tools/hints'));
  show('tools/hints on the other hinted connection', opened.params);
  assert.deepEqual(opened.params.toolsets, [{ toolset: 'game', state: 'open', title: 'freedoom1 E1M1, skill 3' }]);
  assert.equal(opened.params.suggest, undefined);
  assert.equal(opened.params.tools.length, 9); assert.equal(vis(opened.params).game_act, true);
  // h2 now plays the same game; h1b hears of h2's turn only if it changes something (it does not)
  const m4 = h1b.wire.length;
  r = await h2.tool('game_act', { actions: [{ turn: 5 }], image: 'none' });
  assert.ok(!r.isError);
  // tools/list carries the rev it reflects
  const h2revs = h2.hints().map((x) => x.h.rev);
  assert.equal((await h2.call('tools/list')).result._meta['mcpl/rev'], h2revs[h2revs.length - 1]);
  assert.equal((await plain.call('tools/list')).result._meta, undefined, 'a plain host\'s list is as before');
  await sleep(100);
  assert.deepEqual(h1b.unsolicited(m4), []);

  // close ends the game, on every connection: h2 is told with a push that explains it
  const m5 = h2.wire.length;
  const closed = (await h1b.call('toolsets/close', { toolset: 'game' })).result;
  assert.match(textOf(closed), /Stopped your game/);
  assert.deepEqual(hintsOf(closed)!.toolsets, [{ toolset: 'game', state: 'closed' }]);
  const afterClose = (await h1b.call('toolsets/list')).result;
  assert.deepEqual(afterClose.open, []);
  assert.deepEqual(hintsOf(afterClose)!.tools, [], 'an empty statement, under its own rev');
  assert.equal(hintsOf(afterClose)!.rev, hintsOf(closed)!.rev + 1);
  assert.deepEqual(afterClose.ended.map((e: Msg) => e.id), [`game-${gameId}`], 'the plain host\'s game_stop is recorded; this toolsets/close is not');
  const closedOnH2 = await waitFor('the close on h2', () => h2.wire.slice(m5).find((m) => m.method === 'push/event' && m.params?.hints));
  assert.deepEqual(closedOnH2.params.hints.toolsets, [{ toolset: 'game', state: 'closed' }]);

  // keep: close leaves the game running and closed; the next open picks it up
  await h1b.call('toolsets/open', { toolset: 'game', options: { keep: true, image: 'none' } });
  r = await h1b.tool('game_act', { actions: [{ turn: 5 }], image: 'none' });
  const kept = (await h1b.call('toolsets/close', { toolset: 'game' })).result;
  assert.match(textOf(kept), /stays on the server/);
  await sleep(100); // other connections are told after a 25 ms debounce; let h2 see this step on its own
  assert.deepEqual(hintsOf(kept)!.toolsets, [{ toolset: 'game', state: 'closed' }]);
  assert.deepEqual((await h1b.call('toolsets/list')).result.open, [], 'a kept game is not open');
  r = await h1b.tool('game_act', { actions: [{ wait: 1 }] });
  assert.ok(r.isError && /kept on the server/.test(textOf(r)));
  assert.match(textOf(await h1b.tool('game_list')), /Kept on the server/);
  const back = (await h1b.call('toolsets/open', { toolset: 'game', options: { keep: false, image: 'none' } })).result;
  assert.match(textOf(back), /Picked up the game you kept/); assert.match(textOf(back), /turn 1/);
  assert.equal(back.adopted, undefined, 'a kept game\'s toolset was closed: picking it up is a real open');
  await sleep(100);
  assert.match(textOf((await h1b.call('toolsets/close', { toolset: 'game' })).result), /Stopped your game/);
  await sleep(100);
  // what h2 saw of all that, made on h1b: open, closed (stopped), open (keep), closed (kept), open (picked up), closed
  const h2states = h2.hints().flatMap((x) => (x.h.toolsets ?? []).map((t: Msg) => `${t.state}${x.via === 'push' ? '*' : ''}`));
  console.log('h2 toolset states:', h2states.join(' '), '(* = on a push that explains it)');
  assert.deepEqual(h2states, ['open', 'closed*', 'open', 'closed*', 'open', 'closed', 'open', 'closed*']);

  // vector 4: on every connection, revs strictly increase in wire order
  for (const host of [h1, h1b, h2, plain]) {
    assert.ok(!host.wire.some((m) => m.method === 'push/event' && m.params?.hints && m.params?.coalesce), 'vector 19');
    // RFC-014 r4: consecutive revs on each connection, across results, pushes and tools/hints
    const revs = host.hints().map((x) => x.h.rev);
    revs.forEach((rev, i) => assert.equal(rev, i + 1, `${host.label}: revs ${revs.join(' ')} (${host.hints().map((x) => x.via).join(', ')})`));
    console.log(`${host.label}: ${revs.length} hint changes, revs ${revs.join(' ')} (${host.hints().map((x) => x.via).join(', ') || 'none'})`);
  }
  // vector 8: nothing hint-shaped ever reached the plain host
  assert.equal(plain.hints().length, 0);
  assert.ok(!plain.wire.some((m) => m.method === 'tools/hints' || (m.method === 'push/event' && (m.params?.hints || m.params?.toolset))));
  for (const host of [h1b, h2, plain]) host.close();
}

main().catch((e) => { console.error('HINTS FAILED', e); process.exit(1); });
