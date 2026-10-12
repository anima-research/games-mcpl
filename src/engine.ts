// One Doom engine = one sidecar process (py/sidecar.py) spoken to over JSON lines.
// Calls are serialized per engine; the world only advances inside an `act`.
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface Observation {
  game: string; map: string; skill: number; turn: number; finished: boolean; dead: boolean;
  events: string[];
  status: Record<string, unknown> & { health?: number; armor?: number; weapon?: string; weapon_ammo?: number; ammo?: Record<string, number>; kills?: number; items?: number; secrets?: number; time_s?: number; note?: string };
  position?: { x: number; y: number; z: number; angle: number; facing?: string };
  openings?: { kind: string; bearing: number; distance: number; x: number; y: number; explored: boolean; width: number }[];
  explored?: { visited: number; total: number };
  visible?: { id: number; name: string; label: string; category: string; bearing: number; distance: number; px: number[] }[];
  new_monsters?: number[];
  heard?: { id: number; label: string; distance: number; bearing: number }[];
  clearance?: { bearing: number; distance: number; hit: string }[];
  messages?: string[];
  stopped_early?: string | null;
  frame_jpeg?: string;
  automap_jpeg?: string;
  /** Full-size pictures for watchers, always present on a live observation. */
  view?: { frame: string; automap: string };
  took_ms?: number;
}

export interface Catalogue { games: Record<string, { title: string; maps: string[] }>; skills: Record<string, string> }

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class EngineError extends Error {}

export class Engine {
  private proc: ChildProcess | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private readyPromise: Promise<void> | null = null;
  public closed = false;
  public hello: Record<string, unknown> | null = null;

  constructor(private python: string, private script: string, private env: Record<string, string>, private log: (m: string) => void, private cwd?: string) {}

  /** Spawn the process and wait for its hello line. */
  start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const proc = spawn(this.python, ['-I', this.script], { env: { ...process.env, ...this.env }, stdio: ['pipe', 'pipe', 'pipe'], ...(this.cwd ? { cwd: this.cwd } : {}) });
      this.proc = proc;
      let greeted = false;
      const helloTimer = setTimeout(() => { if (!greeted) { reject(new EngineError('engine did not start in time')); this.kill(); } }, 60_000);
      const rl = createInterface({ input: proc.stdout! });
      rl.on('line', (line) => {
        let msg: { id?: number | null; ok?: boolean; result?: unknown; error?: string };
        try { msg = JSON.parse(line); } catch { this.log(`engine: unparseable line ${line.slice(0, 120)}`); return; }
        if (!greeted) {
          greeted = true; clearTimeout(helloTimer);
          if (msg.ok) { this.hello = (msg.result as Record<string, unknown>) ?? {}; resolve(); }
          else reject(new EngineError(`engine failed to start: ${msg.error ?? 'unknown'}`));
          return;
        }
        const p = msg.id != null ? this.pending.get(msg.id) : undefined;
        if (!p) return;
        this.pending.delete(msg.id as number);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result); else p.reject(new EngineError(msg.error ?? 'engine error'));
      });
      proc.stderr!.on('data', (d: Buffer) => { for (const l of d.toString().split('\n')) if (l.trim()) this.log(`engine: ${l.trim().slice(0, 300)}`); });
      proc.on('exit', (code, signal) => {
        this.log(`engine exited (${code ?? signal})`);
        this.closed = true;
        clearTimeout(helloTimer);
        if (!greeted) reject(new EngineError(`engine exited before starting (${code ?? signal})`));
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new EngineError('engine exited')); }
        this.pending.clear();
      });
      proc.on('error', (e) => { this.log(`engine spawn error: ${e.message}`); if (!greeted) reject(new EngineError(`cannot start engine: ${e.message}`)); });
    });
    return this.readyPromise;
  }

  /** Serialized request. */
  call<T = unknown>(op: string, args: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<T> {
    const run = async (): Promise<T> => {
      await this.start();
      if (this.closed || !this.proc?.stdin?.writable) throw new EngineError('engine is not running');
      const id = this.nextId++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(id); reject(new EngineError(`engine ${op} timed out`)); this.kill(); }, timeoutMs);
        this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
        this.proc!.stdin!.write(JSON.stringify({ id, op, args }) + '\n');
      });
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  kill() {
    this.closed = true;
    try { this.proc?.stdin?.end(); } catch { /* ignore */ }
    const p = this.proc;
    if (p && p.exitCode === null) {
      setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, 3000).unref();
      try { p.kill('SIGTERM'); } catch { /* gone */ }
    }
  }
}
