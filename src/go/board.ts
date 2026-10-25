/**
 * Go rules: captures, suicide (illegal), positional superko, area scoring (Chinese) with komi.
 * Points are indices y*N+x with y=0 at the top; humans see column letters (A–T, no I) and row
 * numbers from the bottom, so "A1" is the bottom-left corner.
 */
export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;
export type Color = typeof BLACK | typeof WHITE;
export const other = (c: Color): Color => (c === BLACK ? WHITE : BLACK);
export const colorName = (c: Color): string => (c === BLACK ? 'Black' : 'White');

const LETTERS = 'ABCDEFGHJKLMNOPQRST';

export function parsePoint(s: string, n: number): number | null {
  const m = s.trim().toUpperCase().match(/^([A-HJ-T])(\d{1,2})$/);
  if (!m) return null;
  const x = LETTERS.indexOf(m[1]!);
  const row = Number(m[2]);
  if (x < 0 || x >= n || row < 1 || row > n) return null;
  return (n - row) * n + x;
}

export function pointName(p: number, n: number): string {
  const x = p % n;
  const y = Math.floor(p / n);
  return `${LETTERS[x]}${n - y}`;
}

/** Neighbor table per size, computed once. */
const NEIGHBORS = new Map<number, number[][]>();
export function neighbors(n: number): number[][] {
  let t = NEIGHBORS.get(n);
  if (!t) {
    t = [];
    for (let p = 0; p < n * n; p++) {
      const x = p % n; const y = Math.floor(p / n);
      const a: number[] = [];
      if (x > 0) a.push(p - 1);
      if (x < n - 1) a.push(p + 1);
      if (y > 0) a.push(p - n);
      if (y < n - 1) a.push(p + n);
      t.push(a);
    }
    NEIGHBORS.set(n, t);
  }
  return t;
}

export interface Group { stones: number[]; liberties: Set<number> }

export function groupAt(b: Int8Array, n: number, p: number): Group {
  const color = b[p];
  const nb = neighbors(n);
  const seen = new Uint8Array(n * n);
  const stones: number[] = [];
  const liberties = new Set<number>();
  const stack = [p];
  seen[p] = 1;
  while (stack.length) {
    const q = stack.pop()!;
    stones.push(q);
    for (const r of nb[q]!) {
      if (b[r] === EMPTY) liberties.add(r);
      else if (b[r] === color && !seen[r]) { seen[r] = 1; stack.push(r); }
    }
  }
  return { stones, liberties };
}

export type MoveResult = { ok: true; captured: number[] } | { ok: false; reason: string };

/**
 * Place a stone on `b` in place. Returns what it captured, or why it is illegal (and then `b` is
 * unchanged). Superko is the caller's job (it needs history); see Game.play.
 */
export function placeStone(b: Int8Array, n: number, p: number, c: Color): MoveResult {
  if (b[p] !== EMPTY) return { ok: false, reason: 'occupied' };
  const nb = neighbors(n);
  b[p] = c;
  const opp = other(c);
  const captured: number[] = [];
  for (const q of nb[p]!) {
    if (b[q] === opp) {
      const g = groupAt(b, n, q);
      if (g.liberties.size === 0) for (const s of g.stones) { b[s] = EMPTY; captured.push(s); }
    }
  }
  if (captured.length === 0 && groupAt(b, n, p).liberties.size === 0) {
    b[p] = EMPTY;
    return { ok: false, reason: 'suicide' };
  }
  return { ok: true, captured };
}

export interface Score { black: number; white: number; komi: number; margin: number; winner: Color; text: string }

/**
 * Area score: stones on the board plus empty regions bordered by one color only. `dead` stones
 * are removed first (they count as territory for the side that surrounds them).
 */
export function areaScore(board: Int8Array, n: number, komi: number, dead: Set<number> = new Set()): Score & { owner: Int8Array } {
  const b = Int8Array.from(board);
  for (const p of dead) b[p] = EMPTY;
  const nb = neighbors(n);
  const owner = new Int8Array(n * n);
  const seen = new Uint8Array(n * n);
  let black = 0; let white = 0;
  for (let p = 0; p < n * n; p++) {
    if (b[p] === BLACK) { black++; owner[p] = BLACK; continue; }
    if (b[p] === WHITE) { white++; owner[p] = WHITE; continue; }
    if (seen[p]) continue;
    const region: number[] = [];
    let borders = 0;
    const stack = [p]; seen[p] = 1;
    while (stack.length) {
      const q = stack.pop()!;
      region.push(q);
      for (const r of nb[q]!) {
        if (b[r] === EMPTY) { if (!seen[r]) { seen[r] = 1; stack.push(r); } }
        else borders |= b[r]!;
      }
    }
    if (borders === BLACK) { black += region.length; for (const q of region) owner[q] = BLACK; }
    else if (borders === WHITE) { white += region.length; for (const q of region) owner[q] = WHITE; }
  }
  const margin = black - (white + komi);
  const winner: Color = margin > 0 ? BLACK : WHITE;
  const text = `Black ${black}, White ${white} + ${komi} komi = ${white + komi}. ${colorName(winner)} wins by ${Math.abs(margin)}.`;
  return { black, white, komi, margin, winner, text, owner };
}

