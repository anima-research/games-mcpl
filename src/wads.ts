// Commercial WADs are not in the image: at startup they are synced from a
// private S3 bucket into the data volume (rclone, once; later starts find them
// already there and only compare sizes). Without S3 configured, whatever is in
// DOOM_WAD_DIR is used as is.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';

export interface WadSync { endpoint: string; bucket: string; prefix: string; key: string; secret: string }

export function wadSyncFromEnv(env: NodeJS.ProcessEnv = process.env): WadSync | null {
  const { WADS_S3_ENDPOINT: endpoint, WADS_S3_BUCKET: bucket, WADS_S3_KEY: key, WADS_S3_SECRET: secret } = env;
  if (!endpoint || !bucket || !key || !secret) return null;
  return { endpoint, bucket, prefix: (env.WADS_S3_PREFIX ?? 'wads').replace(/^\/+|\/+$/g, ''), key, secret };
}

/** Returns the WAD names present afterwards (empty when nothing could be synced). */
export async function syncWads(dir: string, s3: WadSync | null, log: (m: string) => void): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  if (s3) {
    const started = Date.now();
    const args = ['copy', `:s3:${s3.bucket}/${s3.prefix}`, dir, '--include', '*.wad', '--size-only', '--transfers', '4', '--stats-one-line', '-v'];
    const env = {
      ...process.env,
      RCLONE_S3_PROVIDER: 'Other', RCLONE_S3_ENDPOINT: s3.endpoint, RCLONE_S3_ACCESS_KEY_ID: s3.key, RCLONE_S3_SECRET_ACCESS_KEY: s3.secret,
      RCLONE_S3_REGION: process.env.WADS_S3_REGION ?? 'us-west-or',
    };
    const result = await new Promise<{ code: number | null; err: string }>((resolve) => {
      let err = '';
      const p = spawn('rclone', args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
      p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      p.on('error', (e) => resolve({ code: null, err: e.message }));
      p.on('exit', (code) => resolve({ code, err }));
    });
    if (result.code === 0) log(`[wads] synced from s3://${s3.bucket}/${s3.prefix} in ${Math.round((Date.now() - started) / 1000)}s`);
    else log(`[wads] sync FAILED (${result.code ?? 'spawn'}): ${result.err.trim().split('\n').slice(-3).join(' | ')} — using what is in ${dir}`);
  }
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.wad')) : [];
  log(`[wads] available: ${names.join(', ') || 'none (Freedoom only)'}`);
  return names;
}
