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
        h('p.muted', null, 'Agents play Doom one turn at a time; people watch, and talk to them while they play. And Go: against the bot, an agent, or each other.'),
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
    const goCards = h('div.cards'), goForm = h('div');
    const newGo = h('button.primary', { onclick: () => { if (goForm.firstChild) goForm.replaceChildren(); else goForm.replaceChildren(newGoForm()); } }, 'New game');
    main.replaceChildren(
      h('h1', null, 'Playing now'), h('p.muted.small', null, 'Each game moves only when its player acts — a turn every few seconds to a minute. Click one to watch.'), live,
      h('div.section-head', null, h('h2', null, 'Go'), newGo),
      h('p.muted.small', null, 'Play against the bot, an agent, or another person. Join a game that is waiting, or start one and share its code.'),
      goForm, goCards,
      h('h2', null, 'Recordings'), h('p.muted.small', null, 'Every game is recorded turn by turn; open one to replay it.'), recent);
    const renderGo = ({ waiting, playing, finished }) => {
      const all = [...waiting, ...playing, ...finished];
      goCards.replaceChildren(...(all.length ? all.map(goCard) : [h('div.muted', null, 'No Go games right now.')]));
    };
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
    api('GET', '/api/go').then(renderGo).catch(() => {});
    lobbyWs = openWs('/ws', (m) => { if (m.type === 'list') render(m); else if (m.type === 'golist') renderGo(m); });
  }

  // ------------------------------------------------------------ Go: lobby cards, new game
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const dot = (c) => h('span.dot.' + c);
  const goJoin = async (code) => { try { await api('POST', `/api/go/${code}/join`); location.href = `/go/${code}`; } catch (e) { alert(e.message); } };
  const goResult = (r) => {
    if (!r) return '';
    if (r === 'withdrawn') return 'Withdrawn';
    const m = /^([BW])\+(.+)$/.exec(r);
    if (!m) return r;
    const who = m[1] === 'B' ? 'Black' : 'White';
    return m[2] === 'R' ? `${who} wins by resignation` : m[2] === 'F' ? `${who} wins by forfeit` : `${who} wins by ${m[2]}`;
  };
  function goCard(g) {
    const badge = g.yourTurn ? h('span.badge.live', null, 'your move') : g.you ? h('span.badge', null, 'you') : g.phase === 'waiting' ? h('span.badge.complete', null, 'open') : g.phase === 'over' ? h('span.badge', null, 'over') : h('span.badge.live', null, 'live');
    const what = g.phase === 'waiting' ? 'waiting for an opponent' : g.phase === 'over' ? goResult(g.result) : g.phase === 'scoring' ? 'scoring' : `move ${g.moves} · ${g.toMove} to play`;
    return h('a.card', { href: `/go/${g.code}` },
      h('div.who', null, h('span', null, dot('black'), g.black || 'open seat', h('span.muted', null, ' vs '), dot('white'), g.white || 'open seat'), badge),
      h('div.what', null, `${g.size}×${g.size} · ${what} · ${ago(g.updatedAt)} ago`),
      g.joinable ? h('button.primary', { onclick: (e) => { e.preventDefault(); e.stopPropagation(); goJoin(g.code); } }, `Join as ${g.black ? 'White' : 'Black'}`) : null);
  }
  function newGoForm() {
    const sel = (opts, val) => { const s = h('select', null, ...opts.map(([v, l]) => h('option', { value: v }, l))); s.value = val; return s; };
    const size = sel([['9', '9×9'], ['13', '13×13'], ['19', '19×19']], '9');
    const opp = sel([['bot', 'the bot'], ['agent', 'anyone — share the code']], 'bot');
    const level = sel([['easy', 'easy'], ['medium', 'medium'], ['hard', 'hard']], 'medium');
    const color = sel([['black', 'black (first move)'], ['white', 'white'], ['random', 'random']], 'black');
    const komi = h('input', { type: 'number', value: '7.5', min: '0', max: '15', step: '0.5' });
    const levelWrap = h('label', null, 'Bot strength', level);
    opp.onchange = () => { levelWrap.style.display = opp.value === 'bot' ? '' : 'none'; };
    const err = h('span.err.small');
    const start = h('button.primary', { onclick: async () => {
      start.disabled = true; err.textContent = '';
      try {
        const r = await api('POST', '/api/go', { size: Number(size.value), opponent: opp.value, level: level.value, color: color.value, komi: Number(komi.value) });
        location.href = `/go/${r.state.code}`;
      } catch (e) { err.textContent = e.message; start.disabled = false; }
    } }, 'Start');
    return h('div.panel.goform', null, h('label', null, 'Board', size), h('label', null, 'Opponent', opp), levelWrap, h('label', null, 'You play', color), h('label', null, 'Komi', komi), start, err);
  }

  // ------------------------------------------------------------ Go: the board page
  const SVGNS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs, ...kids) => {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
    for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k)));
    return el;
  };
  const GO_LETTERS = 'ABCDEFGHJKLMNOPQRST';
  const STARS = { 9: [[2, 2], [6, 2], [2, 6], [6, 6], [4, 4]], 13: [[3, 3], [9, 3], [3, 9], [9, 9], [6, 6]], 19: [3, 9, 15].flatMap((x) => [3, 9, 15].map((y) => [x, y])) };
  const GO_BUTTONS = { go_pass: 'pass', go_undo: 'undo', go_accept: 'accept', go_resume: 'resume', go_rematch: 'rematch', go_resign: 'resign', go_cancel: 'cancel' };
  const GO_CONFIRM = { go_resign: 'Resign this game?', go_cancel: 'Withdraw this game?' };

  function goPage(code) {
    const title = h('h1', null, 'Go'), sub = h('div.muted.small', null, '');
    const boardBox = h('div.goboard'), seatsEl = h('div'), statusEl = h('div.gostatus'), actionsEl = h('div.goactions'), errEl = h('div.err.small.goerr');
    const movesEl = h('div.gomoves'), noteEl = h('div.small.muted.gonote');
    const sgf = h('a', { href: `/api/go/${code}/sgf`, style: 'text-transform:none;letter-spacing:0' }, 'SGF');
    main.replaceChildren(
      h('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap' }, h('div', null, title, sub), h('a', { href: '/' }, '← all games')),
      h('div.game.go', null,
        h('div', null, boardBox),
        h('div.side', null,
          h('div.panel', null, seatsEl, statusEl, actionsEl, errEl),
          h('div.panel', null, h('h3', null, h('span', null, 'Moves'), sgf), movesEl),
          noteEl)));
    let st = null, busy = false, touchPick = null;
    const can = (tool) => !busy && st && st.actions.includes(tool);
    const ptName = (p) => GO_LETTERS[p % st.size] + (st.size - Math.floor(p / st.size));

    const act = async (action, body) => {
      if (busy) return;
      busy = true; errEl.textContent = ''; render();
      try {
        const r = await api('POST', `/api/go/${code}/${action}`, body);
        if (!r.state) { location.href = '/'; return; }
        st = r.state;
        if (action === 'rematch' && st.rematch) { location.href = `/go/${st.rematch}`; return; }
      } catch (e) { errEl.textContent = e.message; }
      busy = false; touchPick = null; render();
    };

    function drawBoard() {
      const n = st.size, S = n + 1, me = st.you;
      const playable = can('go_play'), markable = can('go_mark_dead');
      const dead = new Set(st.dead);
      const el = sv('svg', { viewBox: `0 0 ${S} ${S}`, class: playable ? 'playable' : markable ? 'markable' : null, role: 'img', 'aria-label': `Go board, ${n} by ${n}` },
        sv('defs', null,
          sv('radialGradient', { id: 'gs-b', cx: '35%', cy: '30%', r: '70%' }, sv('stop', { offset: '0%', 'stop-color': '#5d5d5d' }), sv('stop', { offset: '100%', 'stop-color': '#0b0b0b' })),
          sv('radialGradient', { id: 'gs-w', cx: '35%', cy: '30%', r: '75%' }, sv('stop', { offset: '0%', 'stop-color': '#ffffff' }), sv('stop', { offset: '100%', 'stop-color': '#c9c6bf' }))),
        sv('rect', { class: 'wood', x: 0, y: 0, width: S, height: S, rx: 0.25 }));
      for (let i = 1; i <= n; i++) {
        el.append(sv('line', { class: 'ln', x1: 1, y1: i, x2: n, y2: i }), sv('line', { class: 'ln', x1: i, y1: 1, x2: i, y2: n }));
        const col = GO_LETTERS[i - 1], row = String(n - i + 1);
        el.append(sv('text', { class: 'coord', x: i, y: 0.42 }, col), sv('text', { class: 'coord', x: i, y: S - 0.42 }, col),
          sv('text', { class: 'coord', x: 0.42, y: i }, row), sv('text', { class: 'coord', x: S - 0.42, y: i }, row));
      }
      for (const [x, y] of STARS[n] || []) el.append(sv('circle', { class: 'star', cx: x + 1, cy: y + 1, r: 0.09 }));
      const at = (p) => [(p % n) + 1, Math.floor(p / n) + 1];
      if (st.owner) st.owner.forEach((o, p) => {
        if (!o || (st.board[p] && !dead.has(p))) return;
        const [x, y] = at(p);
        el.append(sv('rect', { class: o === 1 ? 'terr-b' : 'terr-w', x: x - 0.16, y: y - 0.16, width: 0.32, height: 0.32 }));
      });
      st.board.forEach((c, p) => {
        if (!c) return;
        const [x, y] = at(p);
        el.append(sv('circle', { class: 'stone' + (dead.has(p) ? ' dead' : ''), cx: x, cy: y, r: 0.47, fill: c === 1 ? 'url(#gs-b)' : 'url(#gs-w)', stroke: c === 2 ? '#8d8a83' : null, 'stroke-width': c === 2 ? 0.02 : null }));
      });
      const last = st.moves[st.moves.length - 1];
      if (last && last.p != null && st.board[last.p]) {
        const [x, y] = at(last.p);
        el.append(sv('circle', { class: 'lastmv', cx: x, cy: y, r: 0.19, stroke: st.board[last.p] === 1 ? '#f0f0f0' : '#222' }));
      }
      const ghost = sv('circle', { class: 'ghost', r: 0.47, fill: me === 'white' ? 'url(#gs-w)' : 'url(#gs-b)', visibility: 'hidden' });
      el.append(ghost);
      const showGhost = (p) => {
        if (p == null || !playable || st.board[p]) { ghost.setAttribute('visibility', 'hidden'); return; }
        const [x, y] = at(p); ghost.setAttribute('cx', x); ghost.setAttribute('cy', y); ghost.setAttribute('visibility', 'visible');
      };
      const pointAt = (e) => {
        const r = el.getBoundingClientRect();
        const x = Math.round(((e.clientX - r.left) / r.width) * S) - 1, y = Math.round(((e.clientY - r.top) / r.height) * S) - 1;
        return x >= 0 && y >= 0 && x < n && y < n ? y * n + x : null;
      };
      if (touchPick != null) showGhost(touchPick);
      let pointer = 'mouse';
      el.addEventListener('pointerdown', (e) => { pointer = e.pointerType || 'mouse'; });
      el.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') showGhost(pointAt(e)); });
      el.addEventListener('pointerleave', () => { if (touchPick == null) showGhost(null); });
      el.addEventListener('click', (e) => {
        const p = pointAt(e);
        if (p == null) return;
        if (playable && !st.board[p]) {
          // A tap shows the stone first and a second tap on it plays: fingers miss by a line.
          if (pointer !== 'mouse' && touchPick !== p) { touchPick = p; showGhost(p); return; }
          act('play', { point: ptName(p) });
        } else if (markable && st.board[p]) act('mark', { points: [ptName(p)] });
      });
      boardBox.replaceChildren(el);
    }

    function seatRow(c) {
      const s = st.seats[c];
      const turn = st.phase === 'playing' && st.toMove === c;
      return h('div.goseat' + (turn ? '.turn' : ''), null,
        h('span.stoneicon.' + c),
        h('span.nm', null, s ? s.name : h('span.muted', null, 'open seat'), st.you === c ? ' (you)' : '', s && s.kind === 'agent' ? h('span.tag', null, 'agent') : null),
        st.phase === 'scoring' && st.accepted.includes(c) ? h('span.badge.live', null, 'accepted') : null,
        turn ? h('span.badge.live', null, st.thinking ? 'thinking…' : 'to move') : null,
        h('span.muted.small', null, `captures ${st.captures[c]}`));
    }

    function statusLine() {
      const last = st.moves[st.moves.length - 1];
      const lastTxt = last ? `${cap(last.color)} ${last.point === null ? 'passed' : `played ${last.point}${last.captured ? `, capturing ${last.captured}` : ''}`}. ` : '';
      const mine = st.you && st.toMove === st.you;
      switch (st.phase) {
        case 'waiting':
          return st.you
            ? ['Waiting for an opponent. Anyone signed in here can join from the Go list; an agent joins with ', h('code', null, `{join: "${st.code}"}`), ' on the go toolset.']
            : ['This game is waiting for an opponent.'];
        case 'playing':
          return [lastTxt, mine ? h('b', null, 'Your move.') : st.thinking ? 'The bot is thinking…' : `${cap(st.toMove)} to move.`, mine && st.passes === 1 ? ' Pass too to end play.' : ''];
        case 'scoring':
          return ['Both passed: scoring. ', can('go_mark_dead') ? 'Click a group to mark it dead or alive. ' : '', st.score ? st.score.text : '', st.accepted.length ? ` Accepted: ${st.accepted.map(cap).join(', ')}.` : ''];
        case 'over':
          return [h('b', null, goResult(st.result)), '. ', st.score ? st.score.text : ''];
      }
      return [];
    }

    function render() {
      if (!st) return;
      const nm = (c) => (st.seats[c] ? st.seats[c].name : 'open seat');
      title.textContent = `${nm('black')} vs ${nm('white')}`;
      sub.textContent = `Go ${st.size}×${st.size} · komi ${st.komi} · code ${st.code} · started ${ago(st.createdAt)} ago`;
      const yourTurn = st.actions.includes('go_play') || st.actions.includes('go_accept');
      document.title = `${yourTurn ? '● Your move · ' : ''}Go ${st.code} · Archipelago Games`;
      drawBoard();
      seatsEl.replaceChildren(seatRow('black'), seatRow('white'));
      statusEl.replaceChildren(...statusLine());
      const buttons = [];
      if (st.joinable) buttons.push(h('button.primary', { disabled: busy ? 'disabled' : null, onclick: async () => {
        busy = true; render();
        try { st = (await api('POST', `/api/go/${code}/join`)).state; } catch (e) { errEl.textContent = e.message; }
        busy = false; render();
      } }, `Join as ${st.seats.black ? 'White' : 'Black'}`));
      const vsBot = ['black', 'white'].some((c) => st.seats[c] && st.seats[c].kind === 'bot');
      const label = { go_pass: 'Pass', go_undo: 'Undo', go_accept: 'Accept score', go_resume: 'Resume play', go_resign: 'Resign', go_cancel: 'Withdraw', go_rematch: vsBot ? 'Play again' : st.rematch ? 'Accept rematch' : 'Offer rematch' };
      for (const t of st.actions) {
        if (!GO_BUTTONS[t]) continue;
        buttons.push(h(t === 'go_accept' || t === 'go_rematch' ? 'button.primary' : 'button', { disabled: busy ? 'disabled' : null, onclick: () => { if (!GO_CONFIRM[t] || confirm(GO_CONFIRM[t])) act(GO_BUTTONS[t]); } }, label[t]));
      }
      if (st.rematch && (st.left || !st.actions.includes('go_rematch'))) buttons.push(h('a', { href: `/go/${st.rematch}` }, 'Go to the rematch →'));
      actionsEl.replaceChildren(...buttons);
      actionsEl.style.display = buttons.length ? '' : 'none';
      movesEl.replaceChildren(...(st.moves.length ? st.moves.map((m, i) => h('span.mv', null, h('span.n', null, `${i + 1}.`), dot(m.color), m.point || 'pass')) : [h('span.muted', null, 'No moves yet.')]));
      movesEl.scrollTop = movesEl.scrollHeight;
      noteEl.textContent = !st.live ? 'This game is finished and archived.' : st.you ? '' : st.phase === 'waiting' ? '' : 'You are watching. The board updates as they play.';
    }

    api('GET', `/api/go/${code}`).then((r) => { st = r.state; render(); }).catch((e) => { title.textContent = 'No such game'; sub.textContent = e.message; });
    openWs(`/ws?go=${encodeURIComponent(code)}`, (m) => {
      if (m.type === 'go') { st = m.state; render(); }
      else if (m.type === 'go-gone') { title.textContent = 'This game is gone'; sub.textContent = 'It was withdrawn before anyone joined.'; boardBox.replaceChildren(); actionsEl.replaceChildren(); }
    });
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
      title.replaceChildren(...[`${meta.player.name} — ${meta.game} ${meta.map}`, ' ', statusBadge(meta), live ? h('a', { href: `/g/${id}`, style: 'margin-left:8px;font-size:14px' }, 'this game is live — watch it') : null].filter(Boolean));
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
    const go = /^\/go\/([0-9A-Fa-f]{6})$/.exec(location.pathname);
    if (go) return goPage(go[1].toUpperCase());
    return lobbyPage();
  }
  route();
})();
