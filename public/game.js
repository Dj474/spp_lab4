'use strict';

(function () {
  const CELL = 32;

  const $ = (sel) => document.querySelector(sel);
  const ui = {
    canvas: $('#game'),
    status: $('#status'),
    statusText: $('#statusText'),
    myScore: $('#myScore'),
    board: $('#board'),
    onlineCount: $('#onlineCount'),
    beaconInfo: $('#beaconInfo'),
    connState: $('#connState'),
    rtt: $('#rtt'),
    seq: $('#seq'),
    pending: $('#pending'),
    toasts: $('#toasts'),
    overlay: $('#join'),
    joinForm: $('#joinForm'),
    name: $('#name'),
    offlineBar: $('#offlineBar'),
    changePlayer: $('#changePlayer')
  };
  const ctx = ui.canvas.getContext('2d');

  const store = {
    get token() { return localStorage.getItem('arena.token') || ''; },
    set token(v) { v ? localStorage.setItem('arena.token', v) : localStorage.removeItem('arena.token'); },
    get name() { return localStorage.getItem('arena.name') || ''; },
    set name(v) { v ? localStorage.setItem('arena.name', v) : localStorage.removeItem('arena.name'); },
    saveCache(obj) {
      try { localStorage.setItem('arena.cache', JSON.stringify(obj)); } catch (err) { /* переполнение */ }
    },
    loadCache() {
      try { return JSON.parse(localStorage.getItem('arena.cache') || 'null'); } catch (err) { return null; }
    }
  };

  const S = {
    w: 20,
    h: 16,
    rocks: [],
    rockSet: new Set(),
    coins: [],
    beacon: { x: 0, y: 0, owner: null, version: 1 },
    players: {},
    youId: null,
    seq: 0
  };

  let ws = null;
  let connected = false;
  let backoff = 500;
  let reconnectTimer = null;
  let pingTimer = null;
  let pingSentAt = 0;
  let lastRtt = null;
  let resumeInFlight = false;
  let lastConflictAt = 0;
  const pendingItems = new Map();
  const pendingMoves = [];
  let cacheTimer = null;

  const uid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'op-' + Math.random().toString(16).slice(2) + Date.now());

  /* ---------------------------------------------------------------- рендер */

  function hydrate(p) {
    const prev = S.players[p.id];
    return {
      ...p,
      rx: prev ? prev.rx : p.x,
      ry: prev ? prev.ry : p.y
    };
  }

  function applySnapshot(st, youId) {
    if (!st) return;
    S.w = st.w;
    S.h = st.h;
    S.rocks = st.rocks || [];
    S.rockSet = new Set(S.rocks.map((r) => r.x + ',' + r.y));
    S.coins = (st.coins || []).map((c) => ({ ...c }));
    S.beacon = { ...st.beacon };
    S.players = {};
    for (const p of st.players || []) S.players[p.id] = hydrate(p);
    if (youId) S.youId = youId;
    S.seq = st.seq || 0;
    ui.canvas.width = S.w * CELL;
    ui.canvas.height = S.h * CELL;
    persistSoon();
    refreshHud();
  }

  function upsertPlayer(p, onlineFallback) {
    const current = S.players[p.id];
    if (!current) {
      S.players[p.id] = hydrate({ ...p, online: p.online !== false });
      return S.players[p.id];
    }
    current.name = p.name;
    current.color = p.color;
    current.x = p.x;
    current.y = p.y;
    current.score = p.score;
    current.version = p.version;
    current.online = p.online !== false;
    return current;
  }

  function applyEvent(ev) {
    if (typeof ev.seq === 'number') {
      if (ev.seq <= S.seq) return;
      if (ev.seq > S.seq + 1) requestSync();
      S.seq = ev.seq;
    }
    const me = () => S.players[S.youId];

    switch (ev.k) {
      case 'player':
        upsertPlayer(ev.p);
        break;
      case 'moved': {
        const p = S.players[ev.id];
        if (!p) { requestSync(); break; }
        p.x = ev.x;
        p.y = ev.y;
        p.version = ev.version;
        if (ev.id === S.youId) ackMove(ev.op);
        break;
      }
      case 'coinTaken': {
        S.coins = S.coins.filter((c) => c.id !== ev.coinId);
        const scorer = S.players[ev.by];
        if (scorer) scorer.score = ev.score;
        if (ev.by === S.youId) {
          ackItem(ev.op);
          toast('Монета собрана (+1)', 'info');
        }
        break;
      }
      case 'coinSpawned':
        if (ev.coin && !S.coins.some((c) => c.id === ev.coin.id)) S.coins.push({ ...ev.coin });
        break;
      case 'beacon': {
        S.beacon = { ...ev.beacon };
        const captor = S.players[ev.by];
        if (captor) captor.score = ev.score;
        if (ev.by === S.youId) {
          ackItem(ev.op);
          toast('Маяк захвачен! (+5)', 'info');
        }
        break;
      }
      default:
        break;
    }
    persistSoon();
    refreshHud();
  }

  function requestSync() {
    if (connected) send({ t: 'sync' });
  }

  /* ------------------------------------------------------------- операции */

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function sendItemOp(op) {
    pendingItems.set(op.opId, op);
    send(op);
    refreshHud();
  }

  function ackItem(opId) {
    if (opId) pendingItems.delete(opId);
    refreshHud();
  }

  function ackMove(opId) {
    if (!opId) return;
    const index = pendingMoves.indexOf(opId);
    if (index >= 0) pendingMoves.splice(index, 1);
  }

  function localCellBlocked(x, y, excludeId) {
    if (x < 0 || y < 0 || x >= S.w || y >= S.h) return 'Упёрлись в границу арены';
    if (S.rockSet.has(x + ',' + y)) return 'На пути препятствие';
    for (const p of Object.values(S.players)) {
      if (p.id !== excludeId && p.online !== false && p.x === x && p.y === y) {
        if (!(x === S.beacon.x && y === S.beacon.y)) return 'Клетку занял ' + p.name;
      }
    }
    return null;
  }

  function tryMove(dx, dy) {
    if (!connected) return;
    const me = S.players[S.youId];
    if (!me) return;
    const reason = localCellBlocked(me.x + dx, me.y + dy, me.id);
    if (reason) {
      if (reason.indexOf('занял') === -1) toast(reason, 'conflict');
      return;
    }
    const op = { t: 'move', opId: uid(), fx: me.x, fy: me.y, dx, dy };
    me.x += dx;
    me.y += dy;
    pendingMoves.push(op.opId);
    send(op);
    refreshHud();
  }

  function doAction() {
    if (!connected) return;
    const me = S.players[S.youId];
    if (!me) return;

    const coin = S.coins.find((c) => c.x === me.x && c.y === me.y);
    if (coin) {
      sendItemOp({ t: 'take', opId: uid(), coinId: coin.id, baseVersion: coin.version });
      return;
    }
    if (me.x === S.beacon.x && me.y === S.beacon.y) {
      if (S.beacon.owner === S.youId) { toast('Маяк уже под вашим контролем', 'info'); return; }
      sendItemOp({ t: 'capture', opId: uid(), baseVersion: S.beacon.version });
      return;
    }
    toast('Здесь нет объекта: встаньте на монету или на маяк', 'info');
  }

  function onConflict(msg) {
    const now = Date.now();
    const silent = now - lastConflictAt < 400;
    lastConflictAt = now;

    if (msg.kind === 'move') {
      pendingMoves.length = 0;
      if (msg.player && S.players[msg.player.id]) {
        const p = S.players[msg.player.id];
        p.x = msg.player.x;
        p.y = msg.player.y;
        p.version = msg.player.version;
      }
      if (!silent) toast('Конфликт перемещения: ' + msg.reason, 'conflict');
    } else if (msg.kind === 'coin') {
      if (msg.coin) {
        const existing = S.coins.find((c) => c.id === msg.coinId);
        if (existing) Object.assign(existing, msg.coin);
      } else {
        S.coins = S.coins.filter((c) => c.id !== msg.coinId);
      }
      ackItem(msg.opId);
      if (!silent) toast('Конфликт: ' + msg.reason, 'conflict');
    } else if (msg.kind === 'beacon') {
      if (msg.beacon) S.beacon = { ...msg.beacon };
      ackItem(msg.opId);
      if (!silent) toast('Конфликт: ' + msg.reason, 'conflict');
    }
    persistSoon();
    refreshHud();
  }

  /* ----------------------------------------------------------------- сеть */

  function setStatus(kind, text) {
    ui.status.className = 'status ' + kind;
    ui.statusText.textContent = text;
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    setStatus('connecting', 'подключение...');
    ui.connState.textContent = 'подключение';

    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);

    ws.onopen = () => {
      connected = true;
      backoff = 500;
      ui.offlineBar.classList.add('hidden');
      setStatus('online', 'онлайн');
      ui.connState.textContent = 'онлайн';
      if (store.token) {
        resumeInFlight = true;
        send({ t: 'resume', token: store.token, lastSeq: S.seq });
        retryPendingItems();
      } else {
        send({ t: 'join', name: store.name });
      }
      startPing();
    };

    ws.onmessage = (raw) => {
      let msg = null;
      try { msg = JSON.parse(raw.data); } catch (err) { return; }
      handleMessage(msg);
    };

    ws.onclose = () => {
      if (connected) toast('Соединение потеряно. Состояние сохранено локально.', 'conflict');
      connected = false;
      pendingMoves.length = 0;
      ui.offlineBar.classList.remove('hidden');
      setStatus('offline', 'нет связи');
      ui.connState.textContent = 'переподключение';
      stopPing();
      scheduleReconnect();
    };

    ws.onerror = () => { /* обработка в onclose */ };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, 8000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function retryPendingItems() {
    if (!pendingItems.size) return;
    for (const op of pendingItems.values()) send(op);
  }

  function handleMessage(msg) {
    switch (msg.t) {
      case 'welcome':
        store.token = msg.token;
        applySnapshot(msg.state, msg.youId);
        toast('Вы в игре, ' + (store.name || 'игрок'), 'info');
        break;
      case 'rejoin':
        store.token = '';
        send({ t: 'join', name: store.name });
        break;
      case 'state':
        applySnapshot(msg.state, msg.youId);
        resumeInFlight = false;
        break;
      case 'replay': {
        for (const ev of msg.events || []) applyEvent(ev);
        if (msg.you) upsertPlayer(msg.you);
        if (typeof msg.seq === 'number') S.seq = msg.seq;
        resumeInFlight = false;
        persistSoon();
        refreshHud();
        break;
      }
      case 'ev':
        applyEvent(msg);
        break;
      case 'conflict':
        onConflict(msg);
        break;
      case 'pong':
        lastRtt = Math.max(0, Date.now() - msg.ts);
        ui.rtt.textContent = lastRtt + ' мс';
        break;
      case 'superseded':
        toast('Сессия открыта в другой вкладке — эта вкладка отключена.', 'conflict');
        store.token = '';
        break;
      default:
        break;
    }
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(() => {
      pingSentAt = Date.now();
      send({ t: 'ping', ts: pingSentAt });
      refreshHud();
    }, 2500);
  }

  function stopPing() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  /* --------------------------------------------------------- сохранение/UI */

  function persistSoon() {
    if (cacheTimer) return;
    cacheTimer = setTimeout(() => {
      cacheTimer = null;
      persist();
    }, 400);
  }

  function persist() {
    store.saveCache({
      seq: S.seq,
      w: S.w,
      h: S.h,
      rocks: S.rocks,
      coins: S.coins,
      beacon: S.beacon,
      players: Object.values(S.players).map((p) => ({
        id: p.id, name: p.name, color: p.color, x: p.x, y: p.y,
        score: p.score, version: p.version, online: p.online
      })),
      youId: S.youId
    });
  }

  function refreshHud() {
    const me = S.players[S.youId];
    ui.myScore.textContent = me ? me.score : 0;
    ui.seq.textContent = S.seq;
    ui.pending.textContent = pendingItems.size + pendingMoves.length;

    const list = Object.values(S.players).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const online = list.filter((p) => p.online !== false).length;
    ui.onlineCount.textContent = online + '/' + list.length;

    ui.board.innerHTML = '';
    for (const p of list) {
      const li = document.createElement('li');
      if (p.id === S.youId) li.classList.add('me');
      if (p.online === false) li.classList.add('off');
      li.innerHTML = '<span class="dot" style="background:' + p.color + '"></span>'
        + '<span class="name"></span><span class="pts">' + p.score + '</span>';
      li.querySelector('.name').textContent = (p.id === S.youId ? '★ ' : '') + p.name;
      ui.board.appendChild(li);
    }

    const owner = S.beacon.owner ? S.players[S.beacon.owner] : null;
    ui.beaconInfo.innerHTML = owner
      ? 'захвачен: <b style="color:' + owner.color + '">' + owner.name + '</b>'
      : 'нейтральный — встаньте на маяк и нажмите E';
  }

  function toast(text, kind) {
    const div = document.createElement('div');
    div.className = 'toast ' + (kind || '');
    div.textContent = text;
    ui.toasts.appendChild(div);
    while (ui.toasts.children.length > 5) ui.toasts.removeChild(ui.toasts.firstChild);
    setTimeout(() => {
      div.classList.add('fade');
      setTimeout(() => div.remove(), 320);
    }, 3200);
  }

  /* ------------------------------------------------------------------- ввод */

  const DIRS = {
    w: [0, -1], arrowup: [0, -1], ц: [0, -1],
    s: [0, 1], arrowdown: [0, 1], ы: [0, 1],
    a: [-1, 0], arrowleft: [-1, 0], ф: [-1, 0],
    d: [1, 0], arrowright: [1, 0], в: [1, 0]
  };
  let lastMoveAt = 0;

  window.addEventListener('keydown', (e) => {
    if (document.activeElement === ui.name || ui.overlay.classList.contains('hidden') === false) return;
    const key = e.key.toLowerCase();
    if (key === 'e' || key === ' ' || key === 'spacebar' || key === 'у' || key === 'enter') {
      e.preventDefault();
      doAction();
      return;
    }
    const dir = DIRS[key];
    if (!dir) return;
    e.preventDefault();
    const now = Date.now();
    if (now - lastMoveAt < 70) return;
    lastMoveAt = now;
    tryMove(dir[0], dir[1]);
  }, { passive: false });

  window.addEventListener('beforeunload', persist);

  /* -------------------------------------------------------------- канвас */

  function frame() {
    draw();
    updateHint();
    requestAnimationFrame(frame);
  }

  function draw() {
    const { width: cw, height: ch } = ui.canvas;
    ctx.clearRect(0, 0, cw, ch);

    for (let y = 0; y < S.h; y++) {
      for (let x = 0; x < S.w; x++) {
        ctx.fillStyle = (x + y) % 2 ? '#141930' : '#111529';
        ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      }
    }

    const owner = S.beacon.owner ? S.players[S.beacon.owner] : null;
    const bx = S.beacon.x * CELL + CELL / 2;
    const by = S.beacon.y * CELL + CELL / 2;
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 300);

    ctx.save();
    ctx.beginPath();
    ctx.arc(bx, by, CELL * (0.62 + 0.08 * pulse), 0, Math.PI * 2);
    ctx.fillStyle = owner ? owner.color + '33' : 'rgba(255,230,109,0.16)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(bx, by, CELL * 0.42, 0, Math.PI * 2);
    ctx.fillStyle = owner ? owner.color : '#ffe66d';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.stroke();
    ctx.fillStyle = '#101427';
    ctx.font = 'bold 11px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('МАЯК', bx, by + 0.5);
    ctx.restore();

    for (const rock of S.rocks) {
      roundRect(rock.x * CELL + 2, rock.y * CELL + 2, CELL - 4, CELL - 4, 6, '#39406b');
      roundRect(rock.x * CELL + 6, rock.y * CELL + 6, CELL - 12, CELL - 12, 4, '#4b5488');
    }

    const t = Date.now();
    for (const coin of S.coins) {
      const cx = coin.x * CELL + CELL / 2;
      const cy = coin.y * CELL + CELL / 2 + Math.sin(t / 320 + coin.x * 1.7 + coin.y) * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 9, 0, Math.PI * 2);
      ctx.fillStyle = '#e9b949';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffe66d';
      ctx.fill();
      ctx.fillStyle = '#8a6a11';
      ctx.font = 'bold 8px Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('₽', cx, cy + 0.5);
    }

    for (const p of Object.values(S.players)) {
      p.rx += (p.x - p.rx) * 0.35;
      p.ry += (p.y - p.ry) * 0.35;
      if (Math.abs(p.x - p.rx) < 0.01) p.rx = p.x;
      if (Math.abs(p.y - p.ry) < 0.01) p.ry = p.y;

      const px = p.rx * CELL + CELL / 2;
      const py = p.ry * CELL + CELL / 2;
      ctx.globalAlpha = p.online === false ? 0.45 : 1;

      ctx.beginPath();
      ctx.arc(px, py, 11, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
      ctx.lineWidth = p.id === S.youId ? 3 : 1.5;
      ctx.strokeStyle = p.id === S.youId ? '#ffffff' : 'rgba(255,255,255,0.5)';
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(p.name, px, py - 15);

      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      const wt = Math.max(14, ctx.measureText(String(p.score)).width + 8);
      roundRect(px - wt / 2, py + 13, wt, 14, 4, 'rgba(0,0,0,0.55)');
      ctx.fillStyle = '#ffe66d';
      ctx.font = 'bold 10px Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(p.score), px, py + 20.5);

      ctx.globalAlpha = 1;
    }

    if (!connected) {
      ctx.fillStyle = 'rgba(10,12,22,0.35)';
      ctx.fillRect(0, 0, cw, ch);
    }
  }

  function updateHint() {
    const me = S.players[S.youId];
    if (!me || !connected) return;
    const hasCoin = S.coins.some((c) => c.x === me.x && c.y === me.y);
    const onBeacon = me.x === S.beacon.x && me.y === S.beacon.y;
    ui.canvas.style.boxShadow = hasCoin
      ? '0 0 0 2px #ffe66d, 0 18px 40px rgba(0,0,0,0.45)'
      : onBeacon ? '0 0 0 2px #4ecdc4, 0 18px 40px rgba(0,0,0,0.45)'
        : '0 18px 40px rgba(0,0,0,0.45)';
  }

  function roundRect(x, y, w, h, r, fill) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y + r, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  /* ---------------------------------------------------------------- старт */

  const cached = store.loadCache();
  if (cached) {
    applySnapshot(cached, cached.youId);
    S.seq = cached.seq || 0;
    toast('Локальное состояние восстановлено (кэш браузера)', 'info');
  }

  ui.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = ui.name.value.trim();
    if (!name) return;
    store.name = name;
    if (!store.token) store.token = '';
    ui.overlay.classList.add('hidden');
    connect();
  });

  ui.changePlayer.addEventListener('click', () => {
    store.token = '';
    store.name = '';
    connected = false;
    if (ws) { try { ws.close(); } catch (err) { /* */ } ws = null; }
    try { localStorage.removeItem('arena.cache'); } catch (err) { /* */ }
    ui.name.value = '';
    ui.overlay.classList.remove('hidden');
    ui.name.focus();
  });

  if (store.name) {
    ui.name.value = store.name;
    ui.overlay.classList.add('hidden');
    connect();
  } else {
    ui.name.focus();
  }

  frame();
})();
