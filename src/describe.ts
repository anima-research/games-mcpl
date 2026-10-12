// Turn an observation into the text an agent reads. Bearings: degrees, + = right.
import type { Observation } from './engine.js';
import type { ChatMessage, GameSession } from './games.js';

const dir = (b: number): string => {
  const a = Math.abs(b);
  if (a <= 4) return 'straight ahead';
  if (a >= 176) return 'directly behind';
  const side = b > 0 ? 'right' : 'left';
  if (a > 135) return `behind-${side} (${a}°)`;
  if (a > 95) return `${side}-behind (${a}°)`;
  return `${a}° ${side}`;
};

const mmss = (s?: number) => { if (s == null) return '?'; const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };

export function describe(obs: Observation, session: GameSession, chat: ChatMessage[], watchers: number): string {
  const s = obs.status ?? {};
  const lines: string[] = [];
  const title = `${obs.game} ${obs.map} · turn ${obs.turn} · ${mmss(s.time_s)} game time`;
  if (s.note) lines.push(`${title} — ${s.note}`);
  else {
    const ammo = s.ammo ? Object.entries(s.ammo).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(', ') : '';
    lines.push(`${title} · health ${s.health} · armor ${s.armor} · ${s.weapon} (${s.weapon_ammo} rounds${ammo ? `; ${ammo}` : ''}) · kills ${s.kills} · items ${s.items} · secrets ${s.secrets}`);
    if (Array.isArray(s.weapons) && s.weapons.length) lines.push(`Weapons: ${(s.weapons as string[]).join(', ')}.`);
  }
  if (obs.events?.length) lines.push(...obs.events.map((e) => `• ${e}`));
  if (obs.messages?.length) lines.push(`Game messages: ${obs.messages.join(' | ')}`);
  if (obs.position) lines.push(`Position (${obs.position.x}, ${obs.position.y}) z ${obs.position.z}, facing ${obs.position.angle}°.`);
  if (obs.visible?.length) {
    const seen = obs.visible.slice(0, 14).map((o) => {
      const tag = o.category === 'monster' ? (obs.new_monsters?.includes(o.id) ? ' NEW' : '') : ` (${o.category})`;
      return `${o.label} #${o.id}${tag}: ${dir(o.bearing)}, ${o.distance} units`;
    });
    lines.push(`In view: ${seen.join(' · ')}${obs.visible.length > 14 ? ` · +${obs.visible.length - 14} more` : ''}.`);
  } else if (!s.note) lines.push('In view: nothing of interest (walls, floor, decorations).');
  if (obs.heard?.length) lines.push(`Heard nearby, not in view: ${obs.heard.map((h) => `${h.label} #${h.id} ${dir(h.bearing)}, ${h.distance} units`).join(' · ')}.`);
  if (obs.clearance?.length) {
    const c = obs.clearance.map((x) => `${x.bearing === 0 ? 'ahead' : x.bearing > 0 ? `${x.bearing}°R` : `${-x.bearing}°L`} ${x.distance >= 2000 ? '2000+' : x.distance}${x.hit === 'wall' ? '' : ` ${x.hit}`}`);
    lines.push(`Clearance (units to the nearest wall/door/ledge): ${c.join(' · ')}.`);
  }
  if (chat.length) lines.push(`Watchers say: ${chat.map((m) => `${m.from.name}: "${m.text}"`).join(' · ')}`);
  if (watchers > 0) lines.push(`${watchers} ${watchers === 1 ? 'person is' : 'people are'} watching${session.lastSay ? '' : ' — game_say or the say field of game_act talks to them'}.`);
  return lines.join('\n');
}

export const ACTION_HELP = [
  'Actions (list, run in order; the world only moves while you act):',
  '  {"move":"forward|back|left|right","tics":35}  — 35 tics = 1 s; run speed ≈ 16 units/tic. Stops early when blocked.',
  '  {"turn": 45}                                  — degrees, + = right, − = left; exact.',
  '  {"face": <object id> | [x,y]}                 — turn to face an object from "In view"/"Heard", or map coordinates.',
  '  {"goto": <object id> | [x,y], "within": 48}   — face it and run straight at it; stops on arrival, block, damage or a new enemy.',
  '  {"attack": 2}                                 — fire N shots at whatever you face (hold until the ammo drops N times).',
  '  {"use": true}                                 — open the door / press the switch in front of you (walk up to it first).',
  '  {"weapon": 3}                                 — 1 fist, 2 pistol, 3 shotgun, 4 chaingun, 5 rockets, 6 plasma, 7 BFG, 8 chainsaw.',
  '  {"wait": 35}                                  — stand still N tics (doors take ~30 tics to open).',
  'stop_on (default ["damage","enemy","dead","level"]) ends the sequence early so you can react; pass [] to run it all.',
].join('\n');
