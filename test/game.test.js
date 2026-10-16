'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../src/game');

function makeGame(options = {}) {
  return new Game({ w: 20, h: 16, coinTarget: 5, ...options });
}

function findRacingSpot(game) {
  for (const cell of game.reachableCells) {
    if (game.isBeaconCell(cell.x, cell.y)) continue;
    const a = { x: cell.x - 1, y: cell.y };
    const b = { x: cell.x + 1, y: cell.y };
    const free = (c) => c.x >= 0 && c.y >= 0 && c.x < game.w && c.y < game.h
      && !game.isRock(c.x, c.y) && !game.isBeaconCell(c.x, c.y);
    if (free(a) && free(b)) return { target: cell, a, b };
  }
  throw new Error('не найдено место для теста');
}

test('подключение создаёт игрока, снапшот не раскрывает токены', () => {
  const game = makeGame();
  const player = game.join({ name: 'Алиса' });

  assert.equal(player.name, 'Алиса');
  assert.equal(player.score, 0);
  assert.ok(player.token);

  const snapshot = game.snapshot();
  assert.equal(snapshot.players.length, 1);
  assert.equal(snapshot.players[0].id, player.id);
  assert.equal(snapshot.players[0].token, undefined);
  assert.equal(snapshot.beacon.owner, null);
});

test('повторный вход по токену сохраняет очки и игрока', () => {
  const game = makeGame();
  const first = game.join({ name: 'Боб' });
  first.score = 7;

  const again = game.join({ name: 'Боб', token: first.token });
  assert.equal(again.id, first.id);
  assert.equal(again.score, 7);
  assert.equal(game.players.size, 1);
});

test('конкурентный доступ: двое идут в одну клетку — второй получает конфликт', () => {
  const game = makeGame();
  const a = game.join({ name: 'A' });
  const b = game.join({ name: 'B' });
  game.players.delete(b.id);

  const spot = findRacingSpot(game);
  a.x = spot.a.x; a.y = spot.a.y;
  b.x = spot.b.x; b.y = spot.b.y;
  game.players.set(b.id, b);

  const first = game.move(a, { opId: 'move-a', fx: a.x, fy: a.y, dx: spot.target.x - a.x, dy: 0 });
  const second = game.move(b, { opId: 'move-b', fx: b.x, fy: b.y, dx: spot.target.x - b.x, dy: 0 });

  assert.deepEqual(first, { ok: true });
  assert.equal(a.x, spot.target.x);
  assert.ok(second.conflict);
  assert.equal(second.conflict.kind, 'move');
  assert.match(second.conflict.reason, /занял/);
  assert.equal(b.x, spot.b.x, 'проигравший остаётся на месте');
});

test('конфликт при устаревшей позиции клиента', () => {
  const game = makeGame();
  const a = game.join({ name: 'A' });
  const result = game.move(a, { opId: 'stale', fx: a.x + 5, fy: a.y + 5, dx: 1, dy: 0 });
  assert.ok(result.conflict);
  assert.match(result.conflict.reason, /устарела/);
  assert.equal(result.conflict.player.id, a.id);
});

test('конкурентный сбор монеты: второй клиент получает конфликт', () => {
  const game = makeGame();
  const a = game.join({ name: 'A' });
  const b = game.join({ name: 'B' });

  const cell = game.freeCell({ avoidBeacon: true, avoidCoins: true });
  const coin = { id: 'test-coin', x: cell.x, y: cell.y, version: 1 };
  game.coins = [coin];
  a.x = cell.x; a.y = cell.y;
  b.x = cell.x; b.y = cell.y;

  const first = game.take(a, { opId: 'take-a', coinId: coin.id, baseVersion: 1 });
  const second = game.take(b, { opId: 'take-b', coinId: coin.id, baseVersion: 1 });

  assert.deepEqual(first, { ok: true });
  assert.equal(a.score, 1);
  assert.ok(second.conflict);
  assert.match(second.conflict.reason, /уже забрал/);
  assert.equal(second.conflict.coin, null);
  assert.equal(game.coins.length, 0);
});

test('конкурентный доступ к маяку: побеждает первая операция', () => {
  const game = makeGame();
  const a = game.join({ name: 'A' });
  const b = game.join({ name: 'B' });
  a.x = game.beacon.x; a.y = game.beacon.y;
  b.x = game.beacon.x; b.y = game.beacon.y;

  const first = game.capture(a, { opId: 'cap-a', baseVersion: 1 });
  const second = game.capture(b, { opId: 'cap-b', baseVersion: 1 });

  assert.deepEqual(first, { ok: true });
  assert.equal(game.beacon.owner, a.id);
  assert.equal(a.score, 5);
  assert.ok(second.conflict);
  assert.equal(second.conflict.kind, 'beacon');
  assert.match(second.conflict.reason, /другой игрок/);
  assert.equal(second.conflict.owner.id, a.id);
});

