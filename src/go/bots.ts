// The Go bot off the event loop: a small pool of worker threads (worker.ts). One search takes about
// 1.5 s on 9×9 "medium" and up to 10 s on 19×19 "hard"; one process serves every player, so a
// search must never stall the others' turns, sockets or viewers. Jobs queue when every worker is
// busy. A worker that dies is replaced; if the replacement fails too, the move is searched on the
// main thread at the "easy" budget (0.4 s) rather than leaving the game stuck.
import { Worker } from 'node:worker_threads';
import { GoGame } from './board.js';
import { chooseMove, guessDead, type BotMove, type Level } from './bot.js';
import type { Job } from './worker.js';

type Pending = { job: Job; resolve: (v: unknown) => void; reject: (e: Error) => void; tries: number };

const here = new URL('.', import.meta.url);
/** Under tsx (npm run dev, tests) the worker is the .ts source; built, it is the .js next to this file. */
const workerUrl = new URL(import.meta.url.endsWith('.ts') ? 'worker.ts' : 'worker.js', here);

export class BotPool {
  private idle: Worker[] = [];
  private busy = new Map<Worker, Pending>();
  private queue: Pending[] = [];
  private nextId = 1;
  private closed = false;
  private workers = 0;

  constructor(private size: number, private log: (m: string) => void) {}

  /** The bot's move for the side to move. */
  move(game: GoGame, level: Level): Promise<BotMove> {
    return this.run({ id: this.nextId++, op: 'move', game: game.toJSON(), level, seed: Date.now() }, () => chooseMove(game, 'easy')) as Promise<BotMove>;
  }

  /** Stones the playouts give to the other side: the proposed dead stones when scoring starts. */
  async dead(game: GoGame): Promise<Set<number>> {
    const r = await this.run({ id: this.nextId++, op: 'dead', game: game.toJSON() }, () => ({ dead: [...guessDead(game, 150)] })) as { dead: number[] };
    return new Set(r.dead);
  }

  close() {
    this.closed = true;
    for (const w of [...this.idle, ...this.busy.keys()]) void w.terminate();
    for (const p of [...this.busy.values(), ...this.queue]) p.reject(new Error('the bot is shutting down'));
    this.idle = []; this.busy.clear(); this.queue = [];
  }

  private run(job: Job, fallback: () => unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('the bot is shut down'));
    return new Promise((resolve, reject) => {
      const p: Pending = { job, resolve, reject, tries: 0 };
      // A worker that cannot run at all: search here, small, rather than leave the game stuck.
      p.reject = (e) => {
        this.log(`go bot worker failed (${e.message}); searching on the main thread at the easy budget`);
        try { resolve(fallback()); } catch (err) { reject(err as Error); }
      };
      this.queue.push(p);
      this.pump();
    });
  }

  private pump() {
    while (this.queue.length) {
      let w = this.idle.pop();
      if (!w && this.workers < this.size) w = this.spawn();
      if (!w) return;
      const p = this.queue.shift()!;
      this.busy.set(w, p);
      w.postMessage(p.job);
    }
  }

  private spawn(): Worker {
    this.workers++;
    const w = new Worker(workerUrl);
    w.unref();
    w.on('message', (m: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const p = this.busy.get(w);
      this.busy.delete(w);
      if (!this.closed) this.idle.push(w);
      if (p && p.job.id === m.id) { if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error ?? 'bot error')); }
      this.pump();
    });
    const lost = (why: string) => {
      this.workers--;
      this.idle = this.idle.filter((x) => x !== w);
      const p = this.busy.get(w);
      this.busy.delete(w);
      if (this.closed) return;
      this.log(`go bot worker ${why}`);
      if (p) { if (p.tries++ < 1) this.queue.unshift(p); else p.reject(new Error(why)); }
      this.pump();
    };
    w.on('error', (e) => lost(`error: ${e.message}`));
    w.on('exit', (code) => { if (this.busy.has(w) || this.idle.includes(w)) lost(`exited (${code})`); });
    return w;
  }
}