/** ASCII board. The last move is bracketed: `.(X).` */
export function renderBoard(b: Int8Array, n: number, opts: { last?: number; dead?: Set<number>; owner?: Int8Array } = {}): string {
  const cols = LETTERS.slice(0, n).split('');
  const head = '    ' + cols.join(' ');
  const lines = [head];
  const star = starPoints(n);
  for (let y = 0; y < n; y++) {
    const row = n - y;
    let line = `${String(row).padStart(2)} `;
    for (let x = 0; x < n; x++) {
      const p = y * n + x;
      let ch = b[p] === BLACK ? 'X' : b[p] === WHITE ? 'O' : star.has(p) ? '+' : '.';
      if (opts.dead?.has(p)) ch = b[p] === BLACK ? 'x' : 'o';
      else if (b[p] === EMPTY && opts.owner) ch = opts.owner[p] === BLACK ? '#' : opts.owner[p] === WHITE ? '_' : ch;
      const left = opts.last === p ? '(' : opts.last === p - 1 && x > 0 ? ')' : ' ';
      line += left + ch;
    }
    line += opts.last !== undefined && opts.last === y * n + n - 1 ? ')' : ' ';
    lines.push(`${line}${String(row).padStart(2)}`);
  }
  lines.push(head);
  return lines.join('\n');
}

function starPoints(n: number): Set<number> {
  const s = new Set<number>();
  const at = (x: number, y: number) => s.add(y * n + x);
  if (n === 9) { for (const x of [2, 6]) for (const y of [2, 6]) at(x, y); at(4, 4); }
  else if (n === 13) { for (const x of [3, 9]) for (const y of [3, 9]) at(x, y); at(6, 6); }
  else if (n === 19) { for (const x of [3, 9, 15]) for (const y of [3, 9, 15]) at(x, y); }
  return s;
}

/** True if `p` is an eye-like point for `c`: all neighbors are `c`, and enough diagonals too. */
export function isEyeish(b: Int8Array, n: number, p: number, c: Color): boolean {
  if (b[p] !== EMPTY) return false;
  for (const q of neighbors(n)[p]!) if (b[q] !== c) return false;
  const x = p % n; const y = Math.floor(p / n);
  let bad = 0; let edge = 0;
  for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const xx = x + dx; const yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= n || yy >= n) { edge++; continue; }
    if (b[yy * n + xx] === other(c)) bad++;
  }
  return edge > 0 ? bad === 0 : bad <= 1;
}

export interface MoveRecord { color: Color; point: number | null; captured: number }

/** A game with history, superko, and passes. */
export class GoGame {
  readonly n: number;
  readonly komi: number;
  board: Int8Array;
  toMove: Color = BLACK;
  moves: MoveRecord[] = [];
  captures = { [BLACK]: 0, [WHITE]: 0 } as Record<Color, number>;
  private history = new Set<string>();
  private snapshots: Array<{ board: Int8Array; toMove: Color; captures: Record<Color, number> }> = [];

  constructor(n: number, komi: number) {
    this.n = n; this.komi = komi;
    this.board = new Int8Array(n * n);
    this.history.add(this.key());
  }

  private key(): string { return this.board.join(''); }

  get passes(): number {
    let k = 0;
    for (let i = this.moves.length - 1; i >= 0 && this.moves[i]!.point === null; i--) k++;
    return k;
  }

  get lastMove(): MoveRecord | undefined { return this.moves.at(-1); }

  /** Play for the side to move. */
  play(p: number): MoveResult {
    const b = Int8Array.from(this.board);
    const r = placeStone(b, this.n, p, this.toMove);
    if (!r.ok) return r;
    const k = b.join('');
    if (this.history.has(k)) return { ok: false, reason: 'ko (the position would repeat)' };
    this.snapshots.push({ board: this.board, toMove: this.toMove, captures: { ...this.captures } });
    this.board = b;
    this.history.add(k);
    this.captures[this.toMove] += r.captured.length;
    this.moves.push({ color: this.toMove, point: p, captured: r.captured.length });
    this.toMove = other(this.toMove);
    return r;
  }

  pass(): void {
    this.snapshots.push({ board: this.board, toMove: this.toMove, captures: { ...this.captures } });
    this.moves.push({ color: this.toMove, point: null, captured: 0 });
    this.toMove = other(this.toMove);
  }

  /** Undo the last move. */
  undo(): boolean {
    const snap = this.snapshots.pop();
    if (!snap) return false;
    this.history.delete(this.key());
    this.board = snap.board; this.toMove = snap.toMove; this.captures = snap.captures;
    this.moves.pop();
    return true;
  }

  legalMoves(c: Color = this.toMove): number[] {
    const out: number[] = [];
    for (let p = 0; p < this.n * this.n; p++) {
      if (this.board[p] !== EMPTY) continue;
      const b = Int8Array.from(this.board);
      if (placeStone(b, this.n, p, c).ok && !this.history.has(b.join(''))) out.push(p);
    }
    return out;
  }

  sgf(names: { black: string; white: string }, result?: string): string {
    const coord = (p: number) => String.fromCharCode(97 + (p % this.n)) + String.fromCharCode(97 + Math.floor(p / this.n));
    const head = `(;GM[1]FF[4]CA[UTF-8]AP[archipelago-games]SZ[${this.n}]KM[${this.komi}]RU[Chinese]PB[${names.black}]PW[${names.white}]${result ? `RE[${result}]` : ''}`;
    const body = this.moves.map((m) => `;${m.color === BLACK ? 'B' : 'W'}[${m.point === null ? '' : coord(m.point)}]`).join('');
    return `${head}${body})`;
  }

  toJSON(): { n: number; komi: number; moves: Array<number | null> } {
    return { n: this.n, komi: this.komi, moves: this.moves.map((m) => m.point) };
  }

  static fromJSON(j: { n: number; komi: number; moves: Array<number | null> }): GoGame {
    const g = new GoGame(j.n, j.komi);
    for (const m of j.moves) { if (m === null) g.pass(); else g.play(m); }
    return g;
  }
}
