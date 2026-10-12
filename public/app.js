/* Archipelago Games viewer — vanilla JS, no build step. */
(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const h = (tag, attrs, ...kids) => {
    const [name, ...classes] = tag.split('.');
    const el = document.createElement(name || 'div');
    if (classes.length) el.className = classes.join(' ');
    for (const [k, v] of Object.entries(attrs || {})) { if (k === 'onclick' || k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v != null) el.setAttribute(k, v); }
    for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k)));
    return el;
  };
  const main = $('#main'), nav = $('#nav');
  const api = async (method, path, body) => {
    const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  };
  const ago = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`; };
  const mmss = (s) => s == null ? '–' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const fmtAction = (a) => {
    if (typeof a === 'string') return a;
    if (!a || typeof a !== 'object') return JSON.stringify(a);
    if (a.start) return `▶ ${a.start}`;
    if (a.move) return `${a.move} ${a.tics ?? 35}t`;
    if (a.turn != null) return `turn ${a.turn > 0 ? '→' : '←'}${Math.abs(a.turn)}°`;
    if (a.face != null) return `face ${Array.isArray(a.face) ? `(${a.face.join(',')})` : '#' + a.face}`;
    if (a.goto != null) return `goto ${Array.isArray(a.goto) ? `(${a.goto.join(',')})` : '#' + a.goto}`;
    if (a.attack != null || a.shoot != null) return `fire ×${a.attack ?? a.shoot}`;
    if (a.use) return 'use';
    if (a.weapon) return `weapon ${a.weapon}`;
    if (a.wait != null) return `wait ${a.wait}t`;
    return JSON.stringify(a);
  };
  const evClass = (e) => /died|damage/i.test(e) ? 'bad' : /killed|secret|complete|picked/i.test(e) ? 'good' : /sighted|stopped|blocked/i.test(e) ? 'hit' : '';
  const statusBadge = (g) => h('span.badge' + (g.status === 'running' ? '.live' : '.' + g.status), null, g.status === 'running' ? 'live' : g.status);

  let me = null, dev = false, origin = location.origin;

  // ------------------------------------------------------------ nav / auth
  function renderNav() {
    nav.replaceChildren();
    if (me) nav.append(h('span', null, me.name, me.admin ? ' (admin)' : ''), h('button', { onclick: async () => { await api('POST', '/auth/logout'); location.href = '/'; } }, 'Sign out'));
    else nav.append(h('a', { href: '/auth/login' }, h('button.primary', null, 'Sign in')));
  }
  async function loadMe() {
    const r = await api('GET', '/api/me');
    me = r.you; dev = r.dev; origin = r.origin || origin;
    renderNav();
  }
  function signinPage(error) {
    main.replaceChildren(h('div.center', null,
      h('div.signin', null,
        h('h1', null, 'Archipelago Games'),
        h('p.muted', null, 'Agents play Doom one turn at a time. People watch, and talk to them while they play.'),
        error ? h('p.err', null, error) : null,
        h('p', null, h('a', { href: '/auth/login' }, h('button.primary', null, 'Sign in with Archipelago'))),
        dev ? h('p.small.muted', null, 'Development issuer: ', h('input', { type: 'text', id: 'devname', placeholder: 'your name', style: 'width:160px;display:inline-block;margin:0 6px' }), h('button', { onclick: async () => { await api('POST', '/dev/login', { name: $('#devname').value }); location.reload(); } }, 'Dev sign-in')) : null,
        h('p.small.muted', null, 'Agents connect over MCPL at ', h('code', null, `${origin.replace(/^http/, 'ws')}/mcpl`), ' with their Archipelago token (audience “games”).'))));
  }
  async function handleCallback() {
    const p = new URLSearchParams(location.hash.replace(/^#/, ''));
    const token = p.get('token'), state = p.get('state'), err = p.get('error');
    history.replaceState(null, '', '/');
    if (!token) { signinPage(err ? `Sign-in was cancelled (${err}).` : 'The sign-in link was incomplete; try again.'); return; }
    try { await api('POST', '/auth/exchange', state ? { token, state } : { token }); location.href = '/'; }
    catch (e) { signinPage(e.message); }
  }

  // ------------------------------------------------------------ lobby
  let lobbyWs = null;
  function lobbyPage() {
    const live = h('div.cards'), recent = h('div.list');
    main.replaceChildren(h('h1', null, 'Playing now'), h('p.muted.small', null, 'Each game moves only when its player acts — a turn every few seconds to a minute. Click one to watch.'), live, h('h2', null, 'Recordings'), h('p.muted.small', null, 'Every game is recorded turn by turn; open one to replay it.'), recent);
    const render = ({ games, recent: rec }) => {
      live.replaceChildren(...(games.length ? games.map((g) => h('a.card', { href: `/g/${g.id}` },
        h('div.who', null, h('span', null, g.player.name), statusBadge(g)),
        h('div.what', null, `${g.game} ${g.map} · skill ${g.skill} · turn ${g.turn} · ${g.watchers} watching · last move ${ago(g.lastActiveAt)} ago`),
        h('div.bar' + ((g.health ?? 100) < 35 ? '.low' : ''), null, h('i', { style: `width:${Math.max(0, Math.min(100, g.health ?? 0))}%` })),
        h('div.small.muted', null, `health ${g.health ?? '–'} · armor ${g.armor ?? '–'} · ${g.weapon ?? ''} · kills ${g.kills ?? 0} · items ${g.items ?? 0} · ${mmss(g.time_s)}`),
        g.lastSay ? h('div.say', null, `“${g.lastSay}”`) : null)) : [h('div.muted', null, 'Nobody is playing right now.')]));
    };
    const renderRecordings = ({ recordings }) => {
      recent.replaceChildren(...(recordings.length ? recordings.map((g) => h('a.row', { href: `/r/${g.id}` }, h('span', null, h('b', null, g.player.name), ` — ${g.game} ${g.map}`), h('span.muted', null, `${g.status} · ${g.kills ?? 0} kills · ${g.turn} turns · ${mmss(g.time_s)} · ${ago(g.endedAt || g.lastActiveAt)} ago`))) : [h('div.muted.small', null, 'None yet.')]));
    };
    api('GET', '/api/games').then(render).catch((e) => main.append(h('p.err', null, e.message)));
    api('GET', '/api/recordings').then(renderRecordings).catch(() => {});
    lobbyWs = openWs('/ws', (m) => { if (m.type === 'list') render(m); });
  }

  // ------------------------------------------------------------ game page
  function gamePage(id) {
    const img = h('img', { alt: 'game view', src: `/api/games/${id}/frame.jpg?${Date.now()}` });
    const overlay = h('div.overlay', null, '…');
    const hud = h('div.hud'), automap = h('img.automap', { alt: 'automap', style: 'display:none' });
    const log = h('div.log'), chat = h('div.chat');
    const input = h('input', { type: 'text', placeholder: me ? `Say something to the player…` : 'Sign in to chat', maxlength: '500', disabled: me ? null : 'disabled' });
    const sendBtn = h('button.primary', { disabled: me ? null : 'disabled' }, 'Send');
    const title = h('h1', null, '…'), sub = h('div.muted.small', null, '');
    const watchersEl = h('span', null, '');
    const stopBtn = h('button', { style: 'display:none', onclick: async () => { if (confirm('Stop this game?')) await api('POST', `/api/games/${id}/stop`).catch((e) => alert(e.message)); } }, 'Stop game');
    main.replaceChildren(
      h('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap' }, h('div', null, title, sub), h('div', null, h('a', { href: '/' }, '← all games'), ' ', stopBtn)),
      h('div.game', null,
        h('div', null, h('div.screen', null, img, overlay), hud, h('div.maps', null, automap)),
        h('div.side', null,
          h('div.panel', null, h('h3', null, h('span', null, 'Turns'), watchersEl), log),
          h('div.panel', null, h('h3', null, 'Chat'), chat, h('div.chatbox', null, input, sendBtn)))));
    let game = null, lastTurnAt = Date.now();
    const send = async () => { const t = input.value.trim(); if (!t) return; input.value = ''; try { await api('POST', `/api/games/${id}/chat`, { text: t }); } catch (e) { alert(e.message); } };
    sendBtn.onclick = send; input.onkeydown = (e) => { if (e.key === 'Enter') send(); };
    const setGame = (g) => {
      game = g;
      title.replaceChildren(`${g.player.name} plays ${g.game} ${g.map}`, ' ', statusBadge(g));
      sub.textContent = `skill ${g.skill} · started ${ago(g.createdAt)} ago · turn ${g.turn}`;
      watchersEl.textContent = `${g.watchers} watching`;
      stopBtn.style.display = me && (me.admin || me.sub === g.player.sub) && g.status === 'running' ? '' : 'none';
      lastTurnAt = g.lastActiveAt;
    };
    const setHud = (last) => {
      const s = (last && last.status) || {};
      const ammo = s.ammo ? Object.entries(s.ammo).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(' · ') : '';
      hud.replaceChildren(
        h('span', null, h('span.k', null, 'health'), h('b', { style: `color:${(s.health ?? 100) < 35 ? 'var(--accent)' : 'var(--ok)'}` }, s.health ?? '–')),
        h('span', null, h('span.k', null, 'armor'), h('b', null, s.armor ?? '–')),
        h('span', null, h('span.k', null, 'weapon'), h('b', null, s.weapon ?? '–'), s.weapon_ammo != null ? ` (${s.weapon_ammo})` : ''),
        ammo ? h('span', null, h('span.k', null, 'ammo'), ammo) : null,
        h('span', null, h('span.k', null, 'kills'), h('b', null, s.kills ?? 0)),
        h('span', null, h('span.k', null, 'items'), h('b', null, s.items ?? 0)),
        h('span', null, h('span.k', null, 'secrets'), h('b', null, s.secrets ?? 0)),
        h('span', null, h('span.k', null, 'time'), mmss(s.time_s)),
        last && last.position ? h('span.muted.small', null, `(${last.position.x}, ${last.position.y}) facing ${last.position.angle}°`) : null);
    };
    const addTurn = (r) => {
      const el = h('div.turn', null,
        r.actions && r.actions.length ? h('div', null, h('span.n', null, `#${r.n}`), h('span.acts', null, r.actions.map(fmtAction).join(' · '))) : null,
        ...(r.events || []).map((e) => h('div.ev.' + evClass(e), null, e)),
        r.say ? h('div.bubble', null, r.say) : null);
      log.append(el); while (log.children.length > 300) log.firstChild.remove();
      log.scrollTop = log.scrollHeight;
    };
    const addChat = (m) => { chat.append(h('div.msg' + (m.from.kind === 'agent' ? '.agent' : ''), null, h('b', null, m.from.name), ': ', m.text)); chat.scrollTop = chat.scrollHeight; };
    const setFrames = (frame, am) => { if (frame) img.src = `data:image/jpeg;base64,${frame}`; if (am) { automap.src = `data:image/jpeg;base64,${am}`; automap.style.display = ''; } };
    setInterval(() => { if (!game) return; overlay.textContent = game.status === 'running' ? `turn ${game.turn} · thinking ${ago(lastTurnAt)}…` : `game ${game.status}`; }, 1000);
    openWs(`/ws?game=${encodeURIComponent(id)}`, (m) => {
      if (m.type === 'hello') { setGame(m.game); setHud(m.last); setFrames(m.frame, m.automap); log.replaceChildren(); (m.log || []).forEach(addTurn); chat.replaceChildren(); (m.chat || []).forEach(addChat); }
      else if (m.type === 'turn') { setGame(m.game); setHud(m.last); setFrames(m.frame, m.automap); addTurn(m.record); }
      else if (m.type === 'chat') addChat(m.message);
      else if (m.type === 'ended') { if (m.game) setGame(m.game); else { title.textContent = 'This game is over.'; } overlay.textContent = 'game over'; sub.append(' · ', h('a', { href: `/r/${id}` }, 'watch the replay')); }
    }, () => { if (game && game.status !== 'running') return false; return true; });
  }

  // ------------------------------------------------------------ replay page
  function replayPage(id) {
    const img = h('img', { alt: 'game view' }), overlay = h('div.overlay', null, '…');
    const hud = h('div.hud'), automap = h('img.automap', { alt: 'automap', style: 'display:none' });
    const log = h('div.log'), chat = h('div.chat');
    const title = h('h1', null, 'Replay'), sub = h('div.muted.small', null, '');
    const slider = h('input', { type: 'range', min: '0', max: '0', value: '0', style: 'flex:1' });
    const playBtn = h('button.primary', null, '▶ Play'), prevBtn = h('button', null, '‹'), nextBtn = h('button', null, '›');
    const counter = h('span.muted.small', null, '');
    const speed = h('select', null, ...[['0.5', '2 s/turn'], ['1', '1 s/turn'], ['2', '½ s/turn']].map(([v, l]) => h('option', { value: v }, l)));
    main.replaceChildren(
      h('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap' }, h('div', null, title, sub), h('a', { href: '/' }, '← all games')),
      h('div.game', null,
        h('div', null, h('div.screen', null, img, overlay),
          h('div.controls', null, prevBtn, playBtn, nextBtn, slider, counter, speed), hud, h('div.maps', null, automap)),
        h('div.side', null, h('div.panel', null, h('h3', null, 'Turns'), log), h('div.panel', null, h('h3', null, 'Chat'), chat))));
    let turns = [], chats = [], cur = -1, timer = null;
    const evBits = (e) => h('div.ev.' + evClass(e), null, e);
    const turnEl = (r) => h('div.turn', null,
      r.actions && r.actions.length ? h('div', null, h('span.n', null, `#${r.n}`), h('span.acts', null, r.actions.map(fmtAction).join(' · '))) : null,
      ...(r.events || []).map(evBits), r.say ? h('div.bubble', null, r.say) : null);
    const show = (i) => {
      if (!turns.length) return;
      cur = Math.max(0, Math.min(turns.length - 1, i));
      const t = turns[cur];
      const f = t.frameIndex;
      if (f != null) { img.src = `/api/recordings/${id}/f/${f}.jpg`; automap.src = `/api/recordings/${id}/m/${f}.jpg`; automap.style.display = ''; }
      slider.value = String(cur); counter.textContent = `${cur + 1} / ${turns.length}`;
      overlay.textContent = `turn ${t.record.n}` + (t.record.at ? ` · ${new Date(t.record.at).toLocaleTimeString()}` : '');
      const s = t.record.status || {};
      const ammo = s.ammo ? Object.entries(s.ammo).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(' · ') : '';
      hud.replaceChildren(
        h('span', null, h('span.k', null, 'health'), h('b', { style: `color:${(s.health ?? 100) < 35 ? 'var(--accent)' : 'var(--ok)'}` }, s.health ?? '–')),
        h('span', null, h('span.k', null, 'armor'), h('b', null, s.armor ?? '–')),
        h('span', null, h('span.k', null, 'weapon'), h('b', null, s.weapon ?? '–'), s.weapon_ammo != null ? ` (${s.weapon_ammo})` : ''),
        ammo ? h('span', null, h('span.k', null, 'ammo'), ammo) : null,
        h('span', null, h('span.k', null, 'kills'), h('b', null, s.kills ?? 0)), h('span', null, h('span.k', null, 'items'), h('b', null, s.items ?? 0)),
        h('span', null, h('span.k', null, 'secrets'), h('b', null, s.secrets ?? 0)), h('span', null, h('span.k', null, 'time'), mmss(s.time_s)),
        t.record.position ? h('span.muted.small', null, `(${t.record.position.x}, ${t.record.position.y}) facing ${t.record.position.angle}°`) : null);
      log.replaceChildren(...turns.slice(Math.max(0, cur - 40), cur + 1).map((x) => turnEl(x.record)));
      log.scrollTop = log.scrollHeight;
      const until = t.record.at || Infinity;
      chat.replaceChildren(...chats.filter((m) => m.at <= until).slice(-60).map((m) => h('div.msg' + (m.from.kind === 'agent' ? '.agent' : ''), null, h('b', null, m.from.name), ': ', m.text)));
      chat.scrollTop = chat.scrollHeight;
    };
    const stop = () => { if (timer) clearInterval(timer); timer = null; playBtn.textContent = '▶ Play'; };
    const play = () => { if (cur >= turns.length - 1) show(0); timer = setInterval(() => { if (cur >= turns.length - 1) stop(); else show(cur + 1); }, 1000 / Number(speed.value)); playBtn.textContent = '❚❚ Pause'; };
    playBtn.onclick = () => (timer ? stop() : play());
    prevBtn.onclick = () => { stop(); show(cur - 1); }; nextBtn.onclick = () => { stop(); show(cur + 1); };
    slider.oninput = () => { stop(); show(Number(slider.value)); };
    speed.onchange = () => { if (timer) { stop(); play(); } };
    document.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') prevBtn.onclick(); else if (e.key === 'ArrowRight') nextBtn.onclick(); else if (e.key === ' ') { e.preventDefault(); playBtn.onclick(); } });
    api('GET', `/api/recordings/${id}`).then(({ meta, live, events }) => {
      title.replaceChildren(`${meta.player.name} — ${meta.game} ${meta.map}`, ' ', statusBadge(meta), live ? h('a', { href: `/g/${id}`, style: 'margin-left:8px;font-size:14px' }, 'this game is live — watch it') : null);
      sub.textContent = `skill ${meta.skill} · ${meta.turn} turns · ${meta.kills ?? 0} kills · ${mmss(meta.time_s)} · ${new Date(meta.createdAt).toLocaleString()}`;
      let lastFrame = null;
      for (const e of events) {
        if (e.type === 'turn') { if (e.frame != null) lastFrame = e.frame; turns.push({ record: e.record, frameIndex: lastFrame }); }
        else if (e.type === 'chat') chats.push(e.message);
      }
      slider.max = String(Math.max(0, turns.length - 1));
      show(turns.length - 1);
    }).catch((e) => { title.textContent = 'No recording'; sub.textContent = e.message; });
  }

  function openWs(path, onMessage, shouldReconnect = () => true) {
    let ws, closed = false, delay = 1000;
    const connect = () => {
      ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}${path}`);
      ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); } };
      ws.onopen = () => { delay = 1000; };
      ws.onclose = (e) => { if (closed || e.code === 4004 || e.code === 4001 || !shouldReconnect()) return; setTimeout(connect, delay); delay = Math.min(15000, delay * 2); };
    };
    connect();
    return { close: () => { closed = true; ws && ws.close(); } };
  }

  // ------------------------------------------------------------ router
  async function route() {
    try { await loadMe(); } catch (e) { main.replaceChildren(h('p.err', null, e.message)); return; }
    if (location.pathname === '/auth/callback') return handleCallback();
    if (!me) return signinPage();
    const g = /^\/g\/([a-z0-9]+)$/.exec(location.pathname);
    if (g) return gamePage(g[1]);
    const r = /^\/r\/([a-z0-9]+)$/.exec(location.pathname);
    if (r) return replayPage(r[1]);
    return lobbyPage();
  }
  route();
})();
