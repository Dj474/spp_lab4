'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');

const SERVER = path.join(__dirname, '..', 'server.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arena-test-'));
}

function startServer(dataDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER], {
      env: Object.assign({}, process.env, {
        PORT: '0',
        HOST: '127.0.0.1',
        DATA_DIR: dataDir,
        ARENA_DEBUG: '1',
        SAVE_DEBOUNCE: '30'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) reject(new Error('сервер не стартовал:\n' + out));
    }, 15000);
    proc.stdout.on('data', (buf) => {
      out += buf.toString();
      const m = out.match(/LISTENING (\d+)/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ proc, port: Number(m[1]), log: () => out });
      }
    });
    proc.stderr.on('data', (buf) => { out += buf.toString(); });
    proc.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('сервер завершился с кодом ' + code + ':\n' + out));
      }
    });
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on('error', reject);
  });
}

function connectClient(port) {
  const ws = new WebSocket('ws://127.0.0.1:' + port);
  const messages = [];
  const waiters = [];

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    messages.push(msg);
    for (const waiter of waiters.slice()) {
      if (waiter.from <= messages.length - 1 && waiter.pred(msg)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      }
    }
  });

  return {
    ws,
    messages,
    open: () => new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    }),
    send: (msg) => ws.send(JSON.stringify(msg)),
    waitFor(pred, timeout = 5000, from = 0) {
      const index = messages.findIndex((m, i) => i >= from && pred(m));
      if (index >= 0) return Promise.resolve(messages[index]);
      return new Promise((resolve, reject) => {
        const waiter = {
          pred,
          from,
          resolve,
          timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            reject(new Error('таймаут ожидания сообщения'));
          }, timeout)
        };
        waiters.push(waiter);
      });
    },
    mark: () => messages.length,
    close: () => new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      ws.once('close', resolve);
      ws.close();
    })
  };
}

function findCorridor(state) {
  const rocks = new Set(state.rocks.map((r) => r.x + ',' + r.y));
  for (let y = 0; y < state.h; y++) {
    for (let x = 0; x < state.w - 1; x++) {
      const a = x + ',' + y;
      const b = (x + 1) + ',' + y;
      const isBeacon = (x === state.beacon.x && y === state.beacon.y) || (x + 1 === state.beacon.x && y === state.beacon.y);
      if (!rocks.has(a) && !rocks.has(b) && !isBeacon) return { x, y };
    }
  }
  throw new Error('не найден свободный коридор');
}

async function joinClient(port, name) {
  const client = connectClient(port);
  await client.open();
  client.send({ t: 'join', name });
  const welcome = await client.waitFor((m) => m.t === 'welcome');
  client.youId = welcome.youId;
  client.token = welcome.token;
  return client;
}

