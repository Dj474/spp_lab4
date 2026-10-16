'use strict';

const crypto = require('crypto');

const COLORS = [
  '#ff6b6b', '#4ecdc4', '#ffe66d', '#95e1d3', '#f38181', '#aa96da',
  '#fcbad3', '#a8d8ea', '#ff9f43', '#1dd1a1', '#feca57', '#5f27cd'
];

const newId = (prefix, bytes = 5) => prefix + crypto.randomBytes(bytes).toString('hex');

class Game {
  constructor(options = {}) {
    this.w = options.w || 20;
    this.h = options.h || 16;
    this.coinTarget = options.coinTarget != null ? options.coinTarget : 10;
    this.respawnMs = options.respawnMs != null ? options.respawnMs : 1500;
    this.maxEvents = options.maxEvents || 500;
    this.maxOps = options.maxOps || 1000;
    this.onBroadcast = options.onBroadcast || (() => {});
    this.onPersist = options.onPersist || (() => {});
    this.rng = options.rng || Math.random;

    this.seq = 0;
    this.rocks = [];
    this.coins = [];
    this.beacon = { x: (this.w - 1) >> 1, y: (this.h - 1) >> 1, owner: null, version: 1 };
    this.players = new Map();
    this.events = [];
    this.ops = new Set();
    this.opOrder = [];
    this.respawnQueue = [];
    this.reachableCells = [];

    if (!options.deferInit) this.generate();
  }

  generate() {
    let attempt = 0;
    do {
      this.buildRocks();
      this.computeReachable();
      attempt++;
    } while (this.reachableCells.length < this.w * this.h * 0.45 && attempt < 40);
    this.fillCoins();
  }

  buildRocks() {
    const total = Math.floor(this.w * this.h * 0.12);
    const seen = new Set();
    const rocks = [];
    let guard = 0;
    while (rocks.length < total && guard++ < 10000) {
      const x = Math.floor(this.rng() * this.w);
      const y = Math.floor(this.rng() * this.h);
      const key = x + ',' + y;
      if (seen.has(key)) continue;
      if (x === this.beacon.x && y === this.beacon.y) continue;
      if (Math.abs(x - this.beacon.x) + Math.abs(y - this.beacon.y) < 2) continue;
      seen.add(key);
      rocks.push({ x, y });
    }
    this.rocks = rocks;
  }

  computeReachable() {
    const rockSet = new Set(this.rocks.map((r) => r.x + ',' + r.y));
    const start = this.beacon.x + ',' + this.beacon.y;
    const visited = new Set([start]);
    const queue = [{ x: this.beacon.x, y: this.beacon.y }];
    const cells = [];
    while (queue.length) {
      const cell = queue.shift();
      cells.push(cell);
      const neighbours = [
        { x: cell.x + 1, y: cell.y },
        { x: cell.x - 1, y: cell.y },
        { x: cell.x, y: cell.y + 1 },
        { x: cell.x, y: cell.y - 1 }
      ];
      for (const n of neighbours) {
        if (n.x < 0 || n.y < 0 || n.x >= this.w || n.y >= this.h) continue;
        const key = n.x + ',' + n.y;
        if (visited.has(key) || rockSet.has(key)) continue;
        visited.add(key);
        queue.push(n);
      }
    }
    this.reachableCells = cells;
  }

  isRock(x, y) {
    return this.rocks.some((r) => r.x === x && r.y === y);
  }

  playerAt(x, y, excludeId = null) {
    for (const p of this.players.values()) {
      if (p.id !== excludeId && p.x === x && p.y === y) return p;
    }
    return null;
  }

  isBeaconCell(x, y) {
    return x === this.beacon.x && y === this.beacon.y;
  }

  freeCell(options = {}) {
    const pool = [];
    for (const cell of this.reachableCells) {
      if (options.avoidBeacon !== false && this.isBeaconCell(cell.x, cell.y)) continue;
      if (options.avoidCoins && this.coins.some((c) => c.x === cell.x && c.y === cell.y)) continue;
      if (options.avoidPlayers && this.playerAt(cell.x, cell.y)) continue;
      pool.push(cell);
    }
    if (!pool.length) return null;
    return pool[Math.floor(this.rng() * pool.length)];
  }

  fillCoins() {
    while (this.coins.length < this.coinTarget) {
      const cell = this.freeCell({ avoidBeacon: true, avoidCoins: true });
      if (!cell) break;
      this.coins.push({ id: newId('c'), x: cell.x, y: cell.y, version: 1 });
    }
  }

