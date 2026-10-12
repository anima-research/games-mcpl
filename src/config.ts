// Runtime configuration, read once from the environment.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface IssuerTrust { domain: string; publicKey?: string }

export interface Config {
  port: number;
  host: string;
  /** Public origin of the web viewer, e.g. https://games.animalabs.ai. */
  origin: string;
  dataDir: string;
  /** Audience id this service accepts (`aud` claim). */
  audience: string;
  /** Trusted issuers; the first is the home issuer used for human sign-in. */
  issuers: IssuerTrust[];
  requiredScopes: string[];
  /** Subs that are admins (may stop anyone's game, block principals). */
  admins: string[];
  /** Subs that may not connect at all. */
  blocked: string[];
  /** Local development issuer (see archipelago-docs); never in production. */
  devIssuer: string | null;
  /** Python interpreter with vizdoom installed, and the sidecar script. */
  python: string;
  sidecar: string;
  /** Optional directory holding doom.wad / doom2.wad for the commercial games. */
  wadDir: string | null;
  /** Concurrent engines (each ~80 MB RSS). */
  maxGames: number;
  /** A game nobody has acted in for this long is closed. */
  idleMinutes: number;
  /** Finished recordings to keep on disk (newest). */
  keepRecordings: number;
  sessionDays: number;
  trustedProxyHops: number;
}

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const here = dirname(fileURLToPath(import.meta.url));          // dist/src or src
const root = join(here, '..', here.endsWith('dist/src') || here.endsWith('dist\\src') ? '..' : '');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 7372);
  const origin = (env.GAMES_ORIGIN ?? `http://localhost:${port}`).replace(/\/$/, '');
  const issuers: IssuerTrust[] = list(env.GAMES_ISSUERS ?? 'id.animalabs.ai').map((entry) => {
    const eq = entry.indexOf('=');
    return eq < 0 ? { domain: entry } : { domain: entry.slice(0, eq), publicKey: entry.slice(eq + 1) };
  });
  const devIssuer = env.GAMES_DEV_ISSUER?.trim() || null;
  if (devIssuer && origin.startsWith('https:') && env.GAMES_DEV_ALLOW_HTTPS !== '1') {
    throw new Error('GAMES_DEV_ISSUER is for local development; refusing to start on an https origin.');
  }
  return {
    port,
    host: env.GAMES_HOST ?? '127.0.0.1',
    origin,
    dataDir: env.GAMES_DATA_DIR ?? join(root, 'data'),
    audience: env.GAMES_AUDIENCE ?? 'games',
    issuers,
    requiredScopes: list(env.GAMES_REQUIRED_SCOPES),
    admins: list(env.GAMES_ADMINS),
    blocked: list(env.GAMES_BLOCKED),
    devIssuer,
    python: env.GAMES_PYTHON ?? join(root, 'py', '.venv', 'bin', 'python'),
    sidecar: env.GAMES_SIDECAR ?? join(root, 'py', 'sidecar.py'),
    wadDir: env.DOOM_WAD_DIR?.trim() || null,
    maxGames: Math.max(1, Number(env.GAMES_MAX_GAMES ?? 6) || 6),
    idleMinutes: Math.max(1, Number(env.GAMES_IDLE_MINUTES ?? 90) || 90),
    keepRecordings: Math.max(1, Number(env.GAMES_KEEP_RECORDINGS ?? 200) || 200),
    sessionDays: Math.max(1, Number(env.GAMES_SESSION_DAYS ?? 30) || 30),
    trustedProxyHops: env.GAMES_TRUSTED_PROXY_HOPS !== undefined ? Math.max(0, Number(env.GAMES_TRUSTED_PROXY_HOPS) || 0) : origin.startsWith('https:') ? 1 : 0,
  };
}
