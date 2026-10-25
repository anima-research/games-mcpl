// The pure side of MCPL RFC-014 in src/hints.ts: the visibility table, the refusal texts, and
// the diff that turns "what the host was told" into hint changes.
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GAME_TOOLS, closedTold, current, diff, diffUnits, hinted, unavailable, unitKey, visibleFor, type GameView, type Tool, type Units } from '../src/hints.js';

const view = (status: GameView['status'], extra: Partial<GameView> = {}): GameView =>
  ({ id: 'g1', status, parked: false, next: null, title: 'freedoom1 E1M1, skill 3', map: 'E1M1', ...extra });
const define = (name: string): Tool => ({ name, description: `${name} (now)`, inputSchema: { type: 'object' } });
const byName = (tools: Array<{ name: string; visible?: boolean; definition?: Tool }> = []) => Object.fromEntries(tools.map((t) => [t.name, t]));

test('visibility follows the game state', () => {
  assert.deepEqual([...visibleFor('running', null)].sort(), ['game_act', 'game_look', 'game_say', 'game_state', 'game_stop', 'game_watchers']);
  const dead = visibleFor('dead', null);
  assert.ok(dead.has('game_restart') && dead.has('game_start') && !dead.has('game_act') && !dead.has('game_next'));
  assert.ok(visibleFor('complete', 'E1M2').has('game_next'));
  assert.ok(!visibleFor('complete', null).has('game_next'), 'no next tool after the last map');
  assert.equal(visibleFor('stopped', null).size, 0);
});

test('calls to invisible tools are refused with a reason; visible ones are not', () => {
  assert.match(unavailable('game_act', null)!, /not open: you have no game/);
  assert.match(unavailable('game_act', view('running', { parked: true }))!, /kept on the server/);
  assert.match(unavailable('game_act', view('dead'))!, /you died on E1M1.*Available: .*game_restart/);
  assert.match(unavailable('game_next', view('complete'))!, /E1M1 was the last map/);
  assert.match(unavailable('game_start', view('running'))!, /game_stop ends this game/);
  assert.equal(unavailable('game_act', view('running')), null);
  assert.equal(unavailable('game_next', view('complete', { next: 'E1M2' })), null);
});

test('an open reports every toolset tool and the toolset; nothing then changes', () => {
  const r = diff(closedTold(), current(view('running')), define, { full: true, mayOpen: true });
  const t = byName(r.changes!.tools);
  assert.equal(Object.keys(t).length, GAME_TOOLS.length, 'full: visible and invisible alike');
  assert.equal(t.game_act.visible, true);
  assert.equal(t.game_restart.visible, false);
  assert.deepEqual(r.changes!.toolsets, [{ toolset: 'game', state: 'open', title: 'freedoom1 E1M1, skill 3' }]);
  assert.equal(diff(r.told, current(view('running')), define, { mayOpen: true }).changes, null);
});

test('death: only what changed, no toolset entry', () => {
  const told = diff(closedTold(), current(view('running')), define, { full: true, mayOpen: true }).told;
  const r = diff(told, current(view('dead')), define, { mayOpen: true });
  assert.deepEqual(byName(r.changes!.tools), {
    game_act: { name: 'game_act', visible: false },
    game_start: { name: 'game_start', visible: true },
    game_restart: { name: 'game_restart', visible: true },
  });
  assert.equal(r.changes!.toolsets, undefined);
});

test('game_next carries its definition when it appears, and again only if the map changes', () => {
  const told = diff(closedTold(), current(view('running')), define, { full: true, mayOpen: true }).told;
  const r = diff(told, current(view('complete', { next: 'E1M2' })), define, { mayOpen: true });
  assert.deepEqual(byName(r.changes!.tools).game_next, { name: 'game_next', visible: true, definition: define('game_next') });
  assert.equal(diff(r.told, current(view('complete', { next: 'E1M2' })), define, { mayOpen: true }).changes, null);
  const moved = diff(r.told, current(view('complete', { next: 'E1M3', map: 'E1M2', title: 'freedoom1 E1M2, skill 3' })), define, { mayOpen: true });
  assert.ok(byName(moved.changes!.tools).game_next.definition, 'a new map is a new definition');
  assert.deepEqual(moved.changes!.toolsets, [{ toolset: 'game', state: 'open', title: 'freedoom1 E1M2, skill 3' }], 'a new title rides as an open entry');
});

test('a close reports what was visible as invisible, and the toolset closed', () => {
  const told = diff(closedTold(), current(view('running')), define, { full: true, mayOpen: true }).told;
  const r = diff(told, current(null), define, { mayOpen: false });
  assert.ok(r.changes!.tools!.every((t) => t.visible === false));
  assert.deepEqual(r.changes!.tools!.map((t) => t.name).sort(), [...visibleFor('running', null)].sort());
  assert.deepEqual(r.changes!.toolsets, [{ toolset: 'game', state: 'closed' }]);
  assert.equal(r.told.open, false);
  assert.equal(diff(r.told, current(null), define, { mayOpen: false }).changes, null, 'closed stays quiet');
  // kept on close (parked): closed to the host although the game runs
  assert.equal(current(view('running', { parked: true })).open, false);
});

test('an open is reported only by an exchange that may report it (not a static tool\'s result)', () => {
  const r = diff(closedTold(), current(view('running')), define, { mayOpen: false });
  assert.equal(r.changes, null);
  assert.equal(r.told.open, false);
});

test('hinted(): static vs toolset tools', () => {
  assert.deepEqual(hinted(define('game_list'), true)._meta, { 'mcpl/presence': 'static' });
  assert.deepEqual(hinted(define('game_act'), false)._meta, { 'mcpl/presence': 'dynamic', 'mcpl/toolset': 'game', 'mcpl/visible': false });
});

test('units: entries of a toolset with instances carry the instance; closing one leaves the others alone', () => {
  const tools = ['go_play', 'go_resign'];
  const unit = (visible: string[], title = 'Go 9×9') => ({ open: true, title, visible: new Set(visible), defs: new Map<string, string>() });
  const a = unitKey('go', 'a'); const b = unitKey('go', 'b');
  const cur: Units = new Map([[a, unit(['go_play', 'go_resign'])], [b, unit(['go_resign'])]]);
  const opened = diffUnits(new Map(), cur, () => tools, () => define('x'), { full: new Set([a]), mayOpen: true });
  assert.ok(opened.changes!.tools!.every((t) => t.instance === 'a' || t.instance === 'b'));
  assert.deepEqual(opened.changes!.toolsets!.map((t) => t.instance).sort(), ['a', 'b']);
  // b's move: only b changes
  const moved = diffUnits(opened.told, new Map([[a, unit(['go_play', 'go_resign'])], [b, unit(['go_play', 'go_resign'])]]), () => tools, () => define('x'), { mayOpen: true });
  assert.deepEqual(moved.changes, { tools: [{ name: 'go_play', instance: 'b', visible: true }] });
  // a closes
  const closed = diffUnits(moved.told, new Map([[b, unit(['go_play', 'go_resign'])]]), () => tools, () => define('x'), { mayOpen: false });
  assert.deepEqual(closed.changes!.toolsets, [{ toolset: 'go', instance: 'a', state: 'closed' }]);
  assert.ok(closed.changes!.tools!.every((t) => t.instance === 'a' && t.visible === false));
  assert.deepEqual([...closed.told.keys()], [b]);
});
