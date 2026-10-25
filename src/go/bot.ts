/**
 * A small Monte Carlo Go player: flat UCB1 over root moves, light playouts with two tactical
 * heuristics (capture a group the last move left in atari; rescue your own). Weak on 19×19,
 * a reasonable sparring partner on 9×9. Also estimates ownership, which scoring uses to propose
 * dead stones.
 */
import { BLACK, EMPTY, WHITE, GoGame, other, isEyeish, neighbors, type Color } from './board.js';

export type Level = 'easy' | 'medium' | 'hard';
const BUDGET: Record<Level, { playouts: number; ms: number }> = {
  easy: { playouts: 400, ms: 400 },
  medium: { playouts: 6000, ms: 1500 },
  hard: { playouts: 40000, ms: 5000 },
};

/** Mutable board tuned for playouts: no allocation per move. */
class FastBoard {
  readonly n: number;
  readonly size: number;
  readonly b: Int8Array;
  readonly nb: number[][];
  private mark: Int32Array;
  private gen = 1;
  private stack: Int32Array;
  ko = -1;

  constructor(src: Int8Array, n: number) {
    this.n = n; this.size = n * n;
    this.b = Int8Array.from(src);
    this.nb = neighbors(n);
    this.mark = new Int32Array(this.size);
    this.stack = new Int32Array(this.size);
  }

  /** Liberty count of the group at p, stopping once `cap` liberties are found. */
  liberties(p: number, cap = 99, out?: number[]): number {
    const color = this.b[p];
    const g = ++this.gen;
    const libGen = ++this.gen;
    let sp = 0; let libs = 0;
    this.stack[sp++] = p; this.mark[p] = g;
    while (sp) {
      const q = this.stack[--sp]!;
      for (const r of this.nb[q]!) {
        const v = this.b[r];
        if (v === EMPTY) {
          if (this.mark[r] !== libGen) { this.mark[r] = libGen; libs++; out?.push(r); if (libs >= cap) return libs; }
        } else if (v === color && this.mark[r] !== g && this.mark[r] !== libGen) { this.mark[r] = g; this.stack[sp++] = r; }
      }
    }
    return libs;
  }

  private remove(p: number): number {
    const color = this.b[p];
    let sp = 0; let n = 0;
    this.stack[sp++] = p; this.b[p] = EMPTY;
    while (sp) {
      const q = this.stack[--sp]!;
      n++;
      for (const r of this.nb[q]!) if (this.b[r] === color) { this.b[r] = EMPTY; this.stack[sp++] = r; }
    }
    return n;
  }

  /** Play if legal (no suicide, simple ko). Returns false and leaves the board unchanged otherwise. */
  play(p: number, c: Color): boolean {
    if (this.b[p] !== EMPTY || p === this.ko) return false;
    const opp = other(c);
    this.b[p] = c;
    let captured = 0; let capturedAt = -1;
    for (const q of this.nb[p]!) {
      if (this.b[q] === opp && this.liberties(q, 1) === 0) { const k = this.remove(q); captured += k; if (k === 1) capturedAt = q; }
    }
    if (captured === 0 && this.liberties(p, 1) === 0) { this.b[p] = EMPTY; return false; }
    this.ko = captured === 1 && this.liberties(p, 2) === 1 ? capturedAt : -1;
    return true;
  }

  /** Area count at the end of a playout: stones plus empty points touching one color only. */
  score(owner?: Int32Array): number {
    let s = 0;
    for (let p = 0; p < this.size; p++) {
      let v = this.b[p]!;
      if (v === EMPTY) {
        let seen = 0;
        for (const q of this.nb[p]!) seen |= this.b[q]!;
        v = seen === BLACK ? BLACK : seen === WHITE ? WHITE : EMPTY;
      }
      if (v === BLACK) { s++; if (owner) owner[p]!++; } else if (v === WHITE) { s--; if (owner) owner[p]!--; }
    }
    return s;
  }
}

