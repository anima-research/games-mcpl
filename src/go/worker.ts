// A Go bot worker thread (see bots.ts): the Monte Carlo search is CPU-bound for seconds, so it runs
// here and not on the event loop that serves every player.
import { parentPort } from 'node:worker_threads';
import { GoGame } from './board.js';
import { chooseMove, guessDead, type Level } from './bot.js';

export type Job =
  | { id: number; op: 'move'; game: ReturnType<GoGame['toJSON']>; level: Level; seed: number }
  | { id: number; op: 'dead'; game: ReturnType<GoGame['toJSON']> };

parentPort?.on('message', (job: Job) => {
  try {
    const game = GoGame.fromJSON(job.game);
    const result = job.op === 'move' ? chooseMove(game, job.level, job.seed) : { dead: [...guessDead(game)] };
    parentPort!.postMessage({ id: job.id, ok: true, result });
  } catch (e) {
    parentPort!.postMessage({ id: job.id, ok: false, error: (e as Error).message });
  }
});
