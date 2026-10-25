// Go as the `go` toolset (MCPL RFC-014, named instances), end to end: scripted hosts that
// advertise toolHints against a dev server this script starts (like test/resume.ts).
//   - a bot game: named and server-chosen instances, a call without mcpl/instance while two are
//     open, adoption, playing (the bot's reply inside the call), two passes, scoring, accept, over,
//     sgf, rematch;
//   - two identities by join code: each move reaches the other as a push (surface:turn) carrying
//     their visibility change; scoring and acceptance across both; a rematch offer and acceptance;
//     an opponent offline whose events wait for their next toolsets/list; a forfeit on close;
//   - reconnect and server restart: toolsets/list reports the instance, the game goes on;
//   - a host without toolHints never sees Go.
// RFC-014 §13 vectors: 1, 2, 4, 5, 6, 9, 14, 16, 17, 18, 19; r4's consecutive revs (every host
// here asserts rev = last + 1 on every message) and full toolsets/list statements; r5's name
// grammar, `ended` for an end a call caused, and tools/hints for a connection without pushes.
//   npm run build && node --import tsx test/go.ts
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import assert from 'node:assert/strict';

const PORT = Number(process.env.GO_TEST_PORT ?? 7394);
const base = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'games-go-'));

function startServer(): Promise<ChildProcess> {
  const env = { ...process.env, GAMES_DEV_ISSUER: 'dev.local', GAMES_ISSUERS: '', PORT: String(PORT), GAMES_DATA_DIR: dataDir };
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
const token = async (name: string) => (await (await fetch(`${base}/dev/token`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ name, kind: 'agent' }) })).json()).token as string;

