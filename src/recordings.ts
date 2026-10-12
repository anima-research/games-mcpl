// Recordings: every game is written to disk as it is played — one directory per
// game with the turn log (JSON lines: turns, chat) and a JPEG frame + automap
// per turn — so it can be replayed in the viewer later.
//
//   <dataDir>/recordings/<gameId>/meta.json      { game meta, updated at the end }
//   <dataDir>/recordings/<gameId>/events.jsonl   { type: 'turn', record, frame: n } | { type: 'chat', message }
//   <dataDir>/recordings/<gameId>/f/<n>.jpg  m/<n>.jpg
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage, GameSession, PublicGame, TurnRecord } from './games.js';

export interface RecordingMeta extends PublicGame { turnsRecorded: number; frames: number; updatedAt: number }

export class Recordings {
  readonly dir: string;
  private frameCount = new Map<string, number>();

  constructor(dataDir: string, private keep: number, private log: (m: string) => void) {
    this.dir = join(dataDir, 'recordings');
    mkdirSync(this.dir, { recursive: true });
  }

  private path(id: string, ...rest: string[]) { return join(this.dir, id, ...rest); }

  /** Called on every turn record (including the system "start" record and say-only records). */
  turn(session: GameSession, record: TurnRecord) {
    try {
      const id = session.id;
      if (!this.frameCount.has(id)) {
        mkdirSync(this.path(id, 'f'), { recursive: true });
        mkdirSync(this.path(id, 'm'), { recursive: true });
        this.frameCount.set(id, 0);
      }
      let frame: number | null = null;
      if (session.frame && (record.actions.length > 0 || record.by === 'system')) {
        frame = this.frameCount.get(id)!;
        writeFileSync(this.path(id, 'f', `${frame}.jpg`), session.frame);
        if (session.automap) writeFileSync(this.path(id, 'm', `${frame}.jpg`), session.automap);
        this.frameCount.set(id, frame + 1);
      }
      appendFileSync(this.path(id, 'events.jsonl'), JSON.stringify({ type: 'turn', record, frame }) + '\n');
      this.writeMeta(session);
    } catch (e) { this.log(`recording ${session.id} turn failed: ${(e as Error).message}`); }
  }

  chat(session: GameSession, message: ChatMessage) {
    try {
      if (!this.frameCount.has(session.id)) return;
      appendFileSync(this.path(session.id, 'events.jsonl'), JSON.stringify({ type: 'chat', message }) + '\n');
    } catch (e) { this.log(`recording ${session.id} chat failed: ${(e as Error).message}`); }
  }

  ended(session: GameSession) {
    try { this.writeMeta(session); this.frameCount.delete(session.id); this.prune(); }
    catch (e) { this.log(`recording ${session.id} end failed: ${(e as Error).message}`); }
  }

  private writeMeta(session: GameSession) {
    const meta: RecordingMeta = { ...session.public(), turnsRecorded: session.log.length, frames: this.frameCount.get(session.id) ?? 0, updatedAt: Date.now() };
    writeFileSync(this.path(session.id, 'meta.json'), JSON.stringify(meta));
  }

  /** Newest first. */
  list(): RecordingMeta[] {
    const out: RecordingMeta[] = [];
    for (const id of this.ids()) {
      try { out.push(JSON.parse(readFileSync(this.path(id, 'meta.json'), 'utf8'))); } catch { /* partial */ }
    }
    return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  meta(id: string): RecordingMeta | null {
    if (!/^g[0-9a-f]+$/.test(id)) return null;
    try { return JSON.parse(readFileSync(this.path(id, 'meta.json'), 'utf8')); } catch { return null; }
  }

  events(id: string): unknown[] {
    if (!/^g[0-9a-f]+$/.test(id)) return [];
    try {
      return readFileSync(this.path(id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  frame(id: string, kind: 'f' | 'm', n: number): Buffer | null {
    if (!/^g[0-9a-f]+$/.test(id) || !Number.isInteger(n) || n < 0) return null;
    try { return readFileSync(this.path(id, kind, `${n}.jpg`)); } catch { return null; }
  }

  private ids(): string[] {
    try { return readdirSync(this.dir).filter((d) => /^g[0-9a-f]+$/.test(d)); } catch { return []; }
  }

  /** Keep the newest `keep` recordings; live games are never pruned. */
  private prune() {
    const all = this.ids().map((id) => ({ id, t: (() => { try { return statSync(this.path(id, 'meta.json')).mtimeMs; } catch { return 0; } })() }))
      .filter((r) => !this.frameCount.has(r.id)).sort((a, b) => b.t - a.t);
    for (const r of all.slice(this.keep)) {
      try { rmSync(this.path(r.id), { recursive: true, force: true }); this.log(`pruned recording ${r.id}`); } catch { /* ignore */ }
    }
  }

  static sizeOf(dir: string): number {
    let total = 0;
    const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else total += statSync(p).size; } };
    try { if (existsSync(dir)) walk(dir); } catch { /* ignore */ }
    return total;
  }
}
