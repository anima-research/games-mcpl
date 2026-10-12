// A simple scripted player for demos: connects as an agent (dev issuer) and
// plays a turn every few seconds using the text observation (no model).
//   node --import tsx test/demo.ts http://localhost:7372 [turns] [seconds-between]
import WebSocket from 'ws';

const base = process.argv[2] ?? 'http://localhost:7372';
const turns = Number(process.argv[3] ?? 40);
const pause = Number(process.argv[4] ?? 4) * 1000;
const wsBase = base.replace(/^http/, 'ws');

async function main() {
  const tok = await (await fetch(`${base}/dev/token`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ name: 'Demo Marine', kind: 'agent' }) })).json() as { token: string };
  const ws = new WebSocket(`${wsBase}/mcpl?token=${encodeURIComponent(tok.token)}`);
  await new Promise<void>((r, j) => { ws.on('open', () => r()); ws.on('error', j); });
  let id = 1; const pending = new Map<number, (v: any) => void>();
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.method === 'push/event') { console.log('PUSH', JSON.stringify(m.params.payload.content[0].text)); ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { accepted: true } })); return; } const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } });
  const call = (method: string, params: unknown) => new Promise<any>((r) => { const i = id++; pending.set(i, r); ws.send(JSON.stringify({ jsonrpc: '2.0', id: i, method, params })); });
  const tool = async (name: string, args: unknown = {}) => { const r = await call('tools/call', { name, arguments: args }); if (r.error) throw new Error(r.error.message); return r.result.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') as string; };
  await call('initialize', { protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.5' } } }, clientInfo: { name: 'demo', version: '0' } });
  ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  await call('featureSets/update', { effectiveCapabilities: ['tools', 'pushEvents'], enabledFeatureSets: ['*'] });

  let text = await tool('game_start', { game: 'freedoom1', map: 'E1M1', skill: 2, image: 'none' });
  console.log(text.split('\n')[1]);
  for (let t = 0; t < turns; t++) {
    await new Promise((r) => setTimeout(r, pause));
    if (/YOU DIED|LEVEL COMPLETE|episode over/i.test(text)) { text = await tool('game_start', { game: 'freedoom1', map: 'E1M1', skill: 2, image: 'none' }); continue; }
    // crude policy: shoot the nearest monster in view; else head for the most open direction; else wander.
    const monster = /([A-Za-z ()\-]+) #(\d+)( NEW)?: ([^,]+), (\d+) units/.exec((text.match(/^In view: (.*)$/m)?.[1] ?? '').split(' · ').find((s) => /NEW|monster|zombie|imp|demon|soul|caco/i.test(s)) ?? '');
    const clearance = [...(text.match(/^Clearance.*$/m)?.[0] ?? '').matchAll(/(ahead|(\d+)°([LR])) (\d+)/g)].map((m) => ({ bearing: m[1] === 'ahead' ? 0 : Number(m[2]) * (m[3] === 'R' ? 1 : -1), dist: Number(m[4]) }));
    let actions: unknown[]; let say: string | undefined;
    if (monster) { actions = [{ face: Number(monster[2]) }, { attack: 3 }]; say = `${monster[1].trim()} at ${monster[5]} units — firing.`; }
    else {
      const best = clearance.sort((a, b) => b.dist - a.dist)[0];
      if (best && best.dist > 120) actions = [{ turn: best.bearing }, { move: 'forward', tics: Math.min(70, Math.floor(best.dist / 16)) }];
      else actions = [{ turn: 90 + Math.floor(Math.random() * 90) }, { move: 'forward', tics: 35 }];
      if (t % 5 === 0) say = ['Exploring.', 'Looks quiet here.', 'Checking that corridor.', 'Where is the exit?'][Math.floor(Math.random() * 4)];
    }
    text = await tool('game_act', { actions, say, image: 'none' });
    console.log(`#${t + 1}`, JSON.stringify(actions), '→', text.split('\n').filter((l) => l.startsWith('•')).join(' '));
    if (/Watchers say:/.test(text)) { const w = text.match(/^Watchers say: (.*)$/m)![1]; await tool('game_say', { text: `Heard you: ${w.slice(0, 80)}` }); }
  }
  await tool('game_stop');
  ws.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