test('на клетке маяка разрешено стоять нескольким игрокам', () => {
  const game = makeGame();
  const a = game.join({ name: 'A' });
  const b = game.join({ name: 'B' });
  a.x = game.beacon.x; a.y = game.beacon.y;

  const neighbour = game.reachableCells.find((c) => Math.abs(c.x - game.beacon.x) + Math.abs(c.y - game.beacon.y) === 1);
  assert.ok(neighbour, 'найдена клетка рядом с маяком');
  b.x = neighbour.x; b.y = neighbour.y;

  const result = game.move(b, {
    opId: 'to-beacon',
    fx: b.x,
    fy: b.y,
    dx: game.beacon.x - b.x,
    dy: game.beacon.y - b.y
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(b.x, game.beacon.x);
  assert.equal(b.y, game.beacon.y);
});

test('идемпотентность: повторная доставка операции не даёт двойного эффекта', () => {
  const game = makeGame();
  const a = game.join({ name: 'A' });
  const cell = game.freeCell({ avoidBeacon: true, avoidCoins: true });
  game.coins = [{ id: 'c1', x: cell.x, y: cell.y, version: 1 }];
  a.x = cell.x; a.y = cell.y;

  assert.deepEqual(game.take(a, { opId: 'same-op', coinId: 'c1', baseVersion: 1 }), { ok: true });
  assert.equal(game.take(a, { opId: 'same-op', coinId: 'c1', baseVersion: 1 }), null);
  assert.equal(a.score, 1);
});

test('сохранение между запусками: сериализация и загрузка состояния', () => {
  const game = makeGame();
  const a = game.join({ name: 'A' });
  const b = game.join({ name: 'B' });
  a.x = game.beacon.x; a.y = game.beacon.y;
  game.capture(a, { opId: 'cap', baseVersion: 1 });
  const coinsBefore = game.coins.length;
  const seqBefore = game.seq;

  const restored = new Game({ deferInit: true });
  assert.equal(restored.load(game.serialize()), true);

  assert.equal(restored.seq, seqBefore);
  assert.equal(restored.beacon.owner, a.id);
  assert.equal(restored.player(a.id).score, 5);
  assert.equal(restored.player(a.id).name, 'A');
  assert.equal(restored.coins.length, coinsBefore);
  assert.equal(restored.players.size, 2);
  assert.equal(restored.player(a.id).online, false, 'после перезапуска все офлайн до переподключения');
  assert.equal(restored.isRock(restored.rocks[0].x, restored.rocks[0].y), true);
});

test('загрузка повреждённых данных отклоняется', () => {
  const game = new Game({ deferInit: true });
  assert.equal(game.load(null), false);
  assert.equal(game.load({ v: 99 }), false);
});

test('восстановление соединения: replay доставленных событий', () => {
  const game = makeGame();
  const a = game.join({ name: 'A' });
  const seqAfterJoin = game.seq;

  const cell = game.freeCell({ avoidBeacon: true, avoidCoins: true });
  game.coins = [{ id: 'c-replay', x: cell.x, y: cell.y, version: 1 }];
  a.x = cell.x; a.y = cell.y;
  game.take(a, { opId: 'take-replay', coinId: 'c-replay', baseVersion: 1 });
  game.disconnect(a.id);
  game.join({ name: 'B' });

  const result = game.resume({ token: a.token, lastSeq: seqAfterJoin });
  assert.equal(result.mode, 'replay');
  assert.ok(result.events.length >= 2);
  assert.ok(result.events.every((e) => e.seq > seqAfterJoin));
  assert.ok(result.events.some((e) => e.k === 'coinTaken'));
  assert.equal(result.player.online, true);
});

test('восстановление соединения: полный снапшот, если события вытеснены', () => {
  const game = makeGame({ maxEvents: 2 });
  const a = game.join({ name: 'A' });
  for (let i = 0; i < 6; i++) game.join({ name: 'P' + i });

  const result = game.resume({ token: a.token, lastSeq: 0 });
  assert.equal(result.mode, 'state');
  assert.ok(result.seq > 0);
});

test('неизвестный токен не восстанавливается', () => {
  const game = makeGame();
  assert.equal(game.resume({ token: 'nope', lastSeq: 0 }), null);
});

test('маяк возвращается в игру после перезапуска вместе с очками', () => {
  const game = makeGame();
  const a = game.join({ name: 'A' });
  a.x = game.beacon.x; a.y = game.beacon.y;
  game.capture(a, { opId: 'cap-restart', baseVersion: 1 });

  const restored = new Game({ deferInit: true });
  restored.load(game.serialize());
  restored.players.get(a.id).online = true;

  assert.equal(restored.snapshot().beacon.owner, a.id);
  assert.equal(restored.snapshot().beacon.version, 2);
});
