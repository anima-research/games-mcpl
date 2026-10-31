#!/usr/bin/env node
// archipelago-games — agents play Doom over network MCPL; people watch and chat on the web.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KeyObject } from 'node:crypto';
import { loadConfig, type Config } from './config.js';
import { DevIssuer, Fault, resolveIssuers, verifyAid1, type Identity } from './auth.js';
import { Games, type Principal } from './games.js';
import { createHttp } from './http.js';
import { attachMcpl } from './mcpl.js';
import { Engine } from './engine.js';
import { syncWads, wadSyncFromEnv } from './wads.js';
import { BotPool } from './go/bots.js';
import { GoTables } from './go/toolset.js';

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

export class App {
  readonly root: string;
  games!: Games;
  /** Go (the `go` toolset, for hosts with MCPL RFC-014 toolHints) and its bot's worker threads. */
  go!: GoTables;
  bots!: BotPool;
  wads: string[] = [];
  devIssuer: DevIssuer | null = null;
  private issuers = new Map<string, KeyObject>();
  private principals = new Map<string, Principal>();
  engineOk: boolean | null = null;

  constructor(readonly config: Config) {
    const here = dirname(fileURLToPath(import.meta.url));
    this.root = here.includes(`${'dist'}`) ? join(here, '..', '..') : join(here, '..');
  }

  async init() {
    if (this.config.wadDir) this.wads = await syncWads(this.config.wadDir, wadSyncFromEnv(), log);
    this.games = new Games(this.config, (m) => log(`[games] ${m}`));
    this.bots = new BotPool(this.config.goBots, (m) => log(`[go] ${m}`));
    this.go = new GoTables(join(this.config.dataDir, 'go'), this.bots, (m) => log(`[go] ${m}`), this.config.origin);
    if (this.config.devIssuer) {
      this.devIssuer = new DevIssuer(this.config.devIssuer, this.config.dataDir);
      this.issuers.set(this.config.devIssuer, (await resolveIssuers([{ domain: this.config.devIssuer, publicKey: this.devIssuer.publicKey }])).get(this.config.devIssuer)!);
      log(`[auth] DEVELOPMENT issuer ${this.config.devIssuer} — anyone can sign in as anyone`);
    }
    for (const [d, k] of await resolveIssuers(this.config.issuers)) this.issuers.set(d, k);
    log(`[auth] audience ${this.config.audience}; issuers: ${[...this.issuers.keys()].join(', ') || 'none'}`);
    // Prove the engine runs here (Railway: the Linux wheel); the health endpoint reports it.
    const probe = new Engine(this.config.python, this.config.sidecar, {}, (m) => log(`[probe] ${m}`));
    try {
      await probe.start();
      const r = await probe.call<{ pong: boolean }>('ping');
      this.engineOk = !!r.pong;
      log(`[engine] ok: ${JSON.stringify(probe.hello)}`);
    } catch (e) {
      this.engineOk = false;
      log(`[engine] NOT WORKING: ${(e as Error).message}`);
    } finally { probe.kill(); }
    if (this.engineOk) await this.games.resumeAll();
  }

  verify(token: string): Identity {
    return verifyAid1(token, { audience: this.config.audience, issuers: this.issuers, requiredScopes: this.config.requiredScopes });
  }

  /** Record a verified identity; refuse blocked ones. */
  admit(who: Identity, quiet = false): Principal {
    if (this.config.blocked.includes(who.sub)) throw new Fault(403, 'You are blocked from this service.');
    const existing = this.principals.get(who.sub);
    if (existing && existing.issuer !== who.issuer) throw new Fault(403, 'This identity belongs to another issuer.');
    const admin = this.config.admins.includes(who.sub) || who.scopes.includes(`${this.config.audience}:admin`);
    const p: Principal = { sub: who.sub, name: who.name, kind: who.kind, issuer: who.issuer, admin };
    if (!existing && !quiet) log(`[auth] new principal ${who.kind} ${who.name} (${who.sub})`);
    this.principals.set(who.sub, p);
    return p;
  }
}

async function main() {
  const config = loadConfig();
  const app = new App(config);
  await app.init();
  const { server } = createHttp(app, (m) => log(`[http] ${m}`));
  attachMcpl(server, app, (m) => log(`[mcpl] ${m}`));
  server.listen(config.port, config.host, () => log(`listening on http://${config.host}:${config.port} (origin ${config.origin}); MCPL at /mcpl, viewer at /`));
  const bye = async () => { log('shutting down'); await app.games.shutdown(); app.bots.close(); server.close(); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}

const isMain = process.argv[1] && (process.argv[1].endsWith('index.js') || process.argv[1].endsWith('index.ts'));
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
