'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Game } = require('./src/game');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'game.json');
const SAVE_DEBOUNCE = Number(process.env.SAVE_DEBOUNCE) || 300;
const HEARTBEAT_MS = 5000;
const TICK_MS = 500;
const DEBUG = process.env.ARENA_DEBUG === '1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function readStateFile() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[persist] не удалось прочитать', DATA_FILE, '-', err.message);
    }
    return null;
  }
}

const saved = readStateFile();
const game = new Game({
  deferInit: Boolean(saved),
  onBroadcast: (event) => broadcast({ t: 'ev', ...event }),
  onPersist: () => scheduleSave()
});
if (saved && !game.load(saved)) {
  console.warn('[persist] файл состояния повреждён, создана новая игра');
  game.generate();
}
console.log(saved ? '[persist] состояние загружено из ' + DATA_FILE : '[persist] новое состояние игры');

let saveTimer = null;

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, SAVE_DEBOUNCE);
}

function saveNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(game.serialize()));
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error('[persist] ошибка сохранения:', err.message);
  }
}

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server });
const socketsByPlayer = new Map();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

function bind(ws, player) {
  const previous = socketsByPlayer.get(player.id);
  if (previous && previous !== ws) {
    previous.playerId = null;
    send(previous, { t: 'superseded' });
    previous.close(4000, 'session replaced');
  }
  socketsByPlayer.set(player.id, ws);
  ws.playerId = player.id;
}

function releaseSocket(ws) {
  const id = ws.playerId;
  if (!id) return;
  if (socketsByPlayer.get(id) === ws) {
    socketsByPlayer.delete(id);
    game.disconnect(id);
  }
}

function currentPlayer(ws) {
  return ws.playerId ? game.player(ws.playerId) : null;
}

function sendState(ws, youId) {
  send(ws, { t: 'state', youId, state: game.snapshot() });
}

function handle(ws, msg) {
  switch (msg.t) {
    case 'join': {
      const player = game.join({ name: msg.name, token: typeof msg.token === 'string' ? msg.token : null });
      bind(ws, player);
      send(ws, { t: 'welcome', token: player.token, youId: player.id, state: game.snapshot() });
      break;
    }
    case 'resume': {
      const result = game.resume({
        token: typeof msg.token === 'string' ? msg.token : null,
        lastSeq: Number.isInteger(msg.lastSeq) ? msg.lastSeq : null
      });
      if (!result) {
        send(ws, { t: 'rejoin' });
        break;
      }
      bind(ws, result.player);
      if (result.mode === 'replay') {
        send(ws, {
          t: 'replay',
          youId: result.player.id,
          seq: result.seq,
          you: game.pub(result.player),
          events: result.events
        });
      } else {
        sendState(ws, result.player.id);
      }
      break;
    }
    case 'move':
    case 'take':
    case 'capture': {
      const player = currentPlayer(ws);
      if (!player) {
        send(ws, { t: 'rejoin' });
        break;
      }
      const result = msg.t === 'move' ? game.move(player, msg)
        : msg.t === 'take' ? game.take(player, msg)
          : game.capture(player, msg);
      if (result && result.conflict) send(ws, { t: 'conflict', ...result.conflict });
      break;
    }
    case 'sync': {
      const player = currentPlayer(ws);
      if (player) sendState(ws, player.id);
      else send(ws, { t: 'rejoin' });
      break;
    }
    case 'ping':
      send(ws, { t: 'pong', ts: msg.ts });
      break;
    case 'debug': {
      if (!DEBUG) break;
      handleDebug(msg);
      break;
    }
    default:
      break;
  }
}

function handleDebug(msg) {
  if (msg.action === 'place') {
    const player = game.player(msg.id);
    if (player) {
      player.x = msg.x;
      player.y = msg.y;
      player.version += 1;
      game.emit('moved', { id: player.id, x: player.x, y: player.y, version: player.version });
    }
  } else if (msg.action === 'coin') {
    const coin = { id: msg.id || 'dbg-' + Date.now(), x: msg.x, y: msg.y, version: 1 };
    game.coins = game.coins.filter((c) => !(c.x === coin.x && c.y === coin.y));
    game.coins.push(coin);
    game.emit('coinSpawned', { coin });
  } else if (msg.action === 'reset-coins') {
    game.coins = [];
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.playerId = null;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg = null;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;
    try {
      handle(ws, msg);
    } catch (err) {
      console.error('[ws] ошибка обработки сообщения', msg.t, '-', err.message);
    }
  });

  ws.on('close', () => releaseSocket(ws));
  ws.on('error', () => {});
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

const ticker = setInterval(() => game.tick(Date.now()), TICK_MS);

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[server] остановка (' + signal + '), сохраняю состояние...');
  clearInterval(heartbeat);
  clearInterval(ticker);
  saveNow();
  try {
    for (const ws of wss.clients) ws.close(1001, 'server shutdown');
    wss.close();
    server.close();
  } catch (err) {
    /* ignore */
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', () => saveNow());

server.listen(PORT, HOST, () => {
  console.log('LISTENING ' + server.address().port);
  console.log('[server] арена доступна: http://localhost:' + server.address().port);
});
