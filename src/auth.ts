// Archipelago `aid1` verification (the audience contract) — offline, multi-issuer.
//
// aid1.<b64url(payload json)>.<b64url(ed25519 signature over "aid1.<payload>")>
// Verify the literal bytes, then parse. Never re-canonicalize.

import {
  createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, createHash,
  type KeyObject,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type PrincipalKind = 'human' | 'agent' | 'service';

export interface Identity {
  sub: string;
  name: string;
  kind: PrincipalKind;
  issuer: string;
  scopes: string[];
  claims: Record<string, unknown>;
  exp: number;
  jti?: string;
}

export class Fault extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function publicKeyFromString(key: string): KeyObject {
  if (!key.startsWith('ed25519:')) throw new Error('issuer key must be ed25519:<b64url>');
  const raw = Buffer.from(key.slice(8), 'base64url');
  if (raw.length !== 32) throw new Error('issuer key must be 32 bytes');
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
}

export interface VerifierOptions {
  audience: string;
  /** domain → public key object */
  issuers: Map<string, KeyObject>;
  requiredScopes: string[];
  now?: () => number;
}

/** Throws Fault(401) on any defect; the reason stays server-side. */
export function verifyAid1(token: string, opts: VerifierOptions): Identity {
  const why = (reason: string): never => { throw new Fault(401, 'A valid Archipelago identity token is required.', reason); };
  if (typeof token !== 'string' || token.length > 16384) why('shape');
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'aid1') why('shape');
  let payload: any;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { why('payload'); }
  const key = opts.issuers.get(payload?.iss);
  if (!key) why(`untrusted issuer ${String(payload?.iss)}`);
  let ok = false;
  try { ok = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key!, Buffer.from(parts[2], 'base64url')); } catch { ok = false; }
  if (!ok) why('signature');
  const now = (opts.now?.() ?? Date.now()) / 1000;
  if (payload.v !== 1) why('version');
  if (payload.aud !== opts.audience) why(`audience ${String(payload.aud)}`);
  if (!Number.isFinite(payload.exp) || payload.exp <= now) why('expired');
  if (!Number.isFinite(payload.iat) || payload.iat > now + 300) why('iat');
  if (!['human', 'agent', 'service'].includes(payload.kind)) why('kind');
  // Subs are identifiers: a plain character set keeps them unambiguous wherever they're embedded or masked.
  if (typeof payload.sub !== 'string' || !payload.sub.startsWith(`${payload.kind}:`) || payload.sub.length > 512 || !/^[A-Za-z0-9._~:@+=\/-]+$/.test(payload.sub)) why('sub');
  if (typeof payload.name !== 'string' || !payload.name || payload.name.length > 200) why('name');
  if (!Array.isArray(payload.scopes) || !payload.scopes.every((s: unknown) => typeof s === 'string')) why('scopes');
  for (const s of opts.requiredScopes) if (!payload.scopes.includes(s)) why(`missing scope ${s}`);
  return {
    sub: payload.sub,
    name: payload.name,
    kind: payload.kind,
    issuer: payload.iss,
    scopes: payload.scopes,
    claims: payload.claims && typeof payload.claims === 'object' ? payload.claims : {},
    exp: payload.exp,
    ...(typeof payload.jti === 'string' ? { jti: payload.jti } : {}),
  };
}

/** Resolve issuer keys: pinned, else https://<domain>/.well-known/mcpl-identity. */
export async function resolveIssuers(
  issuers: { domain: string; publicKey?: string }[],
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, KeyObject>> {
  const map = new Map<string, KeyObject>();
  for (const iss of issuers) {
    let key = iss.publicKey;
    if (!key) {
      try {
        const res = await fetchImpl(`https://${iss.domain}/.well-known/mcpl-identity`, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const wk = await res.json() as { scheme?: string; domain?: string; publicKey?: string };
        if (wk.scheme !== 'ed25519' || wk.domain !== iss.domain || typeof wk.publicKey !== 'string') throw new Error('malformed well-known document');
        key = wk.publicKey;
      } catch (e) {
        console.error(`[auth] issuer ${iss.domain}: key unavailable (${(e as Error).message}); its tokens will be refused. Pin it with DOCS_ISSUERS=${iss.domain}=ed25519:…`);
        continue;
      }
    }
    map.set(iss.domain, publicKeyFromString(key));
  }
  return map;
}

/** Single-use guard for login-redirect tokens (contract §3.3). */
export class JtiCache {
  private seen = new Map<string, number>();
  use(jti: string | undefined, exp: number): boolean {
    if (!jti) return true; // tokens without jti are not redirect tokens; nothing to guard
    const now = Date.now() / 1000;
    for (const [k, e] of this.seen) if (e <= now) this.seen.delete(k);
    if (this.seen.has(jti)) return false;
    this.seen.set(jti, exp);
    return true;
  }
}

export const tokenHash = (s: string) => createHash('sha256').update(s).digest('hex');
export const opaque = (bytes = 32) => randomBytes(bytes).toString('base64url');

// ---------------------------------------------------------------------------
// Development issuer — a local stand-in for the home node. Mints aid1 tokens
// for any name/kind so the whole stack can be exercised without id.animalabs.ai.
// ---------------------------------------------------------------------------

export class DevIssuer {
  readonly publicKey: string;
  private privateKey: KeyObject;

  constructor(readonly domain: string, dataDir: string) {
    const file = join(dataDir, 'dev-issuer.key.json');
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      this.privateKey = createPrivateKey({ key: Buffer.from(saved.pkcs8, 'base64'), format: 'der', type: 'pkcs8' });
    } else {
      const { privateKey } = generateKeyPairSync('ed25519');
      this.privateKey = privateKey;
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(file, JSON.stringify({ pkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') }), { mode: 0o600 });
    }
    const spki = createPublicKey(this.privateKey).export({ format: 'der', type: 'spki' }) as Buffer;
    this.publicKey = `ed25519:${spki.subarray(SPKI_ED25519_PREFIX.length).toString('base64url')}`;
  }

  mint(p: { name: string; kind: PrincipalKind; audience: string; scopes?: string[]; ttlSeconds?: number; sub?: string; claims?: Record<string, unknown> }): string {
    return mintAid1(this.privateKey, {
      iss: this.domain,
      sub: p.sub ?? (p.kind === 'human' ? `human:dev:${slug(p.name)}` : `${p.kind}:${slug(p.name)}@${this.domain}`),
      kind: p.kind,
      name: p.name,
      aud: p.audience,
      scopes: p.scopes ?? [],
      ...(p.claims ? { claims: p.claims } : {}),
      ttlSeconds: p.ttlSeconds ?? 12 * 3600,
    });
  }
}

export function mintAid1(privateKey: KeyObject, p: {
  iss: string; sub: string; kind: PrincipalKind; name: string; aud: string; scopes: string[];
  claims?: Record<string, unknown>; ttlSeconds: number; iat?: number;
}): string {
  const iat = p.iat ?? Math.floor(Date.now() / 1000);
  const payload = {
    v: 1, iss: p.iss, sub: p.sub, kind: p.kind, name: p.name, aud: p.aud, scopes: p.scopes,
    ...(p.claims ? { claims: p.claims } : {}),
    iat, exp: iat + p.ttlSeconds, jti: randomBytes(12).toString('base64url'),
  };
  const head = `aid1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${head}.${sign(null, Buffer.from(head), privateKey).toString('base64url')}`;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'anon';