type Msg = Record<string, any>;
class Host {
  ws!: WebSocket; id = 1; pending = new Map<number, (v: Msg) => void>();
  wire: Msg[] = [];
  /** The host's own view of per-instance visibility, built from hints in rev order. */
  vis = new Map<string, Set<string>>();
  lastRev = 0;
  /** Ids of toolsets/list requests: their results are full statements that replace the per-instance state. */
  private lists = new Set<number>();
  constructor(readonly label: string, private tok: string, private toolHints = true, private grantPushes = true) {}
  connect() {
    return new Promise<void>((res, rej) => {
      this.ws = new WebSocket(`${base.replace('http', 'ws')}/mcpl?token=${encodeURIComponent(this.tok)}`);
      this.ws.on('open', () => res()); this.ws.on('error', rej);
      this.ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        this.wire.push(m);
        const h = m.result?._meta?.['mcpl/hints'] ?? (m.method === 'push/event' ? m.params?.hints : m.method === 'tools/hints' ? m.params : undefined);
        if (this.lists.delete(m.id)) this.vis.clear(); // RFC-014 r4 §5.3: a list replaces the per-instance state
        if (h) this.apply(h);
        if (m.method === 'push/event') { this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { accepted: true } })); return; }
        const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p(m); }
      });
    });
  }
  private apply(h: Msg) {
    // RFC-014 r4 §6.1: revs on a connection are consecutive across results, pushes and tools/hints
    assert.equal(h.rev, this.lastRev + 1, `${this.label}: rev ${h.rev} after ${this.lastRev}`);
    this.lastRev = h.rev;
    for (const t of h.tools ?? []) {
      if (!t.name.startsWith('go_')) continue;
      assert.ok(t.instance, 'a go tool entry names its instance');
      const s = this.vis.get(t.instance) ?? new Set<string>();
      if (t.visible) s.add(t.name); else s.delete(t.name);
      this.vis.set(t.instance, s);
    }
    for (const ts of h.toolsets ?? []) if (ts.toolset === 'go' && ts.state === 'closed') this.vis.delete(ts.instance);
  }
  visible(instance: string) { return [...(this.vis.get(instance) ?? [])].sort(); }
  call(method: string, params: unknown = {}) {
    const id = this.id++;
    if (method === 'toolsets/list') this.lists.add(id);
    return new Promise<Msg>((res) => { this.pending.set(id, res); this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
  }
  async init() {
    const r = await this.call('initialize', { protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.5', ...(this.toolHints ? { toolHints: true } : {}) } } }, clientInfo: { name: `go-${this.label}`, version: '0' } });
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    await this.call('featureSets/update', { effectiveCapabilities: this.grantPushes ? ['tools', 'pushEvents'] : ['tools'], enabledFeatureSets: ['*'] });
    return r.result;
  }
  async open(options: Msg, instance?: string) { const r = await this.call('toolsets/open', { toolset: 'go', ...(instance ? { instance } : {}), options }); if (r.error) throw new Error(`open: ${r.error.message}`); return r.result; }
  async tool(name: string, args: Msg = {}, instance?: string) {
    const r = await this.call('tools/call', { name, arguments: args, ...(instance ? { _meta: { 'mcpl/instance': instance } } : {}) });
    if (r.error) throw new Error(`${name}: ${r.error.message}`);
    return r.result;
  }
  pushes(from = 0) { return this.wire.slice(from).filter((m) => m.method === 'push/event').map((m) => m.params); }
  close() { this.ws.close(); }
}

const textOf = (r: Msg) => (r.content ?? []).filter((b: Msg) => b.type === 'text').map((b: Msg) => b.text).join('\n') as string;
const hintsOf = (r: Msg) => r._meta?.['mcpl/hints'] as Msg | undefined;
async function waitFor<T>(what: string, f: () => T | undefined | false, ms = 5000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) { const v = f(); if (v) return v; if (Date.now() > until) throw new Error(`timed out waiting for ${what}`); await sleep(20); }
}
const show = (label: string, v: unknown) => console.log(`--- ${label}\n${JSON.stringify(v, null, 1).replace(/\n\s*/g, ' ').slice(0, 1400)}`);

async function botGame(ada: Host) {
  // vectors 5 + 17: a proposed name is used as given; without one the server names it
  const first = await ada.open({ level: 'easy' }, 'first');
  show('toolsets/open go (bot game)', first);
  assert.equal(first.instance, 'first');
  assert.match(textOf(first), /Your move\./);
  assert.deepEqual(ada.visible('first'), ['go_pass', 'go_play', 'go_resign', 'go_undo']);
  assert.deepEqual(hintsOf(first)!.toolsets, [{ toolset: 'go', instance: 'first', state: 'open', title: 'Go 9×9 — you are Black, vs bot (easy)' }]);
  const second = await ada.open({ level: 'easy' });
  assert.equal(second.instance, 'go-1');
  assert.equal((await ada.call('toolsets/open', { toolset: 'go', instance: 'no spaces' })).error?.code, -32602, 'an invalid name is refused, never replaced');
  // RFC-014 r5 §5.2: names match ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ — every such name is taken as given, every other refused
  for (const bad of ['', '-x', '.x', '_x', 'x/y', 'é', 'x'.repeat(65)]) {
    assert.equal((await ada.call('toolsets/open', { toolset: 'go', instance: bad, options: { level: 'easy' } })).error?.code, -32602, `"${bad}" is refused`);
  }
  for (const good of ['A', '7', 'a.b_c-9', 'x'.repeat(64)]) {
    const r = (await ada.call('toolsets/open', { toolset: 'go', instance: good, options: { level: 'easy' } })).result;
    assert.equal(r.instance, good, `"${good}" is used as given`);
    await ada.call('toolsets/close', { toolset: 'go', instance: good });
  }
  // RFC-014 r4 §5.3: toolsets/list is a full statement — every tool visible in each open instance
  // (anything not stated visible is invisible), each entry naming its instance
  const full = (await ada.call('toolsets/list')).result;
  assert.deepEqual(full.open.map((o: Msg) => o.instance), ['first', 'go-1']);
  const stated = (inst: string) => hintsOf(full)!.tools.filter((t: Msg) => t.instance === inst && t.visible).map((t: Msg) => t.name).sort();
  assert.deepEqual(stated('first'), ['go_pass', 'go_play', 'go_resign', 'go_undo']);
  assert.deepEqual(stated('go-1'), ['go_pass', 'go_play', 'go_resign', 'go_undo']);
  assert.ok(hintsOf(full)!.tools.every((t: Msg) => t.instance === 'first' || t.instance === 'go-1'));
  assert.deepEqual(hintsOf(full)!.toolsets.map((t: Msg) => `${t.instance}:${t.state}`).sort(), ['first:open', 'go-1:open']);
  // vector 6: two open and no mcpl/instance
  const ambiguous = await ada.tool('go_play', { point: 'E5' });
  assert.ok(ambiguous.isError && /first, go-1/.test(textOf(ambiguous)));
  // vector 18: re-opening an open instance adopts it and says the options were not applied
  const again = await ada.open({ size: 19 }, 'first');
  assert.equal(again.adopted, true); assert.match(textOf(again), /not applied/);
  // vector 16: a close result carries its hint changes
  const closed = (await ada.call('toolsets/close', { toolset: 'go', instance: 'go-1' })).result;
  assert.deepEqual(hintsOf(closed)!.toolsets, [{ toolset: 'go', instance: 'go-1', state: 'closed' }]);
  assert.equal(ada.vis.has('go-1'), false);

  // vector 2: the bot's reply happens inside the call; nothing is pushed for it
  const mark = ada.wire.length;
  const t0 = Date.now();
  let r = await ada.tool('go_play', { point: 'E5' }, 'first');
  console.log(`--- go_play E5 vs the bot (${Date.now() - t0} ms)\n${textOf(r).split('\n').slice(0, 2).join('\n')}`);
  assert.match(textOf(r), /You played E5\.\n.*\(bot\) (plays|passes)/);
  await sleep(150);
  assert.deepEqual(ada.pushes(mark), [], 'no push for a call\'s own consequences');
  r = await ada.tool('go_play', { point: 'E5' }, 'first');
  assert.ok(r.isError && /illegal: occupied/.test(textOf(r)));

  // two passes: scoring; then accept: over
  for (let i = 0; i < 8 && !ada.visible('first').includes('go_accept'); i++) r = await ada.tool('go_pass', {}, 'first');
  assert.deepEqual(ada.visible('first'), ['go_accept', 'go_mark_dead', 'go_resume'], 'scoring');
  show('the pass that started scoring: result _meta', r._meta);
  assert.match(textOf(r), /scoring/);
  r = await ada.tool('go_accept', {}, 'first');
  assert.match(textOf(r), /Both accepted\..*Result: [BW]\+/s);
  assert.deepEqual(ada.visible('first'), ['go_rematch', 'go_sgf'], 'over');
  r = await ada.tool('go_play', { point: 'A1' }, 'first');
  assert.ok(r.isError && /not available right now in first: the game is over/.test(textOf(r)));
  r = await ada.tool('go_sgf', {}, 'first');
  assert.match(textOf(r), /^\(;GM\[1\]FF\[4\].*SZ\[9\].*;B\[ee\]/);
  // rematch against the bot: colours swap, so the bot opens inside the call
  r = await ada.tool('go_rematch', {}, 'first');
  assert.match(textOf(r), /New game: you are White\.\n.*\(bot\) plays/);
  assert.equal(hintsOf(r)!.toolsets?.[0]?.title, 'Go 9×9 — you are White, vs bot (easy)', 'retitled');
  assert.deepEqual(ada.visible('first'), ['go_pass', 'go_play', 'go_resign', 'go_undo']);
  r = await ada.tool('go_play', { point: 'C3' }, 'first');
  r = await ada.tool('go_undo', {}, 'first');
  assert.match(textOf(r), /Took back 2 moves/);
}

async function twoAgents(ada: Host, bo: Host) {
  const a = await ada.open({ opponent: 'agent' }, 'g');
  const code = /join: "([0-9A-F]{6})"/.exec(textOf(a))![1];
  assert.deepEqual(ada.visible('g'), ['go_cancel']);
  assert.match(textOf(await bo.tool('game_list')), new RegExp(`${code} \\(9×9, komi 7.5: [^)]* as Black\\)`), 'game_list shows the waiting game');
  let am = ada.wire.length;
  const b = await bo.open({ join: code }, 'g');
  assert.equal(b.title, 'Go 9×9 — you are White, vs Hints Ada');
  assert.deepEqual(bo.visible('g'), ['go_resign'], 'his open result: not his move');
  const joined = await waitFor('the join on ada', () => ada.pushes(am).find((p) => p.hints));
  show('push to the creator when an opponent joins', joined);
  assert.equal(joined.toolset, 'go'); assert.equal(joined.instance, 'g');
  assert.ok(joined.tags.includes('surface:turn')); assert.equal(joined.coalesce, undefined, 'vector 19');
  assert.deepEqual(ada.visible('g'), ['go_pass', 'go_play', 'go_resign'], 'the join event carried her change');

  let bm = bo.wire.length; am = ada.wire.length;
  let r = await ada.tool('go_play', { point: 'D4' }, 'g');
  show('her move: result _meta', r._meta);
  assert.deepEqual(ada.visible('g'), ['go_resign'], 'her own move: in the result');
  const moved = await waitFor('the move on bo', () => bo.pushes(bm).find((p) => p.hints));
  show('push to the other player', { tags: moved.tags, instance: moved.instance, hints: moved.hints, text: moved.payload.content[0].text.split('\n')[0] });
  assert.match(moved.payload.content[0].text, /Black played D4\. Your move\./);
  assert.deepEqual(bo.visible('g'), ['go_pass', 'go_play', 'go_resign'], 'his turn: on the push');
  await sleep(100);
  assert.deepEqual(ada.pushes(am), [], 'the mover hears nothing pushed');
  bo.close(); await sleep(150); // he goes away; main() brings him back
}

async function main() {
  let server = await startServer();
  try {
    const adaTok = await token('Hints Ada');
    const boTok = await token('Hints Bo');
    const ada = new Host('ada', adaTok); await ada.connect();
    const init = await ada.init();
    const decl = init.capabilities.experimental.mcpl.toolsets.go;
    show('go toolset declaration', decl);
    assert.equal(decl.instances, true); assert.equal(decl.default, 'closed');
    // vector 1: every tool listed, the go tools with their toolset, none visible yet
    const tools = (await ada.call('tools/list')).result.tools as Msg[];
    const goTools = tools.filter((t) => t._meta?.['mcpl/toolset'] === 'go');
    assert.deepEqual(goTools.map((t) => t.name), ['go_play', 'go_pass', 'go_resign', 'go_undo', 'go_cancel', 'go_mark_dead', 'go_accept', 'go_resume', 'go_rematch', 'go_sgf']);
    assert.ok(goTools.every((t) => t._meta['mcpl/visible'] === false));
    assert.equal(tools.length, 21);

    console.log('\n=== bot game');
    await botGame(ada);

    console.log('\n=== two identities');
    let bo = new Host('bo', boTok); await bo.connect(); await bo.init();
    await twoAgents(ada, bo);
    // Bo comes back: toolsets/list is his truth. Then he goes away again, Ada moves, and her move
    // waits for him as a held event, delivered after his next toolsets/list.
    bo = new Host('bo', boTok); await bo.connect(); await bo.init();
    const list = (await bo.call('toolsets/list')).result;
    assert.deepEqual(list.open.map((o: Msg) => o.instance), ['g']);
    assert.deepEqual(bo.visible('g'), ['go_pass', 'go_play', 'go_resign'], 'his turn, from the list');
    let r = await bo.tool('go_play', { point: 'F6' }, 'g');
    await waitFor('his move on ada', () => ada.visible('g').includes('go_play'));
    bo.close(); await sleep(150);
    r = await ada.tool('go_pass', {}, 'g');
    assert.deepEqual(ada.visible('g'), ['go_resign']);
    bo = new Host('bo', boTok); await bo.connect(); await bo.init();
    const bm0 = bo.wire.length;
    await bo.call('toolsets/list');
    const held = await waitFor('the held event after his list', () => bo.pushes(bm0).find((p) => /Black passed/.test(p.payload.content[0].text)));
    assert.equal(held.hints, undefined, 'a held event carries no hints: the list gave the state');
    assert.deepEqual(bo.visible('g'), ['go_pass', 'go_play', 'go_resign']);
    // two passes: scoring on both sides
    let am = ada.wire.length;
    r = await bo.tool('go_pass', {}, 'g');
    assert.match(textOf(r), /two passes/);
    assert.deepEqual(bo.visible('g'), ['go_accept', 'go_mark_dead', 'go_resume']);
    await waitFor('scoring on ada', () => ada.visible('g').includes('go_accept'));
    assert.ok(ada.pushes(am).some((p) => p.tags.includes('surface:turn') && /scoring/.test(p.payload.content[0].text)));
    r = await ada.tool('go_accept', {}, 'g');
    assert.deepEqual(ada.visible('g'), ['go_mark_dead', 'go_resume'], 'no accept once you accepted');
    let bm = bo.wire.length;
    r = await bo.tool('go_accept', {}, 'g');
    assert.match(textOf(r), /Both accepted/);
    await waitFor('over on ada', () => ada.visible('g').includes('go_sgf'));
    assert.deepEqual(bo.visible('g'), ['go_rematch', 'go_sgf']);
    // a rematch: offered by Ada, taken by Bo; colours swap
    am = ada.wire.length; bm = bo.wire.length;
    r = await ada.tool('go_rematch', {}, 'g');
    assert.match(textOf(r), /Rematch offered/);
    assert.deepEqual(ada.visible('g'), ['go_cancel']);
    const invite = await waitFor('the offer on bo', () => bo.pushes(bm).find((p) => p.tags.includes('surface:invite')));
    assert.match(invite.payload.content[0].text, /offers a rematch/);
    r = await bo.tool('go_rematch', {}, 'g');
    assert.match(textOf(r), /Rematch on: you are Black\. Your move\./);
    await waitFor('the rematch on ada', () => ada.pushes(am).find((p) => /accepted the rematch/.test(p.payload.content[0].text)));
    assert.deepEqual(ada.visible('g'), ['go_resign']);
    // RFC-014 r5 §6.2: an opponent whose connection cannot take pushes (no pushEvents grant) gets the
    // change as tools/hints
    const cy = new Host('cy', await token('Hints Cy'), true, false); await cy.connect(); await cy.init();
    const np = await ada.open({ opponent: 'agent' }, 'np');
    await cy.open({ join: /join: "([0-9A-F]{6})"/.exec(textOf(np))![1] }, 'np');
    const mc = cy.wire.length;
    await waitFor('the join on ada', () => ada.visible('np').includes('go_play'));
    await ada.tool('go_play', { point: 'C3' }, 'np');
    const standalone = await waitFor('tools/hints on cy', () => cy.wire.slice(mc).find((m) => m.method === 'tools/hints'));
    assert.equal(standalone.params.tools.find((t: Msg) => t.name === 'go_play').visible, true);
    assert.ok(!cy.wire.some((m) => m.method === 'push/event'), 'no pushes to a connection without the grant');
    await ada.tool('go_resign', {}, 'np');
    await ada.call('toolsets/close', { toolset: 'go', instance: 'np' });
    cy.close();

    // a forfeit: Bo leaves a live game
    am = ada.wire.length;
    const left = (await bo.call('toolsets/close', { toolset: 'go', instance: 'g' })).result;
    assert.match(textOf(left), /forfeit/);
    assert.equal(hintsOf(left)!.toolsets[0].state, 'closed');
    const done = await waitFor('the forfeit on ada', () => ada.pushes(am).find((p) => p.tags.includes('surface:done')));
    assert.match(done.payload.content[0].text, /wins by forfeit/);
    assert.deepEqual(ada.visible('g'), ['go_rematch', 'go_sgf']);
    // and with him gone, her rematch offer reaches his identity as a suggestion to open
    bm = bo.wire.length;
    await ada.tool('go_rematch', {}, 'g');
    const sug = await waitFor('the suggestion on bo', () => bo.wire.slice(bm).find((m) => m.method === 'tools/hints' && m.params.suggest));
    assert.match(sug.params.suggest[0].reason, /join: "[0-9A-F]{6}"/);
    await ada.call('toolsets/close', { toolset: 'go', instance: 'g' });

    console.log('\n=== reconnect and restart');
    const before = textOf(await ada.tool('go_play', { point: 'G7' }, 'first'));
    const moves = Number(/move (\d+)/.exec(before)![1]);
    ada.close(); bo.close();
    await stopServer(server);
    server = await startServer();
    const ada2 = new Host('ada2', adaTok); await ada2.connect(); await ada2.init();
    const l2 = (await ada2.call('toolsets/list')).result;
    show('toolsets/list after a server restart', { open: l2.open, toolsets: hintsOf(l2)!.toolsets });
    assert.deepEqual(l2.open, [{ toolset: 'go', instance: 'first', title: 'Go 9×9 — you are White, vs bot (easy)' }]);
    assert.deepEqual(ada2.visible('first'), ['go_pass', 'go_play', 'go_resign', 'go_undo']);
    const again = await ada2.open({}, 'first');
    assert.equal(again.adopted, true); assert.match(textOf(again), new RegExp(`move ${moves}`));
    r = await ada2.tool('go_play', { point: 'B8' }, 'first');
    assert.match(textOf(r), /You played B8/);

    // RFC-014 r5 §5.3: an instance that ends other than by toolsets/close (go_cancel) is recorded even
    // though the connection that caused it was online (its result reported it), and a later
    // connection finds the record by id on every list
    const w = await ada2.open({ opponent: 'agent' }, 'w');
    const wcode = /join: "([0-9A-F]{6})"/.exec(textOf(w))![1];
    r = await ada2.tool('go_cancel', {}, 'w');
    assert.deepEqual(hintsOf(r)!.toolsets, [{ toolset: 'go', instance: 'w', state: 'closed' }], 'the call\'s result reports the end');
    const ada3 = new Host('ada3', adaTok); await ada3.connect(); await ada3.init();
    const l3 = (await ada3.call('toolsets/list')).result;
    show('toolsets/list on a later connection after a go_cancel', l3.ended);
    const rec = { id: `go-${wcode}-w`, toolset: 'go', instance: 'w', reason: `withdrawn with go_cancel before anyone joined (${wcode})` };
    assert.deepEqual(l3.ended, [rec]);
    // r6 §5.3: with nothing open, toolsets/list is still a statement under its own rev
    const dee = new Host('dee', await token('Hints Dee')); await dee.connect(); await dee.init();
    assert.deepEqual((await dee.call('toolsets/list')).result, { open: [], _meta: { 'mcpl/hints': { rev: 1, tools: [] } } });
    dee.close();
    assert.deepEqual((await ada3.call('toolsets/list')).result.ended, [rec], 'every list, the same id');
    assert.deepEqual((await ada2.call('toolsets/list')).result.ended, [rec], 'and on the connection that caused it');
    ada3.close();

    // a host without toolHints never sees Go
    const plain = new Host('plain', adaTok, false); await plain.connect(); await plain.init();
    const pTools = (await plain.call('tools/list')).result.tools as Msg[];
    assert.equal(pTools.length, 9); assert.ok(!pTools.some((t) => t.name.startsWith('go_')));
    assert.equal((await plain.call('toolsets/open', { toolset: 'go' })).error?.code, -32601);
    r = await plain.tool('go_play', { point: 'A1' });
    assert.ok(r.isError && /Unknown tool/.test(textOf(r)));
    assert.match(textOf(await plain.tool('game_list')), /^(?![\s\S]*Go \(the go toolset\))/);
    await ada2.call('toolsets/close', { toolset: 'go', instance: 'first' });
    ada2.close(); plain.close();
  } finally { await stopServer(server); }
  console.log('\nGO OK');
}

main().catch((e) => { console.error('GO FAILED', e); process.exit(1); });