  pickColor() {
    const used = new Map();
    for (const p of this.players.values()) used.set(p.color, (used.get(p.color) || 0) + 1);
    let best = COLORS[0];
    let bestCount = Infinity;
    for (const color of COLORS) {
      const count = used.get(color) || 0;
      if (count < bestCount) {
        bestCount = count;
        best = color;
      }
      if (count === 0) break;
    }
    return best;
  }

  cleanName(name) {
    if (typeof name !== 'string') return '';
    return name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16);
  }

  byToken(token) {
    if (!token) return null;
    for (const p of this.players.values()) if (p.token === token) return p;
    return null;
  }

  player(id) {
    return this.players.get(id) || null;
  }

  pub(p) {
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      x: p.x,
      y: p.y,
      score: p.score,
      version: p.version,
      online: p.online
    };
  }

  snapshot() {
    return {
      seq: this.seq,
      w: this.w,
      h: this.h,
      rocks: this.rocks,
      coins: this.coins,
      beacon: this.beacon,
      players: Array.from(this.players.values()).map((p) => this.pub(p))
    };
  }

  emit(kind, data = {}) {
    this.seq += 1;
    const event = Object.assign({ seq: this.seq, k: kind }, data);
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    this.onBroadcast(event);
    return event;
  }

  rememberOp(opId) {
    if (!opId) return false;
    if (this.ops.has(opId)) return true;
    this.ops.add(opId);
    this.opOrder.push(opId);
    if (this.opOrder.length > this.maxOps) {
      const old = this.opOrder.shift();
      this.ops.delete(old);
    }
    return false;
  }

  join({ name, token } = {}) {
    const clean = this.cleanName(name);
    let p = this.byToken(token);
    let created = false;
    if (!p) {
      created = true;
      const cell = this.freeCell({ avoidBeacon: true, avoidCoins: true, avoidPlayers: true })
        || this.freeCell({ avoidBeacon: true, avoidPlayers: true })
        || { x: this.beacon.x, y: this.beacon.y };
      p = {
        id: newId('p', 8),
        token: token || newId('t', 16),
        name: clean || 'Игрок',
        color: this.pickColor(),
        x: cell.x,
        y: cell.y,
        score: 0,
        version: 1,
        online: true,
        joinedAt: Date.now()
      };
      this.players.set(p.id, p);
    }
    p.online = true;
    if (clean) p.name = clean;
    this.emit('player', { p: this.pub(p) });
    this.onPersist();
    return Object.assign(p, { created });
  }

  resume({ token, lastSeq } = {}) {
    const p = this.byToken(token);
    if (!p) return null;
    p.online = true;
    this.emit('player', { p: this.pub(p) });
    this.onPersist();

    const minSeq = this.events.length ? this.events[0].seq : this.seq + 1;
    const canReplay = Number.isInteger(lastSeq) && lastSeq >= minSeq - 1 && lastSeq <= this.seq;
    if (canReplay) {
      return {
        mode: 'replay',
        player: p,
        seq: this.seq,
        events: this.events.filter((e) => e.seq > lastSeq)
      };
    }
    return { mode: 'state', player: p, seq: this.seq };
  }

  disconnect(id) {
    const p = this.players.get(id);
    if (!p || !p.online) return null;
    p.online = false;
    this.emit('player', { p: this.pub(p) });
    this.onPersist();
    return p;
  }

  move(p, { opId, fx, fy, dx, dy } = {}) {
    if (this.rememberOp(opId)) return null;
    const conflict = (reason, extra) => ({ conflict: Object.assign({ opId, kind: 'move', reason }, extra) });

    const sx = Math.sign(Number(dx) || 0);
    const sy = Math.sign(Number(dy) || 0);
    if (!sx && !sy) return conflict('Некорректное перемещение');
    if (sx && sy) return conflict('Движение только по одной оси');

    if (p.x !== fx || p.y !== fy) {
      return conflict('Операция устарела: позиция изменилась на сервере', { player: this.pub(p) });
    }
    const nx = fx + sx;
    const ny = fy + sy;
    if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) return conflict('Упёрлись в границу арены');
    if (this.isRock(nx, ny)) return conflict('На пути препятствие');

    const occupant = this.playerAt(nx, ny, p.id);
    if (occupant && !this.isBeaconCell(nx, ny)) {
      return conflict('Клетку занял ' + occupant.name, { player: this.pub(occupant) });
    }

    p.x = nx;
    p.y = ny;
    p.version += 1;
    this.emit('moved', { id: p.id, x: nx, y: ny, version: p.version, op: opId });
    this.onPersist();
    return { ok: true };
  }

  take(p, { opId, coinId, baseVersion } = {}) {
    if (this.rememberOp(opId)) return null;
    const conflict = (reason, coin) => ({
      conflict: { opId, kind: 'coin', reason, coinId, coin: coin ? Object.assign({}, coin) : null }
    });

    const coin = this.coins.find((c) => c.id === coinId);
    if (!coin) return conflict('Монету уже забрал другой игрок', null);
    if (coin.version !== baseVersion) return conflict('Состояние монеты устарело', coin);
    if (p.x !== coin.x || p.y !== coin.y) return conflict('Подойдите вплотную к монете', coin);

    this.coins = this.coins.filter((c) => c.id !== coinId);
    p.score += 1;
    p.version += 1;
    this.emit('coinTaken', { coinId, by: p.id, score: p.score, op: opId });
    this.respawnQueue.push({ at: Date.now() + this.respawnMs });
    this.onPersist();
    return { ok: true };
  }

  capture(p, { opId, baseVersion } = {}) {
    if (this.rememberOp(opId)) return null;
    const conflict = (reason) => ({
      conflict: {
        opId,
        kind: 'beacon',
        reason,
        beacon: Object.assign({}, this.beacon),
        owner: this.beacon.owner ? this.pub(this.players.get(this.beacon.owner)) : null
      }
    });

    if (!this.isBeaconCell(p.x, p.y)) return conflict('Нужно встать на маяк');
    if (p.id === this.beacon.owner) return conflict('Маяк уже под вашим контролем');
    if (this.beacon.version !== baseVersion) return conflict('Маяк уже захватил другой игрок');

    this.beacon.owner = p.id;
    this.beacon.version += 1;
    p.score += 5;
    p.version += 1;
    this.emit('beacon', {
      beacon: Object.assign({}, this.beacon),
      by: p.id,
      score: p.score,
      op: opId
    });
    this.onPersist();
    return { ok: true };
  }

  tick(now = Date.now()) {
    let changed = false;
    for (let i = this.respawnQueue.length - 1; i >= 0; i--) {
      const job = this.respawnQueue[i];
      if (job.at > now) continue;
      this.respawnQueue.splice(i, 1);
      const cell = this.freeCell({ avoidBeacon: true, avoidCoins: true });
      if (cell) {
        const coin = { id: newId('c'), x: cell.x, y: cell.y, version: 1 };
        this.coins.push(coin);
        this.emit('coinSpawned', { coin });
        changed = true;
      } else {
        this.respawnQueue.push({ at: now + this.respawnMs });
      }
    }
    if (this.coins.length + this.respawnQueue.length < this.coinTarget) {
      this.respawnQueue.push({ at: now + this.respawnMs });
    }
    if (changed) this.onPersist();
  }

  serialize() {
    return {
      v: 1,
      seq: this.seq,
      w: this.w,
      h: this.h,
      coinTarget: this.coinTarget,
      respawnMs: this.respawnMs,
      rocks: this.rocks,
      coins: this.coins,
      beacon: this.beacon,
      respawnQueue: this.respawnQueue,
      players: Array.from(this.players.values()).map((p) => ({
        id: p.id,
        token: p.token,
        name: p.name,
        color: p.color,
        x: p.x,
        y: p.y,
        score: p.score,
        version: p.version,
        joinedAt: p.joinedAt
      })),
      savedAt: Date.now()
    };
  }

  load(data) {
    if (!data || data.v !== 1 || !Array.isArray(data.players)) return false;
    this.w = data.w || this.w;
    this.h = data.h || this.h;
    this.coinTarget = data.coinTarget || this.coinTarget;
    this.respawnMs = data.respawnMs || this.respawnMs;
    this.seq = data.seq || 0;
    this.rocks = data.rocks || [];
    this.coins = data.coins || [];
    this.respawnQueue = data.respawnQueue || [];
    this.beacon = data.beacon || { x: (this.w - 1) >> 1, y: (this.h - 1) >> 1, owner: null, version: 1 };
    this.players = new Map();
    for (const raw of data.players) {
      this.players.set(raw.id, {
        id: raw.id,
        token: raw.token,
        name: raw.name,
        color: raw.color,
        x: raw.x,
        y: raw.y,
        score: raw.score || 0,
        version: raw.version || 1,
        online: false,
        joinedAt: raw.joinedAt || Date.now()
      });
    }
    this.events = [];
    this.ops = new Set();
    this.opOrder = [];
    this.computeReachable();
    this.fillCoins();
    return true;
  }
}

module.exports = { Game, COLORS };