/** Run one playout from `fb` (mutated) with `c` to move. Returns the black-minus-white area. */
function playout(fb: FastBoard, c: Color, lastMove: number, rng: () => number, owner?: Int32Array): number {
  const limit = fb.size * 3;
  let passes = 0;
  const empties: number[] = [];
  const libs: number[] = [];
  for (let i = 0; i < limit && passes < 2; i++) {
    let moved = -1;
    // Heuristics around the last move.
    if (lastMove >= 0 && rng() < 0.9) {
      for (const q of fb.nb[lastMove]!) {
        const v = fb.b[q];
        if (v === EMPTY) continue;
        libs.length = 0;
        if (fb.liberties(q, 2, libs) !== 1) continue;
        const at = libs[0]!;
        if (v !== c) {
          // Their group is in atari: capture it.
          if (fb.play(at, c)) { moved = at; break; }
        } else {
          // Ours is in atari: extend, if the extension point has room to breathe.
          let room = 0;
          for (const r of fb.nb[at]!) if (fb.b[r] === EMPTY) room++;
          if (room >= 2 && fb.play(at, c)) { moved = at; break; }
        }
      }
    }
    if (moved < 0) {
      empties.length = 0;
      for (let p = 0; p < fb.size; p++) if (fb.b[p] === EMPTY && !isEyeish(fb.b, fb.n, p, c)) empties.push(p);
      while (empties.length) {
        const k = Math.floor(rng() * empties.length);
        const p = empties[k]!;
        if (fb.play(p, c)) { moved = p; break; }
        empties[k] = empties[empties.length - 1]!; empties.pop();
      }
    }
    if (moved < 0) { passes++; lastMove = -1; fb.ko = -1; } else { passes = 0; lastMove = moved; }
    c = other(c);
  }
  return fb.score(owner);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BotMove {
  /** null = pass */
  point: number | null;
  resign: boolean;
  winrate: number;
  playouts: number;
}

/** Choose a move for the side to move in `game`. */
export function chooseMove(game: GoGame, level: Level, seed = Date.now()): BotMove {
  const rng = mulberry32(seed);
  const c = game.toMove;
  const n = game.n;
  const legal = game.legalMoves(c).filter((p) => !isEyeish(game.board, n, p, c));
  const cands: Array<number | null> = [...legal, null];
  const wins = new Float64Array(cands.length);
  const visits = new Float64Array(cands.length);
  const budget = BUDGET[level];
  const deadline = Date.now() + budget.ms * (n === 19 ? 2 : 1);
  const last = game.lastMove?.point ?? -1;
  let total = 0;
  const sign = c === BLACK ? 1 : -1;
  const komi = game.komi;

  while (total < budget.playouts && (total % 64 !== 0 || Date.now() < deadline)) {
    // UCB1 at the root; unvisited first.
    let best = 0; let bestVal = -Infinity;
    for (let i = 0; i < cands.length; i++) {
      const v = visits[i]! === 0 ? 1e9 + rng() : wins[i]! / visits[i]! + Math.sqrt((2 * Math.log(total + 1)) / visits[i]!);
      if (v > bestVal) { bestVal = v; best = i; }
    }
    const fb = new FastBoard(game.board, n);
    const mv = cands[best]!;
    let lm = last;
    if (mv !== null) { fb.play(mv, c); lm = mv; } else lm = -1;
    const area = playout(fb, other(c), lm, rng);
    const result = (area - komi) * sign > 0 ? 1 : 0;
    wins[best]! += result; visits[best]! += 1;
    total++;
  }

  let pick = cands.length - 1; let most = -1;
  for (let i = 0; i < cands.length; i++) if (visits[i]! > most) { most = visits[i]!; pick = i; }
  const rate = (i: number) => (visits[i]! ? wins[i]! / visits[i]! : 0);
  const passIdx = cands.length - 1;
  let point: number | null = cands[pick] ?? null;
  // Prefer passing when it is as good as playing on: settled positions end instead of filling.
  if (point !== null && visits[passIdx]! > 20 && rate(passIdx) >= rate(pick) - 0.02 && rate(pick) > 0.5) point = null;
  // If the opponent passed and we are ahead with the stones as they stand, pass to end the game.
  if (point !== null && game.lastMove?.point === null) {
    const est = estimate(game, 200, seed);
    if ((est.margin > 0) === (c === BLACK) && Math.abs(est.margin) > 0.5) point = null;
  }
  const winrate = rate(point === null ? passIdx : pick);
  const resign = total >= 300 && winrate < 0.04 && game.moves.length > (n * n) / 3;
  return { point, resign, winrate, playouts: total };
}

/** Ownership by playouts: +1 = black, -1 = white. Also a margin estimate (black minus white+komi). */
export function estimate(game: GoGame, playouts = 300, seed = 1): { ownership: Float64Array; margin: number } {
  const rng = mulberry32(seed);
  const size = game.n * game.n;
  const owner = new Int32Array(size);
  let sum = 0;
  for (let i = 0; i < playouts; i++) {
    const fb = new FastBoard(game.board, game.n);
    sum += playout(fb, game.toMove, game.lastMove?.point ?? -1, rng, owner);
  }
  const ownership = new Float64Array(size);
  for (let p = 0; p < size; p++) ownership[p] = owner[p]! / playouts;
  return { ownership, margin: sum / playouts - game.komi };
}

/** Stones whose point the playouts mostly give to the other side. */
export function guessDead(game: GoGame, playouts = 400): Set<number> {
  const { ownership } = estimate(game, playouts, 7);
  const dead = new Set<number>();
  for (let p = 0; p < game.n * game.n; p++) {
    const v = game.board[p];
    if (v === BLACK && ownership[p]! < -0.6) dead.add(p);
    if (v === WHITE && ownership[p]! > 0.6) dead.add(p);
  }
  return dead;
}
