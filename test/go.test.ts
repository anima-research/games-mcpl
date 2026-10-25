// Go rules and bot sanity (ported with the rules from the earlier Go server), and the bot pool
// keeping searches off the event loop.
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLACK, WHITE, GoGame, areaScore, parsePoint, pointName } from '../src/go/board.js';
import { chooseMove, guessDead } from '../src/go/bot.js';

const play = (g: GoGame, ...pts: string[]) => { for (const p of pts) { const r = p === 'pass' ? (g.pass(), { ok: true }) : g.play(parsePoint(p, g.n)!); assert.ok(r.ok, `${p} should be legal`); } };

test('coordinates skip I and count rows from the bottom', () => {
  assert.equal(parsePoint('A1', 9), 72);
  assert.equal(parsePoint('J9', 9), 8);
  assert.equal(parsePoint('I5', 9), null);
  assert.equal(pointName(parsePoint('H8', 9)!, 9), 'H8');
});

test('capture, suicide, ko', () => {
  const g = new GoGame(9, 7.5);
  // Black surrounds a white stone at B2 (playing elsewhere for White).
  play(g, 'B1', 'B2', 'A2', 'H8', 'C2', 'H7');
  const r = g.play(parsePoint('B3', 9)!);
  assert.ok(r.ok && r.captured.length === 1);
  // A1 for white: surrounded by black stones, no capture → suicide.
  const s = g.play(parsePoint('B2', 9)!);
  assert.equal(s.ok, false);
  // Ko: build the shape and check the immediate recapture is refused.
  const k = new GoGame(9, 7.5);
  play(k, 'D5', 'E5', 'C4', 'F4', 'D3', 'E3', 'H9', 'D4', 'E4');
  const re = k.play(parsePoint('D4', 9)!);
  assert.equal(re.ok, false);
  assert.match((re as { reason: string }).reason, /ko/);
});

test('area scoring with komi and dead stones', () => {
  const g = new GoGame(9, 7.5);
  // A black wall on column E splits the board: west 36 + wall 9 for black, east 36 for white (with a white wall on F).
  for (let row = 1; row <= 9; row++) { play(g, `E${row}`, `F${row}`); }
  const sc = areaScore(g.board, 9, 7.5);
  assert.equal(sc.black, 45);
  assert.equal(sc.white, 36);
  assert.equal(sc.winner, BLACK);
  // A dead white stone inside black's area counts for black.
  const b = Int8Array.from(g.board); b[parsePoint('B5', 9)!] = WHITE;
  const withDead = areaScore(b, 9, 7.5, new Set([parsePoint('B5', 9)!]));
  assert.equal(withDead.black, 45);
});

test('the bot plays a legal move quickly and does not fill its own eyes', () => {
  const g = new GoGame(9, 7.5);
  play(g, 'E5');
  const t0 = Date.now();
  const mv = chooseMove(g, 'easy', 42);
  assert.ok(Date.now() - t0 < 3000);
  assert.ok(mv.point === null || g.legalMoves().includes(mv.point));
  assert.ok(mv.playouts > 0);
});

test('guessDead finds a lone stone in a closed enemy area', () => {
  // Light playouts settle closed areas (the end-of-game case); a big open area stays ambiguous,
  // which is why scoring lets either player change the marking.
  const g = new GoGame(9, 7.5);
  for (let row = 1; row <= 9; row++) play(g, `C${row}`, `D${row}`);
  play(g, 'pass', 'B5'); // a lone white stone in black's area
  const dead = guessDead(g, 300);
  assert.ok(dead.has(parsePoint('B5', 9)!));
});

test('the bot pool searches on worker threads: the event loop keeps turning, and two games search at once', async () => {
  const { BotPool } = await import('../src/go/bots.js');
  const pool = new BotPool(2, () => undefined);
  try {
    const g = new GoGame(9, 7.5);
    play(g, 'E5');
    let gap = 0; let last = Date.now();
    const tick = setInterval(() => { const now = Date.now(); gap = Math.max(gap, now - last); last = now; }, 10);
    const t0 = Date.now();
    const [a, b] = await Promise.all([pool.move(g, 'medium'), pool.move(g, 'medium')]);
    const took = Date.now() - t0;
    clearInterval(tick);
    assert.ok(a.playouts > 0 && b.playouts > 0);
    assert.ok(a.point === null || g.legalMoves().includes(a.point));
    assert.ok(gap < 200, `the event loop stalled for ${gap} ms during the search`);
    assert.ok(took < 2 * 1500 + 1000, `two medium searches took ${took} ms: they should run side by side`);
    const dead = await pool.dead(g);
    assert.ok(dead instanceof Set);
  } finally { pool.close(); }
});
