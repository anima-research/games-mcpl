// Go from the web page: a person's web seat beside agents' instances (src/go/toolset.ts, "the web
// page"). The seat runs the toolset's own tools, so an agent across the board hears of a person's
// moves exactly as it hears of another agent's; the page hears of every change through 'match'.
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotPool } from '../src/go/bots.js';
import { GoTables, WEB_SEATS_MAX, type GoChange } from '../src/go/toolset.js';
import type { Principal } from '../src/games.js';

const who = (name: string, kind: Principal['kind']): Principal => ({ sub: `dev.local:${name.toLowerCase()}`, name, kind, issuer: 'dev.local', admin: false });
const verso = who('Verso', 'agent');
const antra = who('Antra', 'human');
const other = who('Other', 'human');

function tables(dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'go-web-'))) {
  const pool = new BotPool(1, () => undefined);
  const go = new GoTables(dir, pool, () => undefined, 'https://games.test');
  const changes: GoChange[] = [];
  const matches: string[] = [];
  go.on('change', (c: GoChange) => changes.push(c));
  go.on('match', (code: string) => matches.push(code));
  return { go, pool, dir, changes, matches };
}

test('a person joins an agent\'s game on the web; moves and scoring reach the agent as events', async () => {
  const t = tables();
  try {
    const open = await t.go.open(verso, 'g', { opponent: 'agent' });
    const code = open.ref.match.code;
    assert.match(open.text, new RegExp(`a person joins at https://games\\.test/go/${code}`));
    const list = t.go.webList(antra.sub);
    assert.equal(list.waiting[0]?.code, code);
    assert.equal(list.waiting[0]?.joinable, true);
    assert.equal(t.go.webList(verso.sub).waiting[0]?.joinable, false, 'the creator cannot join their own game');

    t.changes.length = 0;
    const m = await t.go.webJoin(antra, code);
    const joined = t.changes.flatMap((c) => c.events).find((e) => e.sub === verso.sub);
    assert.ok(joined, 'the agent hears that someone joined');
    assert.equal(joined.instance, 'g');
    assert.match(joined.text, /^Antra \(on the web\) joined as White\. Your move\./);
    assert.deepEqual(joined.tags, ['surface:turn', 'go:start']);
    assert.equal(t.go.title(t.go.find(verso.sub, 'g')!), 'Go 9×9 — you are Black, vs Antra (on the web)');

    let s = t.go.webState(m, antra.sub);
    assert.equal(s.you, 'white');
    assert.deepEqual(s.actions, ['go_resign'], 'black moves first');
    assert.equal(t.go.webState(m, other.sub).you, null, 'a watcher has no seat');
    assert.deepEqual(t.go.webState(m, other.sub).actions, []);

    // The agent plays through its instance; the page sees it through 'match'.
    t.matches.length = 0;
    const r1 = await t.go.call(verso, t.go.find(verso.sub, 'g')!, 'go_play', { point: 'D4' });
    assert.ok(!r1.isError, r1.text);
    assert.ok(t.matches.includes(code));
    s = t.go.webState(m, antra.sub);
    assert.deepEqual(s.actions, ['go_play', 'go_pass', 'go_resign']);
    assert.equal(s.moves.at(-1)?.point, 'D4');

    // The person plays on the web; the agent hears of it with the board.
    t.changes.length = 0;
    const r2 = await t.go.webCall(antra, code, 'go_play', { point: 'E5' });
    assert.ok(!r2.isError, r2.text);
    const moved = t.changes.flatMap((c) => c.events).find((e) => e.sub === verso.sub);
    assert.match(moved!.text, /^White played E5\. Your move\./);
    assert.match(moved!.text, /White \[Antra, on the web\]/);
    const again = await t.go.webCall(antra, code, 'go_play', { point: 'F6' });
    assert.ok(again.isError && /not available right now.*Black's move/.test(again.text), again.text);
    const stranger = await t.go.webCall(other, code, 'go_pass', {});
    assert.ok(stranger.isError && /not playing in this game/.test(stranger.text));

    // Two passes, then scoring accepted from both doors.
    await t.go.call(verso, t.go.find(verso.sub, 'g')!, 'go_pass', {});
    const p2 = await t.go.webCall(antra, code, 'go_pass', {});
    assert.match(p2.text, /scoring/);
    s = t.go.webState(m, antra.sub);
    assert.equal(s.phase, 'scoring');
    assert.ok(s.owner && s.score);
    assert.deepEqual(s.actions, ['go_mark_dead', 'go_accept', 'go_resume']);
    await t.go.webCall(antra, code, 'go_accept', {});
    assert.deepEqual(t.go.webState(m, antra.sub).actions, ['go_mark_dead', 'go_resume']);
    const fin = await t.go.call(verso, t.go.find(verso.sub, 'g')!, 'go_accept', {});
    assert.match(fin.text, /Both accepted/);
    s = t.go.webState(m, antra.sub);
    assert.equal(s.phase, 'over');
    assert.match(s.result!, /^[BW]\+/);
    assert.deepEqual(s.actions, ['go_rematch', 'go_sgf']);
    assert.match(m.sgf(), /PB\[Verso\]PW\[Antra\]/);

    // The agent closes its instance: the person's seat still holds the finished game, so its page works.
    await t.go.close(verso, 'g');
    assert.equal(t.go.lookup(code)?.live, true);
  } finally { t.pool.close(); }
});

test('the web seat survives a restart, mid-game', async () => {
  const t = tables();
  try {
    const m = await t.go.webCreate(antra, { opponent: 'agent', size: 13 });
    await t.go.open(verso, 'joined', { join: m.code });
    await t.go.webCall(antra, m.code, 'go_play', { point: 'K10' });
    t.pool.close();
    const t2 = tables(t.dir);
    try {
      const back = t2.go.lookup(m.code);
      assert.equal(back?.live, true);
      const s = t2.go.webState(back!.match, antra.sub);
      assert.equal(s.you, 'black');
      assert.equal(s.size, 13);
      assert.equal(s.moves.length, 1);
      assert.equal(t2.go.find(verso.sub, 'joined')?.color, 2, 'the agent\'s instance came back too');
      const r = await t2.go.call(verso, t2.go.find(verso.sub, 'joined')!, 'go_play', { point: 'C3' });
      assert.ok(!r.isError, r.text);
      assert.deepEqual(t2.go.webState(back!.match, antra.sub).actions, ['go_play', 'go_pass', 'go_resign']);
    } finally { t2.pool.close(); }
  } finally { t.pool.close(); }
});

test('a person against the bot: it replies in the call, undo, resign, rematch moves the seat', async () => {
  const t = tables();
  try {
    const m = await t.go.webCreate(antra, { opponent: 'bot', level: 'easy', color: 'white' });
    let s = t.go.webState(m, antra.sub);
    assert.equal(s.moves.length, 1, 'the bot moved first');
    assert.deepEqual(s.actions, ['go_play', 'go_pass', 'go_resign', 'go_undo']);
    assert.equal(s.seats.black?.kind, 'bot');
    const free = s.board.findIndex((c, p) => c === 0 && p !== s.moves[0]!.p);
    const n = s.size;
    const name = 'ABCDEFGHJ'[free % n] + String(n - Math.floor(free / n));
    const r = await t.go.webCall(antra, m.code, 'go_play', { point: name });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /\(bot\) (plays|passes)/);
    assert.equal(t.go.webState(m, antra.sub).moves.length, 3);
    await t.go.webCall(antra, m.code, 'go_undo', {});
    assert.equal(t.go.webState(m, antra.sub).moves.length, 1);
    await t.go.webCall(antra, m.code, 'go_resign', {});
    s = t.go.webState(m, antra.sub);
    assert.equal(s.result, 'B+R');
    const re = await t.go.webCall(antra, m.code, 'go_rematch', {});
    assert.ok(!re.isError, re.text);
    s = t.go.webState(m, antra.sub);
    assert.ok(s.rematch, 'the old game points at the new one');
    assert.equal(s.left, true);
    assert.deepEqual(s.actions, []);
    assert.equal(t.go.lookup(m.code)?.live, false, 'nobody holds the old game: retired, still readable');
    const next = t.go.lookup(s.rematch!)!;
    assert.equal(next.live, true);
    assert.equal(t.go.webState(next.match, antra.sub).you, 'black', 'colours swapped');
  } finally { t.pool.close(); }
});

test('guards: own game, withdrawn games, the per-person cap', async () => {
  const t = tables();
  try {
    const w = await t.go.webCreate(antra, { opponent: 'agent' });
    await assert.rejects(t.go.webJoin(antra, w.code), /already playing/);
    await assert.rejects(t.go.webCreate(antra, { join: 'ABCDEF' }), /join is not an option/);
    await assert.rejects(t.go.webCreate(antra, { size: 7 }), /size must be/);
    const c = await t.go.webCall(antra, w.code, 'go_cancel', {});
    assert.equal(c.text, 'Withdrawn: nobody had joined.');
    assert.equal(t.go.lookup(w.code), null, 'a withdrawn game is gone');
    assert.equal(t.go.lookup('../../x'), null);
    for (let i = 0; i < WEB_SEATS_MAX; i++) await t.go.webCreate(other, { opponent: 'agent' });
    await assert.rejects(t.go.webCreate(other, { opponent: 'agent' }), /unfinished games/);
    assert.equal(t.go.webList(antra.sub).waiting.filter((g) => g.joinable).length, WEB_SEATS_MAX);
  } finally { t.pool.close(); }
});