test('реальное время, конфликты и переподключение (интеграция)', async (t) => {
  const dir = tmpDir();
  const server = await startServer(dir);
  t.after(() => {
    server.proc.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('HTTP-сервер отдаёт клиентское приложение', async () => {
    const res = await httpGet('http://127.0.0.1:' + server.port + '/');
    assert.equal(res.status, 200);
    assert.match(res.body, /<canvas id="game"/);
    const js = await httpGet('http://127.0.0.1:' + server.port + '/game.js');
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /javascript/);
  });

  const alice = await joinClient(server.port, 'Алиса');
  const bob = await joinClient(server.port, 'Боб');
  t.after(() => Promise.all([alice.close(), bob.close()]));

  await t.test('подключение игрока мгновенно видно остальным', async () => {
    const ev = await alice.waitFor((m) => m.t === 'ev' && m.k === 'player' && m.p.id === bob.youId);
    assert.equal(ev.p.name, 'Боб');
    assert.equal(ev.p.online, true);
  });

  await t.test('перемещение синхронизируется по WebSocket', async () => {
    alice.send({ t: 'sync' });
    const snapshot = await alice.waitFor((m) => m.t === 'state');
    const spot = findCorridor(snapshot.state);

    alice.send({ t: 'debug', action: 'place', id: alice.youId, x: spot.x, y: spot.y });
    await alice.waitFor((m) => m.t === 'ev' && m.k === 'moved' && m.id === alice.youId && m.x === spot.x);

    alice.send({ t: 'move', opId: 'move-1', fx: spot.x, fy: spot.y, dx: 1, dy: 0 });

    const moved = await bob.waitFor(
      (m) => m.t === 'ev' && m.k === 'moved' && m.id === alice.youId && m.op === 'move-1',
      2000
    );
    assert.equal(moved.x, spot.x + 1);
    assert.equal(moved.y, spot.y);
  });

  await t.test('конкурентный сбор одной монеты: второму отказано (конфликт)', async () => {
    alice.send({ t: 'debug', action: 'place', id: alice.youId, x: 1, y: 1 });
    await alice.waitFor((m) => m.t === 'ev' && m.k === 'moved' && m.id === alice.youId && m.x === 1);
    alice.send({ t: 'debug', action: 'coin', id: 'coin-x', x: 1, y: 1 });
    await alice.waitFor((m) => m.t === 'ev' && m.k === 'coinSpawned' && m.coin.id === 'coin-x');

    alice.send({ t: 'take', opId: 'take-a', coinId: 'coin-x', baseVersion: 1 });
    const taken = await alice.waitFor((m) => m.t === 'ev' && m.k === 'coinTaken' && m.coinId === 'coin-x');
    assert.equal(taken.by, alice.youId);
    assert.equal(taken.score, 1);

    bob.send({ t: 'take', opId: 'take-b', coinId: 'coin-x', baseVersion: 1 });
    const conflict = await bob.waitFor((m) => m.t === 'conflict' && m.kind === 'coin');
    assert.match(conflict.reason, /уже забрал/);
    assert.equal(conflict.coin, null);
  });

  await t.test('устаревшая версия элемента: сервер отклоняет правку', async () => {
    alice.send({ t: 'debug', action: 'coin', id: 'coin-y', x: 1, y: 1 });
    await alice.waitFor((m) => m.t === 'ev' && m.k === 'coinSpawned' && m.coin.id === 'coin-y');
    alice.send({ t: 'take', opId: 'take-stale', coinId: 'coin-y', baseVersion: 99 });
    const conflict = await alice.waitFor((m) => m.t === 'conflict' && m.kind === 'coin');
    assert.match(conflict.reason, /устарело/);
    assert.equal(conflict.coin.id, 'coin-y');
  });

  await t.test('одновременный захват маяка: побеждает только один', async () => {
    const snapshot = alice.messages.find((m) => m.t === 'state');
    const beacon = snapshot.state.beacon;
    alice.send({ t: 'debug', action: 'place', id: alice.youId, x: beacon.x, y: beacon.y });
    bob.send({ t: 'debug', action: 'place', id: bob.youId, x: beacon.x, y: beacon.y });
    await Promise.all([
      alice.waitFor((m) => m.t === 'ev' && m.k === 'moved' && m.id === alice.youId && m.x === beacon.x),
      bob.waitFor((m) => m.t === 'ev' && m.k === 'moved' && m.id === bob.youId && m.x === beacon.x)
    ]);

    alice.send({ t: 'capture', opId: 'cap-a', baseVersion: beacon.version });
    const capture = await alice.waitFor((m) => m.t === 'ev' && m.k === 'beacon');
    assert.equal(capture.beacon.owner, alice.youId);

    bob.send({ t: 'capture', opId: 'cap-b', baseVersion: beacon.version });
    const conflict = await bob.waitFor((m) => m.t === 'conflict' && m.kind === 'beacon');
    assert.match(conflict.reason, /другой игрок/);
    assert.equal(conflict.beacon.owner, alice.youId);
  });

  await t.test('потеря соединения видна другим, состояние восстанавливается', async () => {
    bob.send({ t: 'take', opId: 'bob-coin', coinId: 'no-such', baseVersion: 1 });
    const bobConflict = await bob.waitFor((m) => m.t === 'conflict' && m.kind === 'coin');
    assert.ok(bobConflict);

    const marker = alice.mark();
    await bob.close();
    const offline = await alice.waitFor(
      (m) => m.t === 'ev' && m.k === 'player' && m.p.id === bob.youId && m.p.online === false,
      4000,
      marker
    );
    assert.equal(offline.p.online, false);

    const resurrected = connectClient(server.port);
    await resurrected.open();
    resurrected.send({ t: 'resume', token: bob.token, lastSeq: 0 });
    const restored = await resurrected.waitFor((m) => m.t === 'replay' || m.t === 'state');
    const restoredState = restored.t === 'state' ? restored.state : null;
    assert.equal(restored.youId, bob.youId);
    if (restoredState) {
      const bobState = restoredState.players.find((p) => p.id === bob.youId);
      assert.equal(bobState.online, true);
    }
    resurrected.close();
  });
});

test('данные игры сохраняются между запусками приложения', async (t) => {
  const dir = tmpDir();
  let server = await startServer(dir);
  const alice = await joinClient(server.port, 'Алиса');

  alice.send({ t: 'sync' });
  const snapshot = await alice.waitFor((m) => m.t === 'state');
  const beacon = snapshot.state.beacon;
  const expectedCoins = snapshot.state.coins.length;

  alice.send({ t: 'debug', action: 'place', id: alice.youId, x: beacon.x, y: beacon.y });
  await alice.waitFor((m) => m.t === 'ev' && m.k === 'moved' && m.id === alice.youId && m.x === beacon.x);
  alice.send({ t: 'capture', opId: 'cap-persist', baseVersion: beacon.version });
  const capture = await alice.waitFor((m) => m.t === 'ev' && m.k === 'beacon');
  assert.equal(capture.score, 5);
  const token = alice.token;

  await new Promise((resolve) => setTimeout(resolve, 400));
  await alice.close();
  server.proc.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));

  const stateFile = path.join(dir, 'game.json');
  assert.equal(fs.existsSync(stateFile), true, 'файл состояния создан');

  server = await startServer(dir);
  t.after(() => {
    server.proc.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const revived = connectClient(server.port);
  await revived.open();
  revived.send({ t: 'resume', token, lastSeq: 0 });
  const restored = await revived.waitFor((m) => m.t === 'replay' || m.t === 'state');
  assert.equal(restored.t, 'state', 'после перезапуска события недоступны — высылается снапшот');

  const savedAlice = restored.state.players.find((p) => p.id === alice.youId);
  assert.equal(savedAlice.score, 5, 'очки сохранены между запусками');
  assert.equal(restored.state.beacon.owner, alice.youId, 'владелец маяка сохранён');
  assert.equal(restored.state.coins.length, expectedCoins, 'монеты сохранены');
  assert.equal(restored.state.players.length, 1);
  revived.close();
});
